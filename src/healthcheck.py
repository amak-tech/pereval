#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Активный мониторинг воркеров и автоматический failover для «Перевала».

Демон работает на основном узле (Primary) без сторонних зависимостей (только
стандартная библиотека Python 3) и каждые --interval секунд проверяет каждый
воркер из cluster-nodes.json по двум каналам:
  1. TCP/443 — отправка TLS ClientHello с расширением SNI и проверка ответа
     ServerHello (0x16 0x03 ...), что подтверждает работоспособность nginx stream
     и маршрутизации ssl_preread.
  2. TCP/80  — HTTP-запрос GET /healthz и проверка ответа HTTP 200.

Для защиты от дребезга (flapping) используется гистерезис:
  * Воркер помечается недоступным (DOWN) после --fail-threshold подряд неудачных проверок.
  * Воркер возвращается в пул (UP) после --rise-threshold подряд успешных проверок.

Перезапись /etc/dnsmasq.conf и /etc/nginx/geoblock/nginx-workers-*.conf, а также
перезапуск dnsmasq и плавный reload nginx выполняются ТОЛЬКО при фактическом
изменении состава живых воркеров. Если все воркеры недоступны, включается режим
fail-open: DNS начинает возвращать IP основного узла (primary), а nginx на
основном узле переключается на прямое разрешение origin-доменов.
"""

import argparse
import asyncio
from collections import OrderedDict
import json
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import sys
import time

ADDRESS_LINE_RE = re.compile(r'^(\s*#?\s*address=/([^/\s]+)/)([^\s#]+)(.*)$')


def atomic_write_text(path: Path, content: str) -> None:
    """Атомарно записывает текстовый файл через временный файл в том же каталоге."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.tmp.{os.getpid()}"
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def build_tls_client_hello(server_name: str) -> bytes:
    """Формирует минимальный корректный пакет TLS 1.2 ClientHello с SNI."""
    sni_bytes = server_name.encode("idna")
    # SNI extension (0x0000)
    sni_entry = struct.pack("!BH", 0, len(sni_bytes)) + sni_bytes
    sni_list = struct.pack("!H", len(sni_entry)) + sni_entry
    ext_sni = struct.pack("!HH", 0x0000, len(sni_list)) + sni_list

    # supported_groups (0x000a) & ec_point_formats (0x000b) для совместимости с OpenSSL / BoringSSL
    groups = struct.pack("!HHHH", 6, 0x001D, 0x0017, 0x0018)
    ext_groups = struct.pack("!HH", 0x000A, len(groups)) + groups
    ec_formats = b"\x01\x00"
    ext_ec = struct.pack("!HH", 0x000B, len(ec_formats)) + ec_formats

    # signature_algorithms (0x000d)
    sig_algs = struct.pack("!HHHHH", 8, 0x0403, 0x0804, 0x0401, 0x0503)
    ext_sig = struct.pack("!HH", 0x000D, len(sig_algs)) + sig_algs

    extensions = ext_sni + ext_groups + ext_ec + ext_sig
    ext_block = struct.pack("!H", len(extensions)) + extensions

    client_version = b"\x03\x03"  # TLS 1.2
    random_bytes = os.urandom(32)
    session_id = b"\x00"
    cipher_suites = struct.pack(
        "!HHHHHHH",
        12,
        0xC02F,  # TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        0xC02B,  # TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        0xC030,  # TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
        0xC02C,  # TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        0xCCA8,  # TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
        0xCCA9,  # TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
    )
    compression = b"\x01\x00"

    hello_body = (
        client_version
        + random_bytes
        + session_id
        + cipher_suites
        + compression
        + ext_block
    )
    handshake = b"\x01" + struct.pack("!I", len(hello_body))[1:] + hello_body
    record = b"\x16\x03\x01" + struct.pack("!H", len(handshake)) + handshake
    return record


