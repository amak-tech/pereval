#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Агент прокси-воркера «Перевал Pro» (pereval-pro-agent.service), работает от root.

Воркер Pro — это прозрачный SNI/Host-прокси (nginx) без сайта и DNS. Порты 80/443
на нём закрыты nftables и открываются только IP-адресам подписчиков, которые
control plane узнаёт от pro_dns.py. Агент:
  1. На старте и в каждом цикле убеждается, что таблица nftables `inet pereval_pro`
     существует (создаёт идемпотентно), а на старте дополнительно атомарно
     переписывает правила цепочки input (чтобы подхватить новые --trusted-ips):
        iif lo accept
        tcp dport {80,443} ip saddr @pro_clients accept
        tcp dport {80,443} ip saddr { <TRUSTED_IPS> } accept   (DNS-нода, CP, Free primary)
        tcp dport {80,443} drop
        udp dport 443 reject                                   (QUIC -> быстрый откат на TCP)
  2. Long-poll GET /api/internal/v1/node/acl?version=N&wait=25 в control plane:
     желаемый набор = static ∪ dynamic (не истёкшие). Текущий набор читается
     `nft -j list set inet pereval_pro pro_clients`, разница применяется ОДНОЙ
     транзакцией `nft -f -` (и удаления, и добавления). Если CP недоступен дольше
     10 минут — набор НЕ трогаем (никогда не flush): подписчики продолжают работать.
  3. Раз в 60 с GET /api/internal/v1/node/config: логирует version и число
     extra_domains; если они есть — пишет /etc/nginx/geoblock/extra-sni-allow.map и
     extra-host-allow.map в формате allow-map и делает `nginx -t && nginx -s reload`
     (задел под Dedicated).

