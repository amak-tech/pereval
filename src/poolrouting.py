#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Маршрутизация сервисов по пулам воркеров — общий модуль для generate.py,
healthcheck.py и pro_dns.py. Только стандартная библиотека Python 3.

Идея: воркеры объединены в именованные пулы (default, ai, media, ...). У каждого
сервиса есть пул (явно у сервиса, иначе у категории, иначе «default»). Для
сервиса выбирается ОДНА нода пула детерминированно — rendezvous-хэшем
(highest random weight) по строке «имя сервиса + IP ноды». Так все домены одного
сервиса всегда резолвятся в один и тот же IP, а при выпадении ноды пересаживаются
только сервисы, которые были на ней.

Пул без живых нод уходит по цепочке fallback (pools[name].fallback), а если
и там пусто — в «последний резерв» (Primary для Free, все ноды для Pro).

Совместимо с Python 3.9+.
"""

from collections import OrderedDict
import hashlib
import ipaddress
import math
import threading
import time

DEFAULT_POOL = "default"
DEFAULT_MAX_CLIENTS = 150
DEFAULT_QUOTA_TTL_SEC = 300.0


def hrw_score(key, node_ip):
    """Детерминированный «вес» пары (ключ, нода) для rendezvous-хэша."""
    h = hashlib.blake2b(("%s\x00%s" % (key, node_ip)).encode("utf-8"), digest_size=8)
    return int.from_bytes(h.digest(), "big")


def weighted_hrw_score(key: str, node_ip: str, weight: int = 1) -> float:
    """Детерминированный взвешенный HRW-вес пары (ключ, нода).

    При равных весах порядок нод строго совпадает с hrw_score(key, node_ip),
    а при разных весах вероятность выбора ноды пропорциональна weight.
    """
    raw = hrw_score(key, node_ip)
    # 53 старших бита дают точное число в (0, 1) без округления до 1.0 в float64
    u = ((raw >> 11) + 0.5) / float(1 << 53)
    w = max(1, int(weight or 1))
    return float(w) / (-math.log(u))


def client_subnet_key(ip: str, ipv4_prefix: int = 24, ipv6_prefix: int = 56) -> str:
    """Нормализует IP клиента в ключ подсети ('1.2.3.0/24' или '2001:db8::/56')."""
    raw = str(ip or "").strip()
    if "%" in raw:
        raw = raw.split("%", 1)[0]
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError:
        return raw.lower() or "0.0.0.0/%d" % int(ipv4_prefix)
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        addr = mapped
    if isinstance(addr, ipaddress.IPv4Address):
        pref = max(0, min(32, int(ipv4_prefix)))
        return str(ipaddress.IPv4Network((addr, pref), strict=False))
    pref = max(0, min(128, int(ipv6_prefix)))
    return str(ipaddress.IPv6Network((addr, pref), strict=False))


def rendezvous_pick(key, candidates):
    """Выбирает одну ноду из candidates по ключу. Пусто -> None."""
    best = None
    best_score = -1
    for ip in candidates:
        score = hrw_score(key, ip)
        if score > best_score or (score == best_score and (best is None or ip < best)):
            best, best_score = ip, score
    return best


def rendezvous_order(key, candidates, weights=None):
    """Все ноды, отсортированные по убыванию веса (первая = выбранная)."""
    if not weights:
        return sorted(candidates, key=lambda ip: (-hrw_score(key, ip), ip))
    return sorted(
        candidates,
        key=lambda ip: (
            -weighted_hrw_score(key, ip, int(weights.get(ip) or 1)),
            -hrw_score(key, ip),
            ip,
        ),
    )


class ClientQuotaTracker:
    """Потокобезопасный учёт активных client_key по нодам в скользящем окне ttl_sec (по умолчанию 300 с)."""

    def __init__(self, ttl_sec: float = DEFAULT_QUOTA_TTL_SEC) -> None:
        self.ttl_sec = max(1.0, float(ttl_sec))
        self._lock = threading.Lock()
        self._nodes = {}  # {node_ip: {client_key: expires_at}}

    @staticmethod
    def _now(now: float = None) -> float:
        return time.monotonic() if now is None else float(now)

    def _prune_node_unlocked(self, node_ip: str, ts: float) -> dict:
        bucket = self._nodes.get(node_ip)
        if not bucket:
            return {}
        expired = [ck for ck, exp in bucket.items() if exp <= ts]
        for ck in expired:
            bucket.pop(ck, None)
        if not bucket:
            self._nodes.pop(node_ip, None)
            return {}
        return bucket

    def has_active(self, node_ip: str, client_key: str, now: float = None) -> bool:
        if not node_ip or not client_key:
            return False
        ts = self._now(now)
        with self._lock:
            bucket = self._prune_node_unlocked(str(node_ip), ts)
            return str(client_key) in bucket

    def active_count(self, node_ip: str, now: float = None) -> int:
        if not node_ip:
            return 0
        ts = self._now(now)
        with self._lock:
            bucket = self._prune_node_unlocked(str(node_ip), ts)
            return len(bucket)

    def can_admit(self, node_ip: str, client_key: str, max_clients: int = None, now: float = None) -> bool:
        if not node_ip:
            return False
        if max_clients is None or int(max_clients) <= 0:
            return True
        limit = int(max_clients)
        ck = str(client_key or "")
        ts = self._now(now)
        with self._lock:
            bucket = self._prune_node_unlocked(str(node_ip), ts)
            if ck and ck in bucket:
                return True
            return len(bucket) < limit

    def touch(self, node_ip: str, client_key: str, now: float = None) -> None:
        if not node_ip or not client_key:
            return
        ts = self._now(now)
        nip = str(node_ip)
        ck = str(client_key)
        with self._lock:
            bucket = self._prune_node_unlocked(nip, ts)
            if not bucket and nip not in self._nodes:
                bucket = {}
                self._nodes[nip] = bucket
            bucket[ck] = ts + self.ttl_sec

    def active_by_node(self, now: float = None) -> dict:
        ts = self._now(now)
        with self._lock:
            out = {}
            for nip in list(self._nodes.keys()):
                bucket = self._prune_node_unlocked(nip, ts)
                if bucket:
                    out[nip] = len(bucket)
            return out


def normalize_pools(pools):
    """Приводит описание пулов к {name: {"fallback": str|None, "strict_allowlist": bool, "note": str, ...}}.

    Принимает словарь из services.yaml / cluster-nodes.json / pro-policy-map.json.
    Пул «default» добавляется всегда.
    """
    out = OrderedDict()
    if isinstance(pools, dict):
        for name, raw in pools.items():
            raw = raw or {}
            if not isinstance(raw, dict):
                raw = {}
            fb = raw.get("fallback")
            mc = raw.get("max_clients")
            max_clients = None
            if mc is not None and not isinstance(mc, bool):
                try:
                    if int(mc) >= 1:
                        max_clients = int(mc)
                except (TypeError, ValueError):
                    max_clients = None
            entry = {
                "fallback": str(fb).strip() if fb else None,
                "strict_allowlist": bool(raw.get("strict_allowlist", False)),
                "note": str(raw.get("note") or ""),
            }
            if max_clients is not None:
                entry["max_clients"] = max_clients
            out[str(name)] = entry
    if DEFAULT_POOL not in out:
        out[DEFAULT_POOL] = {"fallback": None, "strict_allowlist": False, "note": ""}
    return out


def resolve_node_max_clients(
    node_ip: str,
    pool_name: str,
    pools: dict,
    workers: list,
    cluster_max_clients: int = None,
    default_max_clients: int = DEFAULT_MAX_CLIENTS,
) -> int:
    """Возвращает эффективный лимит клиентов для ноды: worker -> pool -> cluster -> default."""
    def _pos_int(val):
        if val is None or isinstance(val, bool):
            return None
        try:
            iv = int(val)
            return iv if iv >= 1 else None
        except (TypeError, ValueError):
            return None

    worker_pools = []
    for w in workers or []:
        wip = w.get("ip") if isinstance(w, dict) else getattr(w, "ip", None)
        if wip == node_ip:
            wmc = w.get("max_clients") if isinstance(w, dict) else getattr(w, "max_clients", None)
            iv = _pos_int(wmc)
            if iv is not None:
                return iv
            wpools = w.get("pools") if isinstance(w, dict) else getattr(w, "pools", None)
            worker_pools = list(wpools or [])
            break

    pools_map = pools if isinstance(pools, dict) else {}
    if pool_name and pool_name in pools_map:
        pinfo = pools_map.get(pool_name) or {}
        if isinstance(pinfo, dict):
            iv = _pos_int(pinfo.get("max_clients"))
            if iv is not None:
                return iv

    pool_limits = []
    for pname in worker_pools:
        pinfo = pools_map.get(pname) or {}
        if isinstance(pinfo, dict):
            iv = _pos_int(pinfo.get("max_clients"))
            if iv is not None:
                pool_limits.append(iv)
    if pool_limits:
        return min(pool_limits)

    iv = _pos_int(cluster_max_clients)
    if iv is not None:
        return iv

    iv = _pos_int(default_max_clients)
    return iv if iv is not None else DEFAULT_MAX_CLIENTS


def pool_chain(pool_name, pools):
    """Цепочка пулов от запрошенного до конца fallback'ов (без циклов)."""
    pools = pools if pools is not None else {}
    chain = []
    seen = set()
    cur = pool_name or DEFAULT_POOL
    while cur and cur not in seen:
        chain.append(cur)
        seen.add(cur)
        info = pools.get(cur) or {}
        cur = info.get("fallback") if isinstance(info, dict) else None
    if DEFAULT_POOL not in seen:
        chain.append(DEFAULT_POOL)
    return chain