async def _probe_tls_sni_once(ip: str, port: int, sni: str, timeout: float):
    """Отправляет одиночный TLS ClientHello с указанным SNI и проверяет ответ ServerHello."""
    t0 = time.monotonic()
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=timeout
        )
        writer.write(build_tls_client_hello(sni))
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        header = await asyncio.wait_for(reader.read(5), timeout=timeout)
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        if len(header) < 5:
            return False, elapsed_ms, f"short TLS response ({len(header)} bytes)"
        # 0x16 = Handshake (ServerHello)
        if header[0] == 0x16 and header[1] == 0x03:
            return True, elapsed_ms, None
        return False, elapsed_ms, f"unexpected TLS record header: {header[:2].hex()}"
    except Exception as exc:
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        return False, elapsed_ms, f"tls_probe_error: {type(exc).__name__}: {exc}"
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


async def probe_tls_sni(ip: str, port: int, sni: str, timeout: float, fallback_sni: str = None):
    """Проверяет TCP/443 отправкой TLS ClientHello с указанным SNI (и fallback на локальный домен)."""
    ok, elapsed_ms, err = await _probe_tls_sni_once(ip, port, sni, timeout)
    if ok or not fallback_sni or fallback_sni == sni:
        return ok, elapsed_ms, err
    fb_ok, fb_ms, _fb_err = await _probe_tls_sni_once(ip, port, fallback_sni, timeout)
    if fb_ok:
        return True, fb_ms, None
    return ok, elapsed_ms, err