В сеть ничего не выставляет. В логах — только счётчики, без IP подписчиков.
--dry-run печатает команды nft вместо выполнения. Только стандартная библиотека.
"""

import argparse
import asyncio
import ipaddress
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# dnscommon.py лежит рядом (репозиторий) или в /usr/local/lib/pereval (сервер)
for _cand in (os.path.dirname(os.path.abspath(__file__)), "/usr/local/lib/pereval"):
    if _cand not in sys.path:
        sys.path.insert(0, _cand)
import dnscommon  # noqa: E402

LOG_PREFIX = "[pro-agent]"
TABLE_FAMILY = "inet"
TABLE = "pereval_pro"
SET_NAME = "pro_clients"
CHAIN = "input"
ACL_API = "/api/internal/v1/node/acl"
CONFIG_API = "/api/internal/v1/node/config"
CP_UNREACHABLE_WARN = 600  # секунд без успешного ответа CP до предупреждений
DOMAIN_RE = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$")
SET_CHUNK = 500  # элементов в одной строке add/delete element

MAP_HEADER = (
    "# -----------------------------------------------------------------------------\n"
    "# Дополнительные домены (Dedicated) — АВТОМАТИЧЕСКИ ОБНОВЛЕНО pro_node_agent.py,\n"
    "# не правьте руками. Подключается include'ом рядом с %s.\n"
    "# -----------------------------------------------------------------------------\n"
)


def log(msg: str):
    print("%s %s" % (LOG_PREFIX, msg), file=sys.stderr, flush=True)


# =============================================================================
# Чистые функции: разбор, рендер скриптов nft, разница наборов
# =============================================================================


def parse_ip_list(raw) -> list:
    """«1.2.3.4, 5.6.7.8» или список -> уникальные IPv4 в порядке появления.
    IPv6 и мусор отбрасываются (набор pro_clients — ipv4_addr)."""
    if raw is None:
        return []
    items = raw if isinstance(raw, (list, tuple, set)) else re.split(r"[,\s]+", str(raw))
    out = []
    for item in items:
        ip = dnscommon.normalize_ip(item) if str(item).strip() else None
        if ip and ":" not in ip and ip not in out:
            out.append(ip)
    return out


def nft_set_literal(ips) -> str:
    return "{ " + ", ".join(ips) + " }"


def render_chain_rules(trusted_ips) -> list:
    """Правила цепочки input в нужном порядке."""
    rules = [
        "iif lo accept",
        "tcp dport { 80, 443 } ip saddr @%s accept" % SET_NAME,
    ]
    trusted = parse_ip_list(trusted_ips)
    if trusted:
        rules.append("tcp dport { 80, 443 } ip saddr %s accept" % nft_set_literal(trusted))
    rules.append("tcp dport { 80, 443 } drop")
    rules.append("udp dport 443 reject")
    return rules


def render_table_script(trusted_ips) -> str:
    """Полная таблица для `nft -f -` (когда её ещё нет)."""
    lines = [
        "table %s %s {" % (TABLE_FAMILY, TABLE),
        "\tset %s {" % SET_NAME,
        "\t\ttype ipv4_addr",
        "\t}",
        "\tchain %s {" % CHAIN,
        "\t\ttype filter hook input priority -10; policy accept;",
    ]
    for rule in render_chain_rules(trusted_ips):
        lines.append("\t\t%s" % rule)
    lines.append("\t}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def render_chain_rewrite_script(trusted_ips) -> str:
    """Атомарно переписывает правила цепочки (набор не трогает)."""
    lines = ["flush chain %s %s %s" % (TABLE_FAMILY, TABLE, CHAIN)]
    for rule in render_chain_rules(trusted_ips):
        lines.append("add rule %s %s %s %s" % (TABLE_FAMILY, TABLE, CHAIN, rule))
    return "\n".join(lines) + "\n"


def _elem_to_ip(elem):
    """Элемент из JSON nft -> строка IP (или None для диапазонов/мусора)."""
    if isinstance(elem, str):
        return dnscommon.normalize_ip(elem)
    if isinstance(elem, dict):
        if "elem" in elem:  # {"elem": {"val": "1.2.3.4", "expires": 10, ...}}
            inner = elem["elem"]
            if isinstance(inner, dict):
                return _elem_to_ip(inner.get("val"))
            return _elem_to_ip(inner)
        if "prefix" in elem:
            pr = elem["prefix"] or {}
            addr = dnscommon.normalize_ip(pr.get("addr", ""))
            ln = pr.get("len")
            if addr and ln == 32:
                return addr
            return "%s/%s" % (addr, ln) if addr else None
        if "range" in elem:
            rng = elem["range"]
            if isinstance(rng, list) and len(rng) == 2:
                a, b = dnscommon.normalize_ip(rng[0]), dnscommon.normalize_ip(rng[1])
                if a and a == b:
                    return a
                return "%s-%s" % (a, b) if a and b else None
    return None


def parse_set_elements(nft_json_text: str) -> set:
    """Разбирает вывод `nft -j list set inet pereval_pro pro_clients` -> set(IP)."""
    if not nft_json_text or not nft_json_text.strip():
        return set()
    data = json.loads(nft_json_text)
    out = set()
    for item in data.get("nftables") or []:
        if not isinstance(item, dict) or "set" not in item:
            continue
        s = item["set"] or {}
        if s.get("name") != SET_NAME:
            continue
        for elem in s.get("elem") or []:
            ip = _elem_to_ip(elem)
            if ip:
                out.add(ip)
    return out


def parse_iso8601(value):
    """«2026-11-09T14:00:00Z» (или с offset / без) -> unix time. None, если не разобрать."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    try:
        if s.endswith("Z") or s.endswith("z"):
            s = s[:-1] + "+00:00"
        # datetime.fromisoformat в 3.9 не понимает дробные секунды с >6 знаками — обрежем
        m = re.match(r"^(.*T\d{2}:\d{2}:\d{2})\.(\d+)(.*)$", s)
        if m and len(m.group(2)) > 6:
            s = "%s.%s%s" % (m.group(1), m.group(2)[:6], m.group(3))
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def desired_set(acl: dict, now: float = None) -> set:
    """static ∪ dynamic(не истёкшие) -> set(IPv4)."""
    now = time.time() if now is None else now
    out = set()
    if not isinstance(acl, dict):
        return out
    for ip in acl.get("static") or []:
        n = dnscommon.normalize_ip(ip)
        if n and ":" not in n:
            out.add(n)
    for ent in acl.get("dynamic") or []:
        if isinstance(ent, str):
            ip, exp = ent, None
        elif isinstance(ent, dict):
            ip, exp = ent.get("ip"), parse_iso8601(ent.get("expires_at"))
        else:
            continue
        n = dnscommon.normalize_ip(ip or "")
        if not n or ":" in n:
            continue
        if exp is not None and exp <= now:
            continue
        out.add(n)
    return out