def workers_by_pool(workers, pools, extra_ips=None):
    """{pool: [ip, ...]} из списка воркеров [{ip, pools:[...]}].

    extra_ips (например, Primary при include_primary_in_dns) добавляются во все пулы.
    Воркер без поля pools попадает в «default».
    """
    out = OrderedDict((name, []) for name in pools)
    for w in workers or []:
        ip = w.get("ip") if isinstance(w, dict) else getattr(w, "ip", None)
        if not ip:
            continue
        wpools = w.get("pools") if isinstance(w, dict) else getattr(w, "pools", None)
        wpools = list(wpools or [DEFAULT_POOL])
        for pname in wpools:
            out.setdefault(pname, [])
            if ip not in out[pname]:
                out[pname].append(ip)
    for ip in extra_ips or []:
        for pname in out:
            if ip not in out[pname]:
                out[pname].append(ip)
    return out


def candidates_for(pool_name, pools, healthy_by_pool):
    """Первый непустой набор нод по цепочке пулов. Пусто -> []."""
    for pname in pool_chain(pool_name, pools):
        ips = healthy_by_pool.get(pname) or []
        if ips:
            return list(ips)
    return []


def pick(service_key, pool_name, pools, healthy_by_pool, last_resort=None):
    """IP ноды для сервиса: пул -> fallback-цепочка -> last_resort -> None."""
    cands = candidates_for(pool_name, pools, healthy_by_pool)
    if not cands:
        cands = list(last_resort or [])
    return rendezvous_pick(service_key, cands) if cands else None