async def probe_http_healthz(ip: str, port: int, host: str, timeout: float):
    """Проверяет TCP/80 GET /healthz."""
    t0 = time.monotonic()
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=timeout
        )
        req = (
            f"GET /healthz HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"User-Agent: pereval-healthcheck/1.0\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("ascii", errors="ignore")
        writer.write(req)
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        raw = await asyncio.wait_for(reader.read(512), timeout=timeout)
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        if not raw:
            return False, elapsed_ms, "empty HTTP response"
        first_line = raw.split(b"\r\n", 1)[0].decode("latin1", errors="replace")
        parts = first_line.split()
        if len(parts) >= 2 and parts[0].startswith("HTTP/") and parts[1] == "200":
            return True, elapsed_ms, None
        return False, elapsed_ms, f"unexpected HTTP status: {first_line}"
    except Exception as exc:
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        return False, elapsed_ms, f"http_probe_error: {type(exc).__name__}: {exc}"
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


def render_dnsmasq_conf(template_text: str, dns_ips: list) -> str:
    """Пересобирает конфиг dnsmasq с указанным списком IP-адресов для всех доменов."""
    if not dns_ips:
        raise ValueError("dns_ips must not be empty")
    n_ips = len(dns_ips)
    out = []
    active_idx = 0
    disabled_idx = 0
    last_active_domain = None
    last_disabled_domain = None

    for line in template_text.splitlines():
        m = ADDRESS_LINE_RE.match(line)
        if not m:
            last_active_domain = None
            last_disabled_domain = None
            out.append(line)
            continue

        prefix, domain, _old_ip, suffix = m.groups()
        is_commented = prefix.lstrip().startswith("#")
        if is_commented:
            if domain == last_disabled_domain:
                continue
            last_disabled_domain = domain
            last_active_domain = None
            rot = disabled_idx % n_ips
            for ip in dns_ips[rot:] + dns_ips[:rot]:
                out.append(f"{prefix}{ip}{suffix}")
            disabled_idx += 1
        else:
            if domain == last_active_domain:
                continue
            last_active_domain = domain
            last_disabled_domain = None
            rot = active_idx % n_ips
            for ip in dns_ips[rot:] + dns_ips[:rot]:
                out.append(f"{prefix}{ip}{suffix}")
            active_idx += 1

    return "\n".join(out) + "\n"


def render_nginx_stream_workers(healthy_workers: list, tls_port: int = 443) -> str:
    """Формирует содержимое nginx-workers-stream.conf."""
    header = (
        "# -----------------------------------------------------------------------------\n"
        "# АВТОМАТИЧЕСКИ ОБНОВЛЕНО healthcheck.py — не правьте вручную.\n"
        "# -----------------------------------------------------------------------------\n\n"
    )
    if not healthy_workers:
        return header + "\n".join([
            "map $sni_allow_target $sni_upstream {",
            "    default           $sni_allow_target;",
            '    "__WORKERS__"     $ssl_preread_server_name:443;',
            "}",
            "",
        ])
    lines = [
        "upstream pereval_stream_workers {",
        "    least_conn;",
    ]
    for w in healthy_workers:
        weight = int(w.get("weight") or 1)
        lines.append(f"    server {w['ip']}:{tls_port} weight={weight} max_fails=2 fail_timeout=10s;")
    lines.extend([
        "}",
        "",
        "map $sni_allow_target $sni_upstream {",
        '    "127.0.0.1:9"     127.0.0.1:9;',
        '    "127.0.0.1:8443"  127.0.0.1:8443;',
        "    default           pereval_stream_workers;",
        '    "__WORKERS__"     pereval_stream_workers;',
        "}",
        "",
    ])
    return header + "\n".join(lines)


def render_nginx_http_workers(healthy_workers: list, http_port: int = 80) -> str:
    """Формирует содержимое nginx-workers-http.conf."""
    header = (
        "# -----------------------------------------------------------------------------\n"
        "# АВТОМАТИЧЕСКИ ОБНОВЛЕНО healthcheck.py — не правьте вручную.\n"
        "# -----------------------------------------------------------------------------\n\n"
    )
    if not healthy_workers:
        return header + "\n".join([
            "map $http_allow_target $http_upstream {",
            "    default           $http_allow_target;",
            '    "__WORKERS__"     $host;',
            "}",
            "",
        ])
    lines = [
        "upstream pereval_http_workers {",
        "    least_conn;",
    ]
    for w in healthy_workers:
        weight = int(w.get("weight") or 1)
        lines.append(f"    server {w['ip']}:{http_port} weight={weight} max_fails=2 fail_timeout=10s;")
    lines.extend([
        "    keepalive 32;",
        "}",
        "",
        "map $http_allow_target $http_upstream {",
        '    ""                "";',
        "    default           pereval_http_workers;",
        '    "__WORKERS__"     pereval_http_workers;',
        "}",
        "",
    ])
    return header + "\n".join(lines)


def load_state(state_file: Path) -> dict:
    if not state_file or not state_file.is_file():
        return {}
    try:
        return json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state_file: Path, state: dict) -> None:
    if not state_file:
        return
    try:
        atomic_write_text(state_file, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    except Exception as exc:
        print(f"[healthcheck] warning: failed to save state to {state_file}: {exc}", file=sys.stderr)


def apply_configs_and_reload(
    dnsmasq_template: Path,
    dnsmasq_out: Path,
    nginx_stream_out: Path,
    nginx_http_out: Path,
    active_dns_ips: list,
    healthy_workers: list,
    tls_port: int,
    http_port: int,
    no_service_reload: bool,
    allow_dnsmasq_restart: bool,
) -> tuple:
    """Атомарно обновляет конфиги dnsmasq и nginx, проверяет их и перезагружает сервисы."""
    dns_updated = False
    nginx_updated = False

    # 1. Обновление nginx worker upstreams
    stream_content = render_nginx_stream_workers(healthy_workers, tls_port=tls_port)
    http_content = render_nginx_http_workers(healthy_workers, http_port=http_port)

    prev_stream = nginx_stream_out.read_text(encoding="utf-8") if nginx_stream_out.is_file() else None
    prev_http = nginx_http_out.read_text(encoding="utf-8") if nginx_http_out.is_file() else None

    if prev_stream != stream_content or prev_http != http_content:
        atomic_write_text(nginx_stream_out, stream_content)
        atomic_write_text(nginx_http_out, http_content)
        nginx_updated = True
        if not no_service_reload and shutil.which("nginx"):
            test_res = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
            if test_res.returncode != 0:
                print(f"[healthcheck] nginx -t failed, rolling back worker configs: {test_res.stderr}",
                      file=sys.stderr)
                if prev_stream is not None:
                    atomic_write_text(nginx_stream_out, prev_stream)
                if prev_http is not None:
                    atomic_write_text(nginx_http_out, prev_http)
                nginx_updated = False
            elif shutil.which("systemctl"):
                subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True)

    # 2. Обновление dnsmasq.conf
    if dnsmasq_template.is_file() and allow_dnsmasq_restart:
        tpl_text = dnsmasq_template.read_text(encoding="utf-8")
        new_dns_conf = render_dnsmasq_conf(tpl_text, active_dns_ips)
        prev_dns = dnsmasq_out.read_text(encoding="utf-8") if dnsmasq_out.is_file() else None
        if prev_dns != new_dns_conf:
            dnsmasq_out.parent.mkdir(parents=True, exist_ok=True)
            tmp_dns = dnsmasq_out.parent / f".{dnsmasq_out.name}.tmp.{os.getpid()}"
            tmp_dns.write_text(new_dns_conf, encoding="utf-8")
            dns_valid = True
            if not no_service_reload and shutil.which("dnsmasq"):
                test_res = subprocess.run(
                    ["dnsmasq", "--test", "-C", str(tmp_dns)],
                    capture_output=True,
                    text=True,
                )
                if test_res.returncode != 0:
                    print(f"[healthcheck] dnsmasq --test failed: {test_res.stderr}", file=sys.stderr)
                    tmp_dns.unlink(missing_ok=True)
                    dns_valid = False
            if dns_valid:
                tmp_dns.replace(dnsmasq_out)
                dns_updated = True
                if not no_service_reload and shutil.which("systemctl"):
                    subprocess.run(["systemctl", "restart", "dnsmasq"], capture_output=True, text=True)

    return dns_updated, nginx_updated


