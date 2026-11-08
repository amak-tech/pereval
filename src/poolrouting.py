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

DEFAULT_POOL = "default"


def hrw_score(key, node_ip):
    """Детерминированный «вес» пары (ключ, нода) для rendezvous-хэша."""
    h = hashlib.blake2b(("%s\x00%s" % (key, node_ip)).encode("utf-8"), digest_size=8)
    return int.from_bytes(h.digest(), "big")


def rendezvous_pick(key, candidates):
    """Выбирает одну ноду из candidates по ключу. Пусто -> None."""
    best = None
    best_score = -1
    for ip in candidates:
        score = hrw_score(key, ip)
        if score > best_score or (score == best_score and (best is None or ip < best)):
            best, best_score = ip, score
    return best


def rendezvous_order(key, candidates):
    """Все ноды, отсортированные по убыванию веса (первая = выбранная)."""
    return sorted(candidates, key=lambda ip: (-hrw_score(key, ip), ip))


def normalize_pools(pools):
    """Приводит описание пулов к {name: {"fallback": str|None, "strict_allowlist": bool, "note": str}}.

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
            out[str(name)] = {
                "fallback": str(fb).strip() if fb else None,
                "strict_allowlist": bool(raw.get("strict_allowlist", False)),
                "note": str(raw.get("note") or ""),
            }
    if DEFAULT_POOL not in out:
        out[DEFAULT_POOL] = {"fallback": None, "strict_allowlist": False, "note": ""}
    return out


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
        lines.append("    least_conn;")
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
        lines.append("    least_conn;")
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