def compute_diff(current: set, desired: set):
    """-> (to_add, to_del), отсортированные по числовому значению IP."""
    def _key(ip):
        try:
            return int(ipaddress.IPv4Address(ip.split("/")[0].split("-")[0]))
        except ValueError:
            return 0
    to_add = sorted(desired - current, key=_key)
    to_del = sorted(current - desired, key=_key)
    return to_add, to_del


def render_update_script(to_add, to_del, chunk: int = SET_CHUNK) -> str:
    """Одна транзакция `nft -f -`: сначала удаления, затем добавления."""
    lines = []
    for i in range(0, len(to_del), chunk):
        lines.append("delete element %s %s %s %s" % (TABLE_FAMILY, TABLE, SET_NAME, nft_set_literal(to_del[i:i + chunk])))
    for i in range(0, len(to_add), chunk):
        lines.append("add element %s %s %s %s" % (TABLE_FAMILY, TABLE, SET_NAME, nft_set_literal(to_add[i:i + chunk])))
    return ("\n".join(lines) + "\n") if lines else ""


def render_extra_maps(domains):
    """(sni_map, host_map) в формате nginx-*-allow.map для списка доменов."""
    clean = []
    for d in domains or []:
        d = str(d).strip().rstrip(".").lower()
        if d and DOMAIN_RE.match(d) and d not in clean:
            clean.append(d)
    width = max((len("." + d) for d in clean), default=10) + 2
    sni = [MAP_HEADER % "nginx-sni-allow.map"]
    host = [MAP_HEADER % "nginx-host-allow.map"]
    for d in clean:
        sni.append("%-*s %s;" % (width, "." + d, "$ssl_preread_server_name:443"))
        host.append("%-*s %s;" % (width, "." + d, "$host"))
    return "\n".join(sni) + "\n", "\n".join(host) + "\n"


# =============================================================================
# Обёртка над nft (с dry-run)
# =============================================================================


class Nft:
    """Вызовы бинаря nft. В dry-run команды печатаются, а состояние имитируется."""

    def __init__(self, binary: str = "nft", dry_run: bool = False):
        self.binary = binary
        self.dry_run = dry_run
        self.sim_table = False
        self.sim_set = set()
        self.executed = []  # для тестов: список (argv, stdin)

    def run(self, args, stdin: str = None, check: bool = False):
        argv = [self.binary] + list(args)
        self.executed.append((argv, stdin))
        if self.dry_run:
            print("$ %s%s" % (" ".join(argv), " <<EOF" if stdin else ""))
            if stdin:
                sys.stdout.write(stdin if stdin.endswith("\n") else stdin + "\n")
                print("EOF")
            sys.stdout.flush()
            return 0, "", ""
        res = subprocess.run(argv, input=stdin, capture_output=True, text=True)
        if check and res.returncode != 0:
            raise RuntimeError("nft %s failed (%d): %s" % (" ".join(args), res.returncode, res.stderr.strip()))
        return res.returncode, res.stdout, res.stderr

    def table_exists(self) -> bool:
        if self.dry_run:
            return self.sim_table
        rc, _out, _err = self.run(["list", "table", TABLE_FAMILY, TABLE])
        return rc == 0

    def apply_script(self, script: str) -> None:
        if not script.strip():
            return
        self.run(["-f", "-"], stdin=script, check=True)

    def list_set(self) -> set:
        if self.dry_run:
            return set(self.sim_set)
        rc, out, err = self.run(["-j", "list", "set", TABLE_FAMILY, TABLE, SET_NAME])
        if rc != 0:
            raise RuntimeError("nft list set failed (%d): %s" % (rc, err.strip()))
        return parse_set_elements(out)