async def run_cycle(args, state: dict) -> dict:
    """Выполняет один цикл опроса всех воркеров и синхронизирует конфиги при смене состояния."""
    if not args.cluster_config.is_file():
        raise FileNotFoundError(f"cluster config not found: {args.cluster_config}")

    cluster = json.loads(args.cluster_config.read_text(encoding="utf-8"))
    primary_ip = cluster.get("primary") or "153.80.200.170"
    domain = cluster.get("domain") or "pereval.portbuddy.tech"
    include_primary_in_dns = bool(cluster.get("include_primary_in_dns", False))
    probe_sni = cluster.get("probe_sni") or domain
    raw_workers = [
        w for w in (cluster.get("workers") or [])
        if isinstance(w, dict) and w.get("ip") and w.get("ip") != primary_ip
    ]

    now_ts = int(time.time())
    worker_states = state.setdefault("workers", {})

    async def check_one(w):
        ip = w["ip"]
        tls_ok, tls_ms, tls_err = await probe_tls_sni(
            ip, args.tls_port, probe_sni, args.timeout, fallback_sni=domain
        )
        http_ok, http_ms, http_err = await probe_http_healthz(
            ip, args.http_port, domain, args.timeout
        )
        return ip, tls_ok, tls_ms, tls_err, http_ok, http_ms, http_err

    results = await asyncio.gather(*(check_one(w) for w in raw_workers))
    results_by_ip = {r[0]: r[1:] for r in results}

    healthy_workers = []
    status_workers = []

    for idx, w in enumerate(raw_workers, 1):
        ip = w["ip"]
        name = w.get("name") or f"worker-{idx}"
        weight = int(w.get("weight") or 1)
        wstate = worker_states.setdefault(ip, {
            "healthy": True,
            "consecutive_failures": 0,
            "consecutive_successes": 0,
            "last_transition_ts": now_ts,
        })

        tls_ok, tls_ms, tls_err, http_ok, http_ms, http_err = results_by_ip[ip]
        probe_ok = bool(tls_ok and http_ok)
        latency_ms = round(max(tls_ms, http_ms), 2)
        last_error = None if probe_ok else (tls_err or http_err)

        prev_healthy = bool(wstate.get("healthy", True))
        if probe_ok:
            wstate["consecutive_successes"] = int(wstate.get("consecutive_successes", 0)) + 1
            wstate["consecutive_failures"] = 0
            if not prev_healthy and wstate["consecutive_successes"] >= args.rise_threshold:
                wstate["healthy"] = True
                wstate["last_transition_ts"] = now_ts
                print(f"[healthcheck] worker {name} ({ip}) transitioned UP "
                      f"(after {wstate['consecutive_successes']} successes)", file=sys.stderr)
        else:
            wstate["consecutive_failures"] = int(wstate.get("consecutive_failures", 0)) + 1
            wstate["consecutive_successes"] = 0
            if prev_healthy and wstate["consecutive_failures"] >= args.fail_threshold:
                wstate["healthy"] = False
                wstate["last_transition_ts"] = now_ts
                print(f"[healthcheck] worker {name} ({ip}) transitioned DOWN: {last_error} "
                      f"(after {wstate['consecutive_failures']} failures)", file=sys.stderr)

        is_healthy = bool(wstate["healthy"])
        if is_healthy:
            healthy_workers.append({"ip": ip, "name": name, "weight": weight})

        status_workers.append(OrderedDict([
            ("ip", ip),
            ("name", name),
            ("weight", weight),
            ("status", "up" if is_healthy else "down"),
            ("healthy", is_healthy),
            ("tls_443_ok", tls_ok),
            ("http_80_ok", http_ok),
            ("latency_ms", latency_ms),
            ("consecutive_failures", wstate["consecutive_failures"]),
            ("consecutive_successes", wstate["consecutive_successes"]),
            ("last_transition_ts", wstate["last_transition_ts"]),
            ("last_error", last_error),
        ]))

    # Вычисляем целевой набор IP-адресов для DNS
    if not raw_workers:
        mode = "single"
        fail_open_active = False
        active_dns_ips = [primary_ip]
    elif not healthy_workers:
        mode = "fail_open_primary"
        fail_open_active = True
        active_dns_ips = [primary_ip]
    else:
        mode = "workers"
        fail_open_active = False
        active_dns_ips = []
        if include_primary_in_dns:
            active_dns_ips.append(primary_ip)
        for hw in healthy_workers:
            if hw["ip"] not in active_dns_ips:
                active_dns_ips.append(hw["ip"])

    active_worker_ips = [hw["ip"] for hw in healthy_workers]
    prev_worker_ips = state.get("active_worker_ips")
    prev_dns_ips = state.get("active_dns_ips")

    need_sync = (
        prev_worker_ips != active_worker_ips
        or prev_dns_ips != active_dns_ips
        or not args.nginx_stream_out.is_file()
        or not args.nginx_http_out.is_file()
        or (args.dnsmasq_template.is_file() and not args.dnsmasq_out.is_file())
    )

    if need_sync:
        last_dns_reload = float(state.get("last_dnsmasq_reload_ts") or 0.0)
        elapsed_since_dns = time.time() - last_dns_reload
        recovering_from_fail_open = (prev_worker_ips == [] and bool(active_worker_ips))
        # При полном отказе воркеров (fail_open_active) или выходе из него обновляем DNS немедленно
        allow_dns_restart = (
            fail_open_active
            or recovering_from_fail_open
            or last_dns_reload == 0.0
            or elapsed_since_dns >= args.min_reload_interval
            or not args.dnsmasq_out.is_file()
        )
        dns_updated, _nginx_updated = apply_configs_and_reload(
            dnsmasq_template=args.dnsmasq_template,
            dnsmasq_out=args.dnsmasq_out,
            nginx_stream_out=args.nginx_stream_out,
            nginx_http_out=args.nginx_http_out,
            active_dns_ips=active_dns_ips,
            healthy_workers=healthy_workers,
            tls_port=args.tls_port,
            http_port=args.http_port,
            no_service_reload=args.no_service_reload,
            allow_dnsmasq_restart=allow_dns_restart,
        )
        state["active_worker_ips"] = active_worker_ips
        if allow_dns_restart:
            state["active_dns_ips"] = active_dns_ips
            if dns_updated and not args.no_service_reload:
                state["last_dnsmasq_reload_ts"] = time.time()

    health_payload = OrderedDict([
        ("updated_at", now_ts),
        ("primary", primary_ip),
        ("domain", domain),
        ("mode", mode),
        ("fail_open_active", fail_open_active),
        ("active_dns_ips", active_dns_ips),
        ("active_worker_ips", active_worker_ips),
        ("workers", status_workers),
    ])
    atomic_write_text(args.status_out, json.dumps(health_payload, ensure_ascii=False, indent=2) + "\n")
    save_state(args.state_file, state)
    return health_payload