def _node_limit(node_ip, pool_name, pools, node_limits):
    if isinstance(node_limits, dict):
        if (pool_name, node_ip) in node_limits:
            return node_limits[(pool_name, node_ip)]
        if node_ip in node_limits:
            return node_limits[node_ip]
    if isinstance(pools, dict) and pool_name in pools:
        pinfo = pools.get(pool_name) or {}
        if isinstance(pinfo, dict) and pinfo.get("max_clients") is not None:
            return pinfo.get("max_clients")
    return None


def pick_for_client(
    client_key: str,
    pool_name: str,
    pools: dict,
    healthy_by_pool: dict,
    last_resort: list = None,
    weights: dict = None,
    node_limits: dict = None,
    quota_tracker: ClientQuotaTracker = None,
    now: float = None,
):
    """Выбирает IP ноды пула для пользователя с учётом sticky-сессии, весов и квоты max_clients.

    1. Обходит цепочку пулов pool_chain(pool_name, pools).
    2. Внутри пула упорядочивает живые ноды по взвешенному HRW от ключа '<pool>\\x00<client_key>'.
    3. Если quota_tracker задан:
       - если клиент уже активен на одной из здоровых нод пула — продлевает сессию и возвращает её;
       - иначе выбирает первую ноду пула со свободным слотом (< max_clients);
       - если все ноды текущего пула заполнены, переходит к fallback-пулу;
       - если все ноды во всей цепочке пулов заполнены, возвращает None (откат в plain DNS).
    4. Если во всей цепочке пулов нет ни одной живой ноды, использует last_resort.
    """
    ck = str(client_key or "").strip() or DEFAULT_POOL
    healthy_by_pool = healthy_by_pool if isinstance(healthy_by_pool, dict) else {}
    saw_healthy = False

    for pname in pool_chain(pool_name, pools):
        ips = list(healthy_by_pool.get(pname) or [])
        if not ips:
            continue
        saw_healthy = True
        hrw_key = "%s\x00%s" % (pname, ck)
        ordered = rendezvous_order(hrw_key, ips, weights=weights)
        if quota_tracker is None:
            return ordered[0] if ordered else None

        # Сначала сохраняем привязку, если у клиента уже есть активная сессия в этом пуле
        for ip in ordered:
            if quota_tracker.has_active(ip, ck, now=now):
                quota_tracker.touch(ip, ck, now=now)
                return ip

        # Для нового клиента ищем первую ноду со свободным слотом
        for ip in ordered:
            limit = _node_limit(ip, pname, pools, node_limits)
            if quota_tracker.can_admit(ip, ck, limit, now=now):
                quota_tracker.touch(ip, ck, now=now)
                return ip

    if saw_healthy:
        # Живые ноды есть, но все слоты max_clients исчерпаны -> сигнал отката в plain DNS
        return None

    cands = list(last_resort or [])
    if not cands:
        return None
    hrw_key = "%s\x00%s" % (pool_name or DEFAULT_POOL, ck)
    ordered = rendezvous_order(hrw_key, cands, weights=weights)
    if quota_tracker is None:
        return ordered[0]
    for ip in ordered:
        if quota_tracker.has_active(ip, ck, now=now):
            quota_tracker.touch(ip, ck, now=now)
            return ip
    for ip in ordered:
        limit = _node_limit(ip, pool_name or DEFAULT_POOL, pools, node_limits)
        if quota_tracker.can_admit(ip, ck, limit, now=now):
            quota_tracker.touch(ip, ck, now=now)
            return ip
    return None