# =============================================================================
# Агент
# =============================================================================


class Agent:
    def __init__(self, args):
        self.args = args
        self.trusted_ips = parse_ip_list(args.trusted_ips)
        self.nft = Nft(args.nft, dry_run=args.dry_run)
        self.acl_version = 0
        self.config_version = None
        self.last_cp_ok = time.time()
        self.last_warn = 0.0
        self.stop_event = None
        self.cp = None
        if not args.no_cp:
            if not args.cp_origin or not args.node_secret:
                raise SystemExit("CP_ORIGIN и NODE_SECRET обязательны (или --no-cp для проверки nftables)")
            self.cp = _ControlPlane(args.cp_origin, args.node_secret, args.cp_timeout, args.cp_ca_file)

    # ------------------------------------------------------------- nftables

    def ensure_table(self, rewrite_chain: bool = False) -> bool:
        """Создаёт таблицу, если её нет; при rewrite_chain переписывает правила цепочки.
        Возвращает True, если таблица была создана."""
        created = False
        if not self.nft.table_exists():
            self.nft.apply_script(render_table_script(self.trusted_ips))
            self.nft.sim_table = True
            created = True
            log("nftables table %s %s created (trusted ips: %d)" % (TABLE_FAMILY, TABLE, len(self.trusted_ips)))
        elif rewrite_chain:
            self.nft.apply_script(render_chain_rewrite_script(self.trusted_ips))
            log("nftables chain %s rules rewritten (trusted ips: %d)" % (CHAIN, len(self.trusted_ips)))
        return created

    def sync_acl(self, acl: dict, now: float = None):
        """Приводит набор pro_clients к желаемому одной транзакцией. -> (added, removed, total)."""
        now = time.time() if now is None else now
        desired = desired_set(acl, now)
        current = self.nft.list_set()
        to_add, to_del = compute_diff(current, desired)
        script = render_update_script(to_add, to_del)
        if script:
            self.nft.apply_script(script)
            if self.nft.dry_run:
                self.nft.sim_set = set(desired)
        return len(to_add), len(to_del), len(desired)

    # ------------------------------------------------------------- nginx extra maps

    def ensure_extra_maps_exist(self):
        """Пустые extra-карты должны существовать, иначе include в nginx упадёт."""
        for path in (self.args.extra_sni_map, self.args.extra_host_map):
            p = Path(path)
            if not p.is_file():
                if self.args.dry_run:
                    print("# would create empty %s" % p)
                    continue
                try:
                    _atomic_write(p, MAP_HEADER % "nginx-*-allow.map")
                except Exception as exc:
                    log("warning: cannot create %s: %s" % (p, exc))

    def apply_extra_domains(self, domains) -> bool:
        """Пишет extra-карты и перезагружает nginx, если содержимое изменилось."""
        sni_text, host_text = render_extra_maps(domains)
        sni_path, host_path = Path(self.args.extra_sni_map), Path(self.args.extra_host_map)
        prev_sni = sni_path.read_text(encoding="utf-8") if sni_path.is_file() else None
        prev_host = host_path.read_text(encoding="utf-8") if host_path.is_file() else None
        if prev_sni == sni_text and prev_host == host_text:
            return False
        if self.args.dry_run:
            print("# would write %s and %s (%d domains) and reload nginx" % (sni_path, host_path, sni_text.count(";")))
            return True
        _atomic_write(sni_path, sni_text)
        _atomic_write(host_path, host_text)
        nginx = shutil.which("nginx")
        if not nginx:
            log("extra maps written (%d domains); nginx binary not found, skip reload" % sni_text.count(";"))
            return True
        test = subprocess.run([nginx, "-t"], capture_output=True, text=True)
        if test.returncode != 0:
            log("nginx -t failed after extra maps update, rolling back: %s" % test.stderr.strip()[-400:])
            if prev_sni is not None:
                _atomic_write(sni_path, prev_sni)
            if prev_host is not None:
                _atomic_write(host_path, prev_host)
            return False
        subprocess.run([nginx, "-s", "reload"], capture_output=True, text=True)
        log("extra maps updated (%d domains), nginx reloaded" % sni_text.count(";"))
        return True

    # ------------------------------------------------------------- циклы

    def _note_cp_ok(self):
        self.last_cp_ok = time.time()

    def _maybe_warn_unreachable(self, err: str):
        now = time.time()
        down_for = now - self.last_cp_ok
        if down_for > CP_UNREACHABLE_WARN and now - self.last_warn > 60:
            self.last_warn = now
            log("control plane unreachable for %d min (%s); keeping current pro_clients set untouched" % (int(down_for // 60), err))

    async def acl_loop(self):
        args = self.args
        backoff = 1.0
        last_err = None
        while not self.stop_event.is_set():
            try:
                self.ensure_table()
            except Exception as exc:
                log("nftables error: %s" % exc)
            path = "%s?version=%d&wait=%d" % (ACL_API, self.acl_version, args.cp_wait)
            try:
                status, data = await self.cp.get_json(path, timeout=args.cp_wait + args.cp_timeout)
                err = None
            except Exception as exc:
                status, data, err = None, None, "%s: %s" % (type(exc).__name__, exc)
            if status == 200 and isinstance(data, dict):
                self._note_cp_ok()
                backoff, last_err = 1.0, None
                try:
                    added, removed, total = self.sync_acl(data)
                    self.acl_version = int(data.get("version") or self.acl_version)
                    if added or removed:
                        log("acl v%d: +%d -%d (total %d)" % (self.acl_version, added, removed, total))
                except Exception as exc:
                    log("acl apply error: %s" % exc)
                await asyncio.sleep(0.2)
                continue
            if status == 304:
                self._note_cp_ok()
                backoff, last_err = 1.0, None
                continue
            if status is not None:
                err = "HTTP %s" % status
            if err != last_err:
                log("acl poll error: %s (backoff %.0fs)" % (err, backoff))
                last_err = err
            self._maybe_warn_unreachable(err or "?")
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(30.0, backoff * 2)

    async def config_loop(self):
        args = self.args
        while not self.stop_event.is_set():
            try:
                status, data = await self.cp.get_json(CONFIG_API, timeout=args.cp_timeout)
                if status == 200 and isinstance(data, dict):
                    self._note_cp_ok()
                    version = data.get("version")
                    extra = data.get("extra_domains") or []
                    if not isinstance(extra, list):
                        extra = []
                    if version != self.config_version:
                        self.config_version = version
                        log("node config v%s: %d extra domains, tenant=%s" % (version, len(extra), "yes" if data.get("tenant") else "none"))
                    try:
                        self.apply_extra_domains(extra)
                    except Exception as exc:
                        log("extra domains apply error: %s" % exc)
                elif status is not None:
                    log("node config: HTTP %s" % status)
            except Exception as exc:
                log("node config poll error: %s: %s" % (type(exc).__name__, exc))
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=args.config_interval)
            except asyncio.TimeoutError:
                pass

    async def run(self) -> int:
        self.stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self.stop_event.set)
            except NotImplementedError:
                pass
        try:
            self.ensure_table(rewrite_chain=True)
        except Exception as exc:
            log("nftables bootstrap error: %s" % exc)
            if self.args.once:
                return 1
        self.ensure_extra_maps_exist()
        if self.cp is None:
            log("--no-cp: nftables ensured, nothing more to do")
            return 0
        if self.args.once:
            # Один проход: ACL без ожидания + конфиг
            try:
                status, data = await self.cp.get_json("%s?version=0&wait=0" % ACL_API, timeout=self.args.cp_timeout)
                if status == 200 and isinstance(data, dict):
                    added, removed, total = self.sync_acl(data)
                    log("acl v%s: +%d -%d (total %d)" % (data.get("version"), added, removed, total))
                else:
                    log("acl: HTTP %s" % status)
                status, data = await self.cp.get_json(CONFIG_API, timeout=self.args.cp_timeout)
                if status == 200 and isinstance(data, dict):
                    log("node config v%s: %d extra domains" % (data.get("version"), len(data.get("extra_domains") or [])))
                    self.apply_extra_domains(data.get("extra_domains") or [])
            except Exception as exc:
                log("once error: %s: %s" % (type(exc).__name__, exc))
                return 1
            return 0
        tasks = [asyncio.ensure_future(self.acl_loop()), asyncio.ensure_future(self.config_loop())]
        await self.stop_event.wait()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        log("stopped")
        return 0


class _ControlPlane:
    """GET JSON к control plane с Bearer-секретом (тот же контракт, что у pro_dns.py)."""

    def __init__(self, origin: str, secret: str, timeout: float, ca_file: str = None):
        import ssl
        self.origin = origin.rstrip("/")
        self.secret = secret
        self.timeout = timeout
        self.ssl_context = None
        if self.origin.lower().startswith("https://"):
            self.ssl_context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()

    async def get_json(self, path: str, timeout: float = None):
        resp = await dnscommon.http_request(
            self.origin + path, "GET", headers={"Authorization": "Bearer %s" % self.secret},
            timeout=timeout or self.timeout, ssl_context=self.ssl_context,
        )
        data = None
        if resp.body:
            try:
                data = json.loads(resp.body.decode("utf-8"))
            except Exception:
                data = None
        return resp.status, data


def _atomic_write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (".%s.tmp.%d" % (path.name, os.getpid()))
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _env(name: str, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Агент воркера «Перевал Pro»: nftables-доступ к 80/443 только для IP подписчиков "
                    "(ACL из control plane) и extra-домены Dedicated для nginx.",
    )
    p.add_argument("--cp-origin", default=_env("CP_ORIGIN"), help="origin control plane (env CP_ORIGIN)")
    p.add_argument("--node-secret", default=_env("NODE_SECRET"), help="Bearer-секрет узла (env NODE_SECRET)")
    p.add_argument("--trusted-ips", default=_env("TRUSTED_IPS", ""),
                   help="IP, которым 80/443 открыты всегда: pro-dns, CP, Free primary (env TRUSTED_IPS, через запятую)")
    p.add_argument("--cp-wait", type=int, default=25, help="wait для long-poll ACL в секундах (по умолчанию 25)")
    p.add_argument("--cp-timeout", type=float, default=15.0, help="таймаут HTTP к control plane сверх wait (по умолчанию 15)")
    p.add_argument("--cp-ca-file", default=_env("CP_CA_FILE"), help="свой CA для HTTPS к control plane (необязательно)")
    p.add_argument("--config-interval", type=float, default=60.0, help="период опроса /node/config (по умолчанию 60 с)")
    p.add_argument("--nft", default="nft", help="путь к бинарю nft (по умолчанию nft из PATH)")
    p.add_argument("--extra-sni-map", default="/etc/nginx/geoblock/extra-sni-allow.map",
                   help="куда писать дополнительные SNI-домены для nginx stream")
    p.add_argument("--extra-host-map", default="/etc/nginx/geoblock/extra-host-allow.map",
                   help="куда писать дополнительные Host-домены для nginx http")
    p.add_argument("--dry-run", action="store_true", help="печатать команды nft вместо выполнения")
    p.add_argument("--once", action="store_true", help="один проход (таблица, ACL без ожидания, конфиг) и выход")
    p.add_argument("--no-cp", action="store_true", help="только убедиться в наличии таблицы nftables и выйти")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    agent = Agent(args)
    try:
        return asyncio.run(agent.run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