async def daemon_loop(args) -> int:
    state = load_state(args.state_file)
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    while not stop_event.is_set():
        try:
            await run_cycle(args, state)
        except Exception as exc:
            print(f"[healthcheck] cycle error: {exc}", file=sys.stderr)
        if args.once:
            break
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=args.interval)
        except asyncio.TimeoutError:
            pass

    return 0


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Активный мониторинг воркеров и автоматический failover для «Перевала»."
    )
    p.add_argument("--cluster-config", type=Path,
                   default=Path("/etc/nginx/geoblock/cluster-nodes.json"),
                   help="путь к cluster-nodes.json")
    p.add_argument("--dnsmasq-template", type=Path,
                   default=Path("/etc/nginx/geoblock/dnsmasq-base.conf"),
                   help="путь к базовому конфигу dnsmasq")
    p.add_argument("--dnsmasq-out", type=Path,
                   default=Path("/etc/dnsmasq.conf"),
                   help="путь к активному /etc/dnsmasq.conf")
    p.add_argument("--nginx-stream-out", type=Path,
                   default=Path("/etc/nginx/geoblock/nginx-workers-stream.conf"),
                   help="путь к nginx-workers-stream.conf")
    p.add_argument("--nginx-http-out", type=Path,
                   default=Path("/etc/nginx/geoblock/nginx-workers-http.conf"),
                   help="путь к nginx-workers-http.conf")
    p.add_argument("--status-out", type=Path,
                   default=Path("/var/www/geoblock/cluster-health.json"),
                   help="путь к JSON-файлу состояния кластера")
    p.add_argument("--state-file", type=Path,
                   default=Path("/var/lib/pereval-healthcheck/state.json"),
                   help="путь к файлу сохранения состояния гистерезиса")
    p.add_argument("--interval", type=float, default=5.0,
                   help="интервал опроса воркеров в секундах (по умолчанию 5)")
    p.add_argument("--timeout", type=float, default=3.0,
                   help="таймаут одной проверки в секундах (по умолчанию 3)")
    p.add_argument("--fail-threshold", type=int, default=2,
                   help="число ошибок подряд для вывода воркера из пула (по умолчанию 2)")
    p.add_argument("--rise-threshold", type=int, default=2,
                   help="число успешных проверок подряд для возврата воркера (по умолчанию 2)")
    p.add_argument("--min-reload-interval", type=float, default=15.0,
                   help="минимальный интервал между перезапусками dnsmasq в секундах")
    p.add_argument("--tls-port", type=int, default=443,
                   help="TCP-порт TLS SNI прокси на воркерах (по умолчанию 443)")
    p.add_argument("--http-port", type=int, default=80,
                   help="TCP-порт HTTP прокси на воркерах (по умолчанию 80)")
    p.add_argument("--no-service-reload", action="store_true",
                   help="только записывать конфиги без вызова systemctl/nginx/dnsmasq")
    p.add_argument("--once", action="store_true",
                   help="выполнить один цикл проверки и завершиться")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    return asyncio.run(daemon_loop(args))


if __name__ == "__main__":
    sys.exit(main())