def effective_pool(service_pool, category_pool):
    """Пул сервиса: у сервиса > у категории > default."""
    return (service_pool or category_pool or DEFAULT_POOL).strip() or DEFAULT_POOL


# ------------------------------------------------ рендер nginx worker-конфигов


def _upstream_name(kind, pool_name):
    safe = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in pool_name)
    return "pereval_%s_pool_%s" % (kind, safe)


def _map_width(entries):
    return max((len("." + d) for d, _ in entries), default=10) + 2


def render_stream_workers(pools, healthy_by_pool, domain_pools, weights=None,
                          tls_port=443, header=""):
    """nginx-workers-stream.conf для Primary: upstream на пул + map SNI -> upstream.

    domain_pools: {domain: pool} только для доменов, чей пул отличается от default
    (остальные уходят в default через map default). Пул без нод берёт ноды по
    fallback-цепочке; если цепочка пуста — прямой выход на origin.
    """
    weights = weights or {}
    lines = [header] if header else []
    if not any(healthy_by_pool.get(p) for p in pools):
        lines.extend([
            "map $sni_allow_target $sni_upstream {",
            "    default           $sni_allow_target;",
            '    "__WORKERS__"     $ssl_preread_server_name:443;',
            "}",
            "",
        ])
        return "\n".join(lines)

    pool_targets = OrderedDict()
    for pname in pools:
        ips = candidates_for(pname, pools, healthy_by_pool)
        if not ips:
            pool_targets[pname] = "$ssl_preread_server_name:443"
            continue
        uname = _upstream_name("stream", pname)
        pool_targets[pname] = uname
        lines.append("upstream %s {" % uname)
        lines.append("    hash $pereval_client_subnet consistent;")
        for ip in ips:
            lines.append("    server %s:%d weight=%d max_fails=2 fail_timeout=10s;"
                         % (ip, tls_port, int(weights.get(ip) or 1)))
        lines.append("}")
        lines.append("")

    entries = [(d, p) for d, p in sorted(domain_pools.items()) if p != DEFAULT_POOL and p in pool_targets]
    width = _map_width(entries)
    lines.append("map $ssl_preread_server_name $sni_pool_upstream {")
    lines.append("    hostnames;")
    lines.append("    %-*s %s;" % (width, "default", pool_targets[DEFAULT_POOL]))
    for d, p in entries:
        lines.append("    %-*s %s;" % (width, "." + d, pool_targets[p]))
    lines.append("}")
    lines.append("")
    lines.extend([
        "map $sni_allow_target $sni_upstream {",
        '    "127.0.0.1:9"     127.0.0.1:9;',
        '    "127.0.0.1:8443"  127.0.0.1:8443;',
        "    default           $sni_pool_upstream;",
        '    "__WORKERS__"     $sni_pool_upstream;',
        "}",
        "",
    ])
    return "\n".join(lines)


def render_http_workers(pools, healthy_by_pool, domain_pools, weights=None,
                        http_port=80, header=""):
    """nginx-workers-http.conf для Primary: upstream на пул + map Host -> upstream."""
    weights = weights or {}
    lines = [header] if header else []
    if not any(healthy_by_pool.get(p) for p in pools):
        lines.extend([
            "map $http_allow_target $http_upstream {",
            "    default           $http_allow_target;",
            '    "__WORKERS__"     $host;',
            "}",
            "",
        ])
        return "\n".join(lines)

    pool_targets = OrderedDict()
    for pname in pools:
        ips = candidates_for(pname, pools, healthy_by_pool)
        if not ips:
            pool_targets[pname] = "$host"
            continue
        uname = _upstream_name("http", pname)
        pool_targets[pname] = uname
        lines.append("upstream %s {" % uname)
        lines.append("    hash $pereval_client_subnet consistent;")
        for ip in ips:
            lines.append("    server %s:%d weight=%d max_fails=2 fail_timeout=10s;"
                         % (ip, http_port, int(weights.get(ip) or 1)))
        lines.append("    keepalive 32;")
        lines.append("}")
        lines.append("")

    entries = [(d, p) for d, p in sorted(domain_pools.items()) if p != DEFAULT_POOL and p in pool_targets]
    width = _map_width(entries)
    lines.append("map $host $http_pool_upstream {")
    lines.append("    hostnames;")
    lines.append("    %-*s %s;" % (width, "default", pool_targets[DEFAULT_POOL]))
    for d, p in entries:
        lines.append("    %-*s %s;" % (width, "." + d, pool_targets[p]))
    lines.append("}")
    lines.append("")
    lines.extend([
        "map $http_allow_target $http_upstream {",
        '    ""                "";',
        "    default           $http_pool_upstream;",
        '    "__WORKERS__"     $http_pool_upstream;',
        "}",
        "",
    ])
    return "\n".join(lines)
