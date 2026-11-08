#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Персональный DNS-сервер «Перевал Pro» (pereval-pro-dns.service).

Работает на DNS-ноде Pro от непривилегированного пользователя (pereval-dns) с
CAP_NET_BIND_SERVICE, в одном процессе и одном цикле asyncio. Только стандартная
библиотека Python 3.9+. Слушатели:
  * UDP и TCP :53 на публичном IP (--listen-ip) — классический DNS, подписчик
    опознаётся по IP-адресу источника (карта `ips` политики). TCP — по RFC 7766:
    2-байтовый префикс длины, конвейер нескольких запросов в одном соединении,
    ответы могут приходить не по порядку, таймаут простоя и лимит in-flight.
  * DoT :853 (--dot-port) — TLS терминирует сам демон (ssl.SSLContext из
    --cert/--key). Токен подписчика — первая метка SNI вида
    <token>.<pro_domain>; SNI нет или он чужой — REFUSED и закрытие соединения
    (fail closed). SIGHUP перечитывает сертификат без рестарта.
  * DoH на 127.0.0.1:8057 (--doh-listen) за nginx: nginx превращает
    https://<pro_domain>/dns/<token> в /dns-query + заголовки X-Pereval-Token и
    X-Real-IP. Нет/неизвестен токен — HTTP 403. Также GET /healthz и
    GET /metrics.json (только счётчики).

Политика доступа (tokens, ips, override воркеров) приходит из control plane по
long-poll GET /api/internal/v1/policy и кешируется в --policy-cache; каталог
доменов/пулов/воркеров — из pro-policy-map.json (генерируется generate.py).
Для домена из каталога подписчику в режиме proxy отдаётся синтезированная
A-запись с IP воркера его пула (rendezvous-хэш, poolrouting.pick), AAAA/HTTPS/
SVCB — пустой NOERROR (NODATA), всё остальное форвардится в локальный dnsmasq
(--upstream) через UdpDnsPool с TCP-fallback при TC.

Побочные эффекты: новые IP подписчиков немедленно уходят в control plane
(ACL для nftables на воркерах), активность — пачками раз в 5 секунд, с
хэшами IP (суточная соль), а не адресами. Имена запросов и IP клиентов в
логи не попадают — только счётчики.

Здоровье воркеров проверяется каждые 5 секунд (TLS ClientHello с SNI на :443 и
GET /healthz на :80, гистерезис 2/2); все воркеры мертвы — fail-open, считаем
живыми всех. Состояние пишется в --health-out (pro-health.json).
"""

import argparse
import asyncio
import json
import os
import re
import signal
import socket
import ssl
import sys
import time
from collections import OrderedDict
from pathlib import Path

# dnscommon.py, healthcheck.py и poolrouting.py лежат рядом (репозиторий) или в
# /usr/local/lib/pereval (сервер)
for _cand in (os.path.dirname(os.path.abspath(__file__)), "/usr/local/lib/pereval"):
    if _cand not in sys.path:
        sys.path.insert(0, _cand)
import dnscommon  # noqa: E402
import healthcheck  # noqa: E402
import poolrouting  # noqa: E402

LOG_PREFIX = "[pro-dns]"
TOKEN_RE = re.compile(r"^[a-z2-7]{20}$")
MODES = ("proxy", "plain", "deny")
NODATA_QTYPES = frozenset((dnscommon.QTYPE_AAAA, dnscommon.QTYPE_HTTPS, dnscommon.QTYPE_SVCB))
DEFAULT_QPS_LIMIT = 50
RATE_BURST_FACTOR = 2.0          # ёмкость token bucket = qps_limit * фактор
ACL_REPORT_INTERVAL = 600        # повторно сообщать IP подписчика не чаще раза в 10 минут
ACTIVITY_FLUSH_INTERVAL = 5.0
RECENT_WINDOW = 300              # «активные токены» в метриках — за последние 5 минут
POLICY_API = "/api/internal/v1/policy"
ACTIVITY_API = "/api/internal/v1/dns/activity"

# Решения по запросу (ключи счётчиков)
D_REFUSED = "refused"            # неизвестная личность / deny / битый запрос
D_RATELIMIT = "ratelimited"
D_SYNTH_A = "synth_a"            # подменённая A-запись воркера
D_NODATA = "nodata"              # AAAA/HTTPS/SVCB проксируемого домена
D_FORWARD = "forward"            # ушёл в upstream (dnsmasq)
D_FORMERR = "formerr"
D_DROP = "drop"


def log(msg: str):
    print("%s %s" % (LOG_PREFIX, msg), file=sys.stderr, flush=True)


def now_ts() -> float:
    return time.time()


def atomic_write_json(path: Path, obj) -> None:
    healthcheck.atomic_write_text(Path(path), json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def token_from_sni(server_name, pro_domain: str):
    """Токен из SNI «<token>.<pro_domain>». None, если SNI нет, домен чужой или токен
    не похож на 20 символов base32 (a-z, 2-7)."""
    if not server_name or not pro_domain:
        return None
    sni = str(server_name).strip().rstrip(".").lower()
    suffix = "." + pro_domain.strip().rstrip(".").lower()
    if not sni.endswith(suffix):
        return None
    label = sni[:-len(suffix)]
    if "." in label or not TOKEN_RE.match(label):
        return None
    return label


# =============================================================================
# Каталог доменов (pro-policy-map.json)
# =============================================================================


class PolicyMap:
    """Каталог: домены -> {service, category_id, tier, pool}, категории, пулы, воркеры."""

    def __init__(self, data: dict = None):
        data = data if isinstance(data, dict) else {}
        self.domain = str(data.get("domain") or "").strip().rstrip(".").lower()
        self.dns_ip = str(data.get("dns_ip") or "").strip()
        self.probe_sni = str(data.get("probe_sni") or self.domain or "").strip()
        self.pools = poolrouting.normalize_pools(data.get("pools") or {})
        self.workers = [
            dict(w) for w in (data.get("workers") or [])
            if isinstance(w, dict) and w.get("ip")
        ]
        self.categories = OrderedDict()
        for cat in data.get("categories") or []:
            if isinstance(cat, dict) and cat.get("id"):
                self.categories[str(cat["id"])] = cat
        self.domains = {}
        for dom, info in (data.get("domains") or {}).items():
            if not isinstance(info, dict):
                continue
            key = str(dom).strip().rstrip(".").lower()
            if not key:
                continue
            self.domains[key] = {
                "service": str(info.get("service") or key),
                "category_id": str(info.get("category_id") or ""),
                "tier": str(info.get("tier") or ""),
                "pool": str(info.get("pool") or poolrouting.DEFAULT_POOL),
            }

    @classmethod
    def load(cls, path) -> "PolicyMap":
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def match(self, qname: str):
        """Суффиксное совпадение: отбрасываем метки слева до первого попадания.
        Возвращает (домен_каталога, info) или (None, None)."""
        name = (qname or "").strip().rstrip(".").lower()
        if not name or not self.domains:
            return None, None
        labels = name.split(".")
        for i in range(len(labels) - 1):  # TLD в одиночку не проверяем
            cand = ".".join(labels[i:])
            info = self.domains.get(cand)
            if info is not None:
                return cand, info
        return None, None


# =============================================================================
# Политика доступа (control plane)
# =============================================================================


class Policy:
    """Снимок политики: tokens, ips, override воркеров, версия."""

    def __init__(self, version: int = 0, generated_at: str = "", tokens: dict = None,
                 ips: dict = None, workers=None, source: str = "none"):
        self.version = int(version or 0)
        self.generated_at = str(generated_at or "")
        self.tokens = tokens or {}
        self.ips = ips or {}
        self.workers = workers  # None -> воркеры из pro-policy-map.json
        self.source = source
        self.loaded_at = now_ts()

    @staticmethod
    def _norm_user(raw: dict, default_qps: int) -> dict:
        raw = raw if isinstance(raw, dict) else {}
        mode = str(raw.get("mode") or "proxy").strip().lower()
        if mode not in MODES:
            mode = "deny"
        disabled = raw.get("disabled_categories") or []
        if not isinstance(disabled, (list, tuple, set)):
            disabled = []
        try:
            qps = int(raw.get("qps_limit") or default_qps)
        except (TypeError, ValueError):
            qps = default_qps
        return {
            "user_id": str(raw.get("user_id") or ""),
            "mode": mode,
            "disabled_categories": frozenset(str(c) for c in disabled),
            "qps_limit": max(1, qps),
        }

    @classmethod
    def from_dict(cls, data: dict, source: str = "cp", default_qps: int = DEFAULT_QPS_LIMIT) -> "Policy":
        if not isinstance(data, dict):
            raise ValueError("policy must be a JSON object")
        tokens = {}
        for tok, raw in (data.get("tokens") or {}).items():
            key = str(tok).strip().lower()
            if not TOKEN_RE.match(key):
                continue
            tokens[key] = cls._norm_user(raw, default_qps)
        ips = {}
        for ip, raw in (data.get("ips") or {}).items():
            key = dnscommon.normalize_ip(ip)
            if key is None:
                continue
            ips[key] = cls._norm_user(raw, default_qps)
        workers = data.get("workers")
        if workers is not None:
            workers = [dict(w) for w in workers if isinstance(w, dict) and w.get("ip")] if isinstance(workers, list) else None
        return cls(data.get("version") or 0, data.get("generated_at") or "", tokens, ips, workers, source)

    def to_dict(self) -> dict:
        def _dump(u):
            return {
                "user_id": u["user_id"],
                "mode": u["mode"],
                "disabled_categories": sorted(u["disabled_categories"]),
                "qps_limit": u["qps_limit"],
            }
        return {
            "version": self.version,
            "generated_at": self.generated_at,
            "tokens": {k: _dump(v) for k, v in self.tokens.items()},
            "ips": {k: _dump(v) for k, v in self.ips.items()},
            "workers": self.workers,
        }


class Identity:
    """Кто спрашивает: kind = token | ip | none; key — токен или IP; user — запись
    политики (None, если неизвестен); client_ip — адрес клиента (для ACL)."""

    __slots__ = ("kind", "key", "user", "client_ip")

    def __init__(self, kind: str, key, user, client_ip):
        self.kind = kind
        self.key = key
        self.user = user
        self.client_ip = client_ip

    @property
    def token(self):
        return self.key if self.kind == "token" else None

    @property
    def known(self) -> bool:
        return self.user is not None

    @property
    def mode(self) -> str:
        return self.user["mode"] if self.user else "deny"


# =============================================================================
# Ограничитель скорости, измеритель QPS, здоровье воркеров
# =============================================================================


class TokenBucketLimiter:
    """Token bucket на ключ (токен или IP): refill = rate/с, ёмкость = rate * burst."""

    def __init__(self, burst_factor: float = RATE_BURST_FACTOR):
        self.burst_factor = max(1.0, float(burst_factor))
        self.buckets = {}  # key -> [tokens, last_ts]

    def allow(self, key: str, rate: float, now: float = None) -> bool:
        now = now_ts() if now is None else now
        rate = max(0.1, float(rate))
        cap = rate * self.burst_factor
        b = self.buckets.get(key)
        if b is None:
            self.buckets[key] = [cap - 1.0, now]
            return True
        tokens, last = b
        tokens = min(cap, tokens + (now - last) * rate)
        if tokens >= 1.0:
            b[0] = tokens - 1.0
            b[1] = now
            return True
        b[0] = tokens
        b[1] = now
        return False

    def prune(self, now: float = None, idle: float = 600.0) -> int:
        now = now_ts() if now is None else now
        stale = [k for k, b in self.buckets.items() if now - b[1] > idle]
        for k in stale:
            del self.buckets[k]
        return len(stale)


class QpsMeter:
    """Скользящее окно 60 секунд по секундным корзинам."""

    def __init__(self, window: int = 60):
        self.window = window
        self.slots = [0] * window
        self.stamps = [-1] * window
        self.total = 0

    def hit(self, now: float = None, n: int = 1):
        sec = int(now_ts() if now is None else now)
        idx = sec % self.window
        if self.stamps[idx] != sec:
            self.stamps[idx] = sec
            self.slots[idx] = 0
        self.slots[idx] += n
        self.total += n

    def qps(self, now: float = None) -> float:
        sec = int(now_ts() if now is None else now)
        acc = 0
        for i in range(self.window):
            if sec - self.stamps[i] < self.window and self.stamps[i] >= 0:
                acc += self.slots[i]
        return round(acc / float(self.window), 2)


class WorkerHealth:
    """Гистерезис UP/DOWN по воркерам и список живых."""

    def __init__(self, fail_threshold: int = 2, rise_threshold: int = 2):
        self.fail_threshold = max(1, fail_threshold)
        self.rise_threshold = max(1, rise_threshold)
        self.states = {}  # ip -> dict

    def update(self, ip: str, name: str, ok: bool, latency_ms: float, err, now: float):
        st = self.states.setdefault(ip, {
            "name": name, "healthy": True, "fails": 0, "rises": 0,
            "last_transition_ts": int(now), "last_error": None, "latency_ms": 0.0,
        })
        st["name"] = name
        st["latency_ms"] = round(latency_ms, 2)
        st["last_error"] = None if ok else err
        if ok:
            st["rises"] += 1
            st["fails"] = 0
            if not st["healthy"] and st["rises"] >= self.rise_threshold:
                st["healthy"] = True
                st["last_transition_ts"] = int(now)
                log("worker %s (%s) UP" % (name, ip))
        else:
            st["fails"] += 1
            st["rises"] = 0
            if st["healthy"] and st["fails"] >= self.fail_threshold:
                st["healthy"] = False
                st["last_transition_ts"] = int(now)
                log("worker %s (%s) DOWN: %s" % (name, ip, err))
        return st["healthy"]

    def forget_missing(self, keep_ips):
        for ip in list(self.states):
            if ip not in keep_ips:
                del self.states[ip]

    def is_healthy(self, ip: str) -> bool:
        st = self.states.get(ip)
        return True if st is None else bool(st["healthy"])


# =============================================================================
# Отчёты в control plane: ACL (новые IP) и активность (хэши IP)
# =============================================================================


class ActivityTracker:
    """Копит ACL-события и активность по (token, user_id, ip_hash) для POST в CP."""

    def __init__(self, salt_seed: str, max_ips_per_day: int = 20,
                 acl_interval: float = ACL_REPORT_INTERVAL, max_entries: int = 50000):
        self.salt_seed = salt_seed
        self.max_ips_per_day = max(1, int(max_ips_per_day))
        self.acl_interval = acl_interval
        self.max_entries = max_entries
        self.known_ips = {}        # (key, ip) -> last_reported_ts
        self.pending_acl = OrderedDict()  # (key, ip) -> {"ip","token","user_id"}
        self.activity = {}         # (token|None, user_id, ip_hash) -> [queries, first, last]
        self.token_ips = {}        # token -> set(ip_hash) за сутки UTC
        self.pending_alerts = OrderedDict()  # token -> alert dict
        self.alerted_counts = {}   # token -> последний count, о котором сообщали
        self.day = dnscommon.utc_day()
        # asyncio.Event создаётся уже внутри цикла (см. attach_loop): в Python 3.9
        # Event, созданный вне цикла, привязывается к другому loop.
        self.acl_event = None
        self.dropped = 0

    def attach_loop(self):
        """Создаёт событие «есть новые ACL» внутри работающего цикла asyncio."""
        if self.acl_event is None:
            self.acl_event = asyncio.Event()
            if self.pending_acl:
                self.acl_event.set()

    def _notify_acl(self):
        if self.acl_event is not None:
            self.acl_event.set()

    def _rotate_day(self, now: float):
        day = dnscommon.utc_day(now)
        if day != self.day:
            self.day = day
            self.token_ips.clear()
            self.alerted_counts.clear()

    def record(self, ident: Identity, now: float = None):
        """Учитывает один запрос известного подписчика."""
        if not ident.known:
            return
        now = now_ts() if now is None else now
        self._rotate_day(now)
        user = ident.user
        ip = ident.client_ip or ""
        token = ident.token
        ip_hash = dnscommon.hash_ip(ip, self.salt_seed, self.day) if ip else ""

        # ACL: только режим proxy — воркеры открывают порты 80/443 этому IP
        if user["mode"] == "proxy" and ip:
            k = (ident.key, ip)
            last = self.known_ips.get(k)
            if last is None or now - last >= self.acl_interval:
                self.known_ips[k] = now
                if k not in self.pending_acl:
                    self.pending_acl[k] = {"ip": ip, "token": token, "user_id": user["user_id"]}
                    self._notify_acl()

        # Активность: без IP, только хэш
        ak = (token, user["user_id"], ip_hash)
        ent = self.activity.get(ak)
        if ent is None:
            if len(self.activity) >= self.max_entries:
                self.dropped += 1
                return
            self.activity[ak] = [1, int(now), int(now)]
        else:
            ent[0] += 1
            ent[2] = int(now)

        # Слишком много разных IP у одного токена за сутки
        if token and ip_hash:
            s = self.token_ips.setdefault(token, set())
            if ip_hash not in s:
                s.add(ip_hash)
                cnt = len(s)
                if cnt > self.max_ips_per_day and self.alerted_counts.get(token) != cnt:
                    self.alerted_counts[token] = cnt
                    self.pending_alerts[token] = {
                        "type": "too_many_ips", "token": token,
                        "user_id": user["user_id"], "count": cnt,
                    }

    def prune_known_ips(self, now: float = None, ttl: float = 86400.0) -> int:
        now = now_ts() if now is None else now
        stale = [k for k, ts in self.known_ips.items() if now - ts > ttl]
        for k in stale:
            del self.known_ips[k]
        return len(stale)

    def has_pending(self) -> bool:
        return bool(self.pending_acl or self.activity or self.pending_alerts)

    def build_payload(self, node: str, health: dict, now: float = None) -> dict:
        """Снимает накопленное и формирует тело POST /dns/activity."""
        now = now_ts() if now is None else now
        acl = list(self.pending_acl.values())
        self.pending_acl = OrderedDict()
        if self.acl_event is not None:
            self.acl_event.clear()
        activity = []
        for (token, user_id, ip_hash), (q, first, last) in self.activity.items():
            activity.append({
                "token": token, "user_id": user_id, "ip_hash": ip_hash,
                "queries": q, "first_seen": first, "last_seen": last,
            })
        self.activity = {}
        alerts = list(self.pending_alerts.values())
        self.pending_alerts = OrderedDict()
        return {
            "node": node,
            "ts": int(now),
            "acl": acl,
            "activity": activity,
            "alerts": alerts,
            "health": health,
        }

    def requeue(self, payload: dict):
        """Возвращает неотправленное обратно (после ошибки POST)."""
        for ent in payload.get("acl") or []:
            k = (ent.get("token") or ent.get("ip"), ent.get("ip"))
            if k not in self.pending_acl:
                self.pending_acl[k] = ent
        if self.pending_acl:
            self._notify_acl()
        for ent in payload.get("activity") or []:
            ak = (ent.get("token"), ent.get("user_id"), ent.get("ip_hash"))
            cur = self.activity.get(ak)
            if cur is None:
                if len(self.activity) < self.max_entries:
                    self.activity[ak] = [ent["queries"], ent["first_seen"], ent["last_seen"]]
                else:
                    self.dropped += 1
            else:
                cur[0] += ent["queries"]
                cur[1] = min(cur[1], ent["first_seen"])
                cur[2] = max(cur[2], ent["last_seen"])
        for al in payload.get("alerts") or []:
            self.pending_alerts.setdefault(al.get("token"), al)


# =============================================================================
# Клиент control plane
# =============================================================================


class ControlPlane:
    """GET/POST JSON к control plane с Bearer-секретом."""

    def __init__(self, origin: str, secret: str, timeout: float = 15.0, ca_file: str = None):
        self.origin = origin.rstrip("/")
        self.secret = secret
        self.timeout = timeout
        self.ssl_context = None
        if self.origin.lower().startswith("https://"):
            self.ssl_context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()

    def _headers(self, extra: dict = None) -> dict:
        h = {"Authorization": "Bearer %s" % self.secret}
        if extra:
            h.update(extra)
        return h

    async def get_json(self, path: str, timeout: float = None):
        resp = await dnscommon.http_request(
            self.origin + path, "GET", headers=self._headers(),
            timeout=timeout or self.timeout, ssl_context=self.ssl_context,
        )
        return resp.status, _parse_json_body(resp)

    async def post_json(self, path: str, obj, timeout: float = None):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        resp = await dnscommon.http_request(
            self.origin + path, "POST", headers=self._headers({"Content-Type": "application/json"}),
            body=body, timeout=timeout or self.timeout, ssl_context=self.ssl_context,
        )
        return resp.status, _parse_json_body(resp)


def _parse_json_body(resp):
    if not resp.body:
        return None
    try:
        return json.loads(resp.body.decode("utf-8"))
    except Exception:
        return None


# =============================================================================
# Сам сервер
# =============================================================================


class ProDnsServer:
    """Состояние и логика демона: политика, маршрутизация, слушатели, фоновые циклы."""

    def __init__(self, args, policy_map: PolicyMap, policy: Policy):
        self.args = args
        self.policy_map = policy_map
        self.policy = policy
        self.pro_domain = (args.pro_domain or policy_map.domain or "").strip().rstrip(".").lower()
        self.probe_sni = policy_map.probe_sni or self.pro_domain
        self.started_at = now_ts()
        self.stop_event = None

        up_host, up_port = _split_hostport(args.upstream, 53)
        self.upstream = dnscommon.UdpDnsPool(up_host, up_port, pool_size=args.udp_pool, timeout=args.upstream_timeout)

        self.limiter = TokenBucketLimiter()
        self.qps = QpsMeter()
        self.counters = OrderedDict((k, 0) for k in (
            "queries", "udp", "tcp", "dot", "doh",
            D_SYNTH_A, D_NODATA, D_FORWARD, D_REFUSED, D_RATELIMIT, D_FORMERR, D_DROP,
            "unknown_identity", "deny_mode", "plain_mode", "proxy_mode",
            "upstream_errors", "dot_no_token", "doh_forbidden", "truncated_udp",
            "policy_updates", "policy_errors", "activity_posts", "activity_post_errors",
        ))
        self.recent_idents = {}  # key -> last_seen (для метрики активных токенов)

        salt_seed = "%s:%s" % (self.pro_domain or "pereval-pro", policy_map.dns_ip or args.listen_ip or "")
        self.tracker = ActivityTracker(salt_seed, max_ips_per_day=args.max_ips_per_day)

        self.health = WorkerHealth(args.fail_threshold, args.rise_threshold)
        self.healthy_by_pool = OrderedDict()
        self.all_worker_ips = []
        self.fail_open = False
        self.recompute_routing()

        self.cp = None
        if not args.no_cp:
            if not args.cp_origin or not args.node_secret:
                raise SystemExit("CP_ORIGIN и NODE_SECRET обязательны (или укажите --no-cp)")
            self.cp = ControlPlane(args.cp_origin, args.node_secret, timeout=args.cp_timeout, ca_file=args.cp_ca_file)

        self.tls_ctx = None       # актуальный контекст (переключается в sni_callback)
        self.listen_ctx = None    # контекст, с которым создан слушатель :853
        self.servers = []
        self.udp_transports = []
        self.tasks = []
        self.tcp_conn_sem = None  # создаётся внутри цикла

    # --------------------------------------------------------------- политика

    def workers(self) -> list:
        """Список воркеров: override из политики (если не null) или из каталога."""
        if self.policy.workers is not None:
            return self.policy.workers
        return self.policy_map.workers

    def recompute_routing(self):
        """Пересчитывает healthy_by_pool и список всех IP воркеров."""
        workers = self.workers()
        self.all_worker_ips = []
        for w in workers:
            ip = str(w.get("ip"))
            if ip not in self.all_worker_ips:
                self.all_worker_ips.append(ip)
        self.health.forget_missing(set(self.all_worker_ips))
        healthy = [w for w in workers if self.health.is_healthy(str(w.get("ip")))]
        self.fail_open = bool(workers) and not healthy
        if self.fail_open:
            healthy = list(workers)
        self.healthy_by_pool = poolrouting.workers_by_pool(healthy, self.policy_map.pools)

    def apply_policy(self, policy: Policy, persist: bool = True):
        prev_version = self.policy.version
        self.policy = policy
        self.recompute_routing()
        self.counters["policy_updates"] += 1
        if persist and self.args.policy_cache:
            try:
                atomic_write_json(self.args.policy_cache, policy.to_dict())
            except Exception as exc:
                log("warning: cannot write policy cache %s: %s" % (self.args.policy_cache, exc))
        log("policy v%d applied (%s): %d tokens, %d ips, workers override=%s (prev v%d)" % (
            policy.version, policy.source, len(policy.tokens), len(policy.ips),
            "yes" if policy.workers is not None else "no", prev_version))

    def reload_policy_map(self):
        try:
            self.policy_map = PolicyMap.load(self.args.policy_map)
            if not self.pro_domain:
                self.pro_domain = self.policy_map.domain
            self.probe_sni = self.policy_map.probe_sni or self.pro_domain
            self.recompute_routing()
            log("policy map reloaded: %d domains, %d workers" % (len(self.policy_map.domains), len(self.policy_map.workers)))
        except Exception as exc:
            log("warning: policy map reload failed, keeping previous: %s" % exc)

    # ------------------------------------------------------------- личности

    def identify_token(self, token, client_ip) -> Identity:
        tok = (token or "").strip().lower()
        if not TOKEN_RE.match(tok):
            return Identity("none", None, None, client_ip)
        return Identity("token", tok, self.policy.tokens.get(tok), client_ip)

    def identify_ip(self, client_ip) -> Identity:
        ip = dnscommon.normalize_ip(client_ip) if client_ip else None
        if ip is None:
            return Identity("none", None, None, None)
        return Identity("ip", ip, self.policy.ips.get(ip), ip)

    # ------------------------------------------------------------- решения

    def decide(self, q: dnscommon.Question, ident: Identity, now: float = None):
        """Чистая функция решения: (действие, детали). Действия: refused | ratelimited |
        forward | synth_a | nodata. Для synth_a детали = IP воркера (или None, если
        воркеров нет — тогда форвард)."""
        if not ident.known:
            return D_REFUSED, "unknown"
        mode = ident.mode
        if mode == "deny":
            return D_REFUSED, "deny"
        if not self.limiter.allow(ident.key, ident.user["qps_limit"], now):
            return D_RATELIMIT, None
        if mode == "plain":
            return D_FORWARD, "plain"
        # proxy
        if q.qclass != dnscommon.QCLASS_IN:
            return D_FORWARD, "class"
        dom, info = self.policy_map.match(q.qname)
        if info is None or info["category_id"] in ident.user["disabled_categories"]:
            return D_FORWARD, "nomatch" if info is None else "disabled"
        if q.qtype == dnscommon.QTYPE_A:
            ip = poolrouting.pick(info["service"], info["pool"], self.policy_map.pools,
                                  self.healthy_by_pool, last_resort=self.all_worker_ips)
            if ip is None:
                return D_FORWARD, "noworker"
            return D_SYNTH_A, ip
        if q.qtype in NODATA_QTYPES:
            return D_NODATA, dom
        return D_FORWARD, "qtype"

    async def forward(self, wire: bytes, tcp_fallback: bool) -> bytes:
        try:
            return await self.upstream.query(wire, tcp_fallback=tcp_fallback)
        except Exception:
            self.counters["upstream_errors"] += 1
            return dnscommon.build_servfail(wire)

    async def resolve(self, wire: bytes, ident: Identity, transport: str, tcp_fallback: bool = True):
        """Полный путь запроса: учёт, решение, ответ. None — молча отбросить."""
        now = now_ts()
        self.counters["queries"] += 1
        self.counters[transport] += 1
        self.qps.hit(now)
        if ident.known:
            self.recent_idents[ident.key] = now
            self.counters[ident.mode + "_mode"] += 1
        else:
            self.counters["unknown_identity"] += 1

        try:
            q = dnscommon.parse_question(wire)
        except ValueError:
            try:
                resp = dnscommon.build_header_only(wire, dnscommon.RCODE_FORMERR)
            except ValueError:
                self.counters[D_DROP] += 1
                return None
            self.counters[D_FORMERR] += 1
            return resp

        action, detail = self.decide(q, ident, now)
        self.counters[action] += 1
        if action in (D_REFUSED, D_RATELIMIT):
            return dnscommon.build_refused(wire)
        # дальше запрос легитимен — учитываем активность
        self.tracker.record(ident, now)
        if action == D_SYNTH_A:
            return dnscommon.build_response(
                wire, [dnscommon.a_record(q.qname, detail, self.args.answer_ttl)]
            )
        if action == D_NODATA:
            return dnscommon.build_nodata(wire)
        return await self.forward(wire, tcp_fallback)

    # ----------------------------------------------------------- UDP :53

    async def handle_udp(self, data: bytes, addr, transport):
        ident = self.identify_ip(addr[0])
        resp = await self.resolve(data, ident, "udp", tcp_fallback=False)
        if resp is None:
            return
        limit = dnscommon.MIN_UDP_PAYLOAD
        try:
            q = dnscommon.parse_question(data)
            if q.has_edns:
                limit = min(max(dnscommon.MIN_UDP_PAYLOAD, q.edns_payload), 4096)
        except ValueError:
            pass
        if len(resp) > limit:
            self.counters["truncated_udp"] += 1
            try:
                resp = dnscommon.build_truncated(data)
            except ValueError:
                return
        try:
            transport.sendto(resp, addr)
        except Exception:
            pass

    # ----------------------------------------------------------- TCP :53 / DoT :853

    async def _serve_stream(self, reader, writer, ident: Identity, transport: str):
        """Общий обработчик DNS-over-TCP (RFC 7766) и DoT: конвейер запросов, ответы
        не по порядку, лимит in-flight на соединение, таймаут простоя. Неопознанному
        клиенту отвечаем REFUSED на первый запрос и закрываем соединение."""
        args = self.args
        lock = asyncio.Lock()
        inflight = asyncio.Semaphore(args.tcp_max_inflight)
        pending = set()
        close_after_first = not ident.known

        async def one(msg: bytes):
            try:
                resp = await self.resolve(msg, ident, transport, tcp_fallback=True)
                if resp is None:
                    return
                async with lock:
                    writer.write(dnscommon.frame_tcp(resp))
                    await writer.drain()
            except Exception:
                pass
            finally:
                inflight.release()

        try:
            while True:
                try:
                    msg = await dnscommon.read_tcp_message(reader, args.tcp_idle_timeout)
                except (asyncio.TimeoutError, ValueError, ConnectionError):
                    break
                if msg is None:
                    break
                await inflight.acquire()
                task = asyncio.ensure_future(one(msg))
                pending.add(task)
                task.add_done_callback(pending.discard)
                if close_after_first:
                    await task
                    break
        except Exception:
            pass
        finally:
            if pending:
                try:
                    await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), timeout=args.upstream_timeout + 1)
                except Exception:
                    pass
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    def _peer_ip(self, writer):
        peer = writer.get_extra_info("peername")
        if not peer:
            return None
        return dnscommon.normalize_ip(peer[0])

    async def handle_tcp(self, reader, writer):
        if not await self._acquire_conn(writer):
            return
        try:
            ident = self.identify_ip(self._peer_ip(writer))
            await self._serve_stream(reader, writer, ident, "tcp")
        finally:
            self.tcp_conn_sem.release()

    async def handle_dot(self, reader, writer):
        if not await self._acquire_conn(writer):
            return
        try:
            sslobj = writer.get_extra_info("ssl_object")
            sni = getattr(sslobj, "pereval_sni", None) if sslobj is not None else None
            token = token_from_sni(sni, self.pro_domain)
            client_ip = self._peer_ip(writer)
            if token is None:
                self.counters["dot_no_token"] += 1
                ident = Identity("none", None, None, client_ip)
            else:
                ident = self.identify_token(token, client_ip)
            await self._serve_stream(reader, writer, ident, "dot")
        finally:
            self.tcp_conn_sem.release()

    async def _acquire_conn(self, writer) -> bool:
        if self.tcp_conn_sem.locked():
            try:
                writer.close()
            except Exception:
                pass
            return False
        await self.tcp_conn_sem.acquire()
        return True

    # ----------------------------------------------------------- TLS

    def _sni_callback(self, sslobj, server_name, _ctx):
        """Запоминает SNI на объекте соединения и переключает на актуальный контекст
        (после SIGHUP с новым сертификатом)."""
        try:
            sslobj.pereval_sni = server_name
            cur = self.tls_ctx
            if cur is not None and sslobj.context is not cur:
                sslobj.context = cur
        except Exception:
            pass
        return None

    def build_tls_context(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        if hasattr(ssl, "TLSVersion"):
            try:
                ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            except (ValueError, AttributeError):
                pass
        ctx.options |= getattr(ssl, "OP_NO_COMPRESSION", 0)
        ctx.load_cert_chain(self.args.cert, self.args.key)
        ctx.sni_callback = self._sni_callback
        return ctx

    def reload_tls(self):
        if not self.args.cert or not self.args.key:
            return
        try:
            new_ctx = self.build_tls_context()
        except Exception as exc:
            log("warning: TLS reload failed, keeping previous certificate: %s" % exc)
            return
        self.tls_ctx = new_ctx
        log("TLS certificate reloaded from %s" % self.args.cert)

    # ----------------------------------------------------------- DoH

    def doh_server(self):
        return ProDohServer(self)

    # ----------------------------------------------------------- метрики / здоровье

    def health_snapshot(self) -> dict:
        workers = []
        for w in self.workers():
            ip = str(w.get("ip"))
            st = self.health.states.get(ip) or {}
            workers.append(OrderedDict([
                ("ip", ip),
                ("name", str(w.get("name") or ip)),
                ("pools", [str(p) for p in (w.get("pools") or [poolrouting.DEFAULT_POOL])]),
                ("healthy", bool(st.get("healthy", True))),
                ("status", "up" if st.get("healthy", True) else "down"),
                ("latency_ms", st.get("latency_ms", 0.0)),
                ("consecutive_failures", st.get("fails", 0)),
                ("consecutive_successes", st.get("rises", 0)),
                ("last_transition_ts", st.get("last_transition_ts", int(self.started_at))),
                ("last_error", st.get("last_error")),
            ]))
        return OrderedDict([
            ("updated_at", int(now_ts())),
            ("domain", self.pro_domain),
            ("policy_version", self.policy.version),
            ("policy_source", self.policy.source),
            ("qps", self.qps.qps()),
            ("fail_open", self.fail_open),
            ("pools", OrderedDict((p, list(ips)) for p, ips in self.healthy_by_pool.items())),
            ("workers", workers),
        ])

    def cp_health(self) -> dict:
        """Короткий блок health для POST /dns/activity."""
        return {
            "policy_version": self.policy.version,
            "qps": self.qps.qps(),
            "workers": [{"ip": ip, "healthy": self.health.is_healthy(ip)} for ip in self.all_worker_ips],
        }

    def metrics(self) -> dict:
        now = now_ts()
        active = sum(1 for ts in self.recent_idents.values() if now - ts <= RECENT_WINDOW)
        return OrderedDict([
            ("uptime_s", int(now - self.started_at)),
            ("qps_1m", self.qps.qps(now)),
            ("queries_total", self.counters["queries"]),
            ("by_transport", OrderedDict((k, self.counters[k]) for k in ("udp", "tcp", "dot", "doh"))),
            ("by_mode", OrderedDict((k, self.counters[k + "_mode"]) for k in MODES)),
            ("by_decision", OrderedDict((k, self.counters[k]) for k in (
                D_SYNTH_A, D_NODATA, D_FORWARD, D_REFUSED, D_RATELIMIT, D_FORMERR, D_DROP))),
            ("unknown_identity", self.counters["unknown_identity"]),
            ("dot_no_token", self.counters["dot_no_token"]),
            ("doh_forbidden", self.counters["doh_forbidden"]),
            ("truncated_udp", self.counters["truncated_udp"]),
            ("upstream_errors", self.counters["upstream_errors"]),
            ("active_tokens_5m", active),
            ("policy", OrderedDict([
                ("version", self.policy.version),
                ("source", self.policy.source),
                ("generated_at", self.policy.generated_at),
                ("tokens", len(self.policy.tokens)),
                ("ips", len(self.policy.ips)),
                ("updates", self.counters["policy_updates"]),
                ("errors", self.counters["policy_errors"]),
            ])),
            ("activity", OrderedDict([
                ("posts", self.counters["activity_posts"]),
                ("post_errors", self.counters["activity_post_errors"]),
                ("pending_acl", len(self.tracker.pending_acl)),
                ("pending_activity", len(self.tracker.activity)),
                ("dropped", self.tracker.dropped),
            ])),
            ("workers", OrderedDict([
                ("total", len(self.all_worker_ips)),
                ("healthy", [ip for ip in self.all_worker_ips if self.health.is_healthy(ip)]),
                ("down", [ip for ip in self.all_worker_ips if not self.health.is_healthy(ip)]),
                ("fail_open", self.fail_open),
                ("pools", OrderedDict((p, list(ips)) for p, ips in self.healthy_by_pool.items())),
            ])),
            ("catalog_domains", len(self.policy_map.domains)),
        ])

    # ----------------------------------------------------------- фоновые циклы

    async def health_loop(self):
        args = self.args
        while not self.stop_event.is_set():
            try:
                await self.health_cycle()
            except Exception as exc:
                log("health cycle error: %s" % exc)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=args.health_interval)
            except asyncio.TimeoutError:
                pass

    async def health_cycle(self):
        args = self.args
        workers = self.workers()
        now = now_ts()

        async def probe(w):
            ip = str(w["ip"])
            tls_ok, tls_ms, tls_err = await healthcheck.probe_tls_sni(ip, args.worker_tls_port, self.probe_sni, args.probe_timeout, fallback_sni=None)
            http_ok, http_ms, http_err = await healthcheck.probe_http_healthz(ip, args.worker_http_port, self.pro_domain, args.probe_timeout)
            return ip, (tls_ok and http_ok), max(tls_ms, http_ms), (tls_err or http_err)

        if workers:
            results = await asyncio.gather(*(probe(w) for w in workers), return_exceptions=True)
            for w, res in zip(workers, results):
                ip = str(w["ip"])
                name = str(w.get("name") or ip)
                if isinstance(res, Exception):
                    self.health.update(ip, name, False, 0.0, "probe_error: %s" % res, now)
                else:
                    _ip, ok, ms, err = res
                    self.health.update(ip, name, ok, ms, err, now)
        self.recompute_routing()
        self.limiter.prune(now)
        self.tracker.prune_known_ips(now)
        for k in [k for k, ts in self.recent_idents.items() if now - ts > RECENT_WINDOW]:
            del self.recent_idents[k]
        if args.health_out:
            try:
                atomic_write_json(args.health_out, self.health_snapshot())
            except Exception as exc:
                log("warning: cannot write %s: %s" % (args.health_out, exc))

    async def policy_loop(self):
        """Long-poll политики: 200 -> применить и закешировать, 304 -> снова,
        ошибка -> backoff 1..30 с, продолжая обслуживать из памяти."""
        args = self.args
        backoff = 1.0
        last_err = None
        while not self.stop_event.is_set():
            path = "%s?version=%d&wait=%d" % (POLICY_API, self.policy.version, args.cp_wait)
            try:
                status, data = await self.cp.get_json(path, timeout=args.cp_wait + args.cp_timeout)
            except Exception as exc:
                status, data = None, None
                err = "%s: %s" % (type(exc).__name__, exc)
                if err != last_err:
                    log("policy poll error: %s (backoff %.0fs)" % (err, backoff))
                    last_err = err
            if status == 200 and isinstance(data, dict):
                backoff = 1.0
                last_err = None
                applied = False
                try:
                    pol = Policy.from_dict(data, source="cp", default_qps=args.default_qps)
                    if pol.version != self.policy.version or self.policy.source != "cp":
                        self.apply_policy(pol)
                        applied = True
                except Exception as exc:
                    self.counters["policy_errors"] += 1
                    log("policy parse error: %s" % exc)
                # защита от «горячего» цикла, если CP отвечает 200 вместо 304 на ту же версию
                await asyncio.sleep(0.2 if applied else 1.0)
                continue
            if status == 304:
                backoff = 1.0
                last_err = None
                continue
            if status is not None:
                self.counters["policy_errors"] += 1
                err = "HTTP %s" % status
                if err != last_err:
                    log("policy poll: unexpected %s (backoff %.0fs)" % (err, backoff))
                    last_err = err
            else:
                self.counters["policy_errors"] += 1
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(30.0, backoff * 2)

    async def activity_loop(self):
        """Раз в 5 с (или сразу при новом IP) отправляет ACL/активность/алерты."""
        args = self.args
        while not self.stop_event.is_set():
            waiter = asyncio.ensure_future(self.tracker.acl_event.wait())
            stopper = asyncio.ensure_future(self.stop_event.wait())
            try:
                await asyncio.wait({waiter, stopper}, timeout=ACTIVITY_FLUSH_INTERVAL,
                                   return_when=asyncio.FIRST_COMPLETED)
            finally:
                for f in (waiter, stopper):
                    if not f.done():
                        f.cancel()
            if self.stop_event.is_set():
                break
            await self.flush_activity()
        # финальная попытка при остановке
        if self.cp is not None and self.tracker.has_pending():
            try:
                await asyncio.wait_for(self.flush_activity(), timeout=args.cp_timeout)
            except Exception:
                pass

    async def flush_activity(self):
        if not self.tracker.has_pending():
            return
        payload = self.tracker.build_payload(self.args.node_name, self.cp_health())
        if self.cp is None:
            return  # dev-режим: ничего не отправляем
        try:
            status, _data = await self.cp.post_json(ACTIVITY_API, payload)
        except Exception as exc:
            status = None
            log("activity post error: %s: %s" % (type(exc).__name__, exc))
        if status == 200:
            self.counters["activity_posts"] += 1
        else:
            self.counters["activity_post_errors"] += 1
            if status is not None:
                log("activity post: HTTP %s" % status)
            self.tracker.requeue(payload)

    # ----------------------------------------------------------- запуск

    async def start(self):
        args = self.args
        loop = asyncio.get_running_loop()
        self.stop_event = asyncio.Event()
        self.tcp_conn_sem = asyncio.Semaphore(args.max_tcp_conns)
        self.tracker.attach_loop()
        await self.upstream.start()

        if args.listen_ip:
            udp_transport, _proto = await loop.create_datagram_endpoint(
                lambda: _UdpListener(self), local_addr=(args.listen_ip, args.port),
            )
            sock = udp_transport.get_extra_info("socket")
            if sock is not None:
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
                except OSError:
                    pass
            self.udp_transports.append(udp_transport)
            tcp_srv = await asyncio.start_server(
                self.handle_tcp, host=args.listen_ip, port=args.port,
                reuse_address=True, backlog=1024, limit=dnscommon.MAX_DNS_PACKET_LEN + 2,
            )
            self.servers.append(tcp_srv)
            log("listening DNS udp+tcp on %s:%d" % (args.listen_ip, args.port))

            have_cert = bool(args.cert and args.key and Path(args.cert).is_file() and Path(args.key).is_file())
            if args.dot_port and have_cert:
                self.tls_ctx = self.build_tls_context()
                self.listen_ctx = self.tls_ctx
                dot_srv = await asyncio.start_server(
                    self.handle_dot, host=args.listen_ip, port=args.dot_port, ssl=self.listen_ctx,
                    reuse_address=True, backlog=1024, limit=dnscommon.MAX_DNS_PACKET_LEN + 2,
                    ssl_handshake_timeout=args.tls_handshake_timeout,
                )
                self.servers.append(dot_srv)
                log("listening DoT on %s:%d (token = <token>.%s)" % (args.listen_ip, args.dot_port, self.pro_domain))
            elif args.dot_port:
                log("warning: DoT disabled: certificate %s / key %s not found" % (args.cert, args.key))

        if args.doh_listen:
            doh_host, doh_port = _split_hostport(args.doh_listen, 8057)
            doh = self.doh_server()
            doh_srv = await asyncio.start_server(
                doh.handle_client, host=doh_host, port=doh_port,
                reuse_address=True, backlog=1024, limit=dnscommon.MAX_HTTP_HEADER_BYTES * 2,
            )
            self.servers.append(doh_srv)
            log("listening DoH (plain HTTP behind nginx) on %s:%d" % (doh_host, doh_port))

        # Обработчики сигналов доступны только в главном потоке (в тестах цикл фоновый)
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self.stop_event.set)
            except (NotImplementedError, RuntimeError, ValueError):
                pass
        try:
            loop.add_signal_handler(signal.SIGHUP, self.reload)
        except (NotImplementedError, RuntimeError, ValueError, AttributeError):
            pass

        self.tasks.append(asyncio.ensure_future(self.health_loop()))
        if self.cp is not None:
            self.tasks.append(asyncio.ensure_future(self.policy_loop()))
        self.tasks.append(asyncio.ensure_future(self.activity_loop()))

    def reload(self):
        log("SIGHUP: reloading TLS certificate and policy map")
        self.reload_tls()
        self.reload_policy_map()
        if self.args.no_cp and self.args.policy_file:
            try:
                data = json.loads(Path(self.args.policy_file).read_text(encoding="utf-8"))
                self.apply_policy(Policy.from_dict(data, source="file", default_qps=self.args.default_qps), persist=False)
            except Exception as exc:
                log("warning: policy file reload failed: %s" % exc)

    async def serve_forever(self):
        await self.start()
        try:
            await self.stop_event.wait()
        finally:
            await self.shutdown()

    async def shutdown(self):
        for srv in self.servers:
            srv.close()
        for t in self.tasks:
            t.cancel()
        for srv in self.servers:
            try:
                await srv.wait_closed()
            except Exception:
                pass
        for tr in self.udp_transports:
            tr.close()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        self.upstream.close()
        log("stopped")


class _UdpListener(asyncio.DatagramProtocol):
    """UDP :53 — каждый датаграм в отдельной задаче (ограничено семафором)."""

    def __init__(self, server: ProDnsServer):
        self.server = server
        self.transport = None
        self.sem = asyncio.Semaphore(server.args.udp_max_inflight)

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        if len(data) < dnscommon.MIN_DNS_PACKET_LEN or len(data) > dnscommon.MAX_DNS_PACKET_LEN:
            return
        if self.sem.locked():
            self.server.counters[D_DROP] += 1
            return
        asyncio.ensure_future(self._handle(bytes(data), addr))

    async def _handle(self, data, addr):
        async with self.sem:
            try:
                await self.server.handle_udp(data, addr, self.transport)
            except Exception:
                pass

    def error_received(self, exc):
        pass


class ProDohServer(dnscommon.DohHttpServer):
    """DoH за nginx: токен из X-Pereval-Token, IP клиента из X-Real-IP, /metrics.json."""

    def __init__(self, server: ProDnsServer):
        super().__init__(dns_pool=None, endpoint_path="/dns-query", max_inflight=server.args.udp_max_inflight)
        self.server = server

    def _token(self, req) -> str:
        return (req.headers.get("x-pereval-token") or "").strip().lower()

    async def authorize(self, req):
        tok = self._token(req)
        if not TOKEN_RE.match(tok) or tok not in self.server.policy.tokens:
            self.server.counters["doh_forbidden"] += 1
            return 403, b"Forbidden\n"
        return None

    async def resolve(self, wire_query, req):
        client_ip = dnscommon.normalize_ip(req.headers.get("x-real-ip") or "")
        if client_ip is None and req.peer:
            client_ip = dnscommon.normalize_ip(req.peer[0])
        ident = self.server.identify_token(self._token(req), client_ip)
        resp = await self.server.resolve(wire_query, ident, "doh", tcp_fallback=True)
        if resp is None:
            raise ValueError("malformed DNS query")
        return resp

    async def handle_other(self, writer, req):
        if req.path == "/metrics.json" and req.method in ("GET", "HEAD"):
            await self.send_json(writer, 200, self.server.metrics(), keep_alive=req.keep_alive)
            return req.keep_alive
        return await super().handle_other(writer, req)


# =============================================================================
# CLI
# =============================================================================


def _split_hostport(value: str, default_port: int):
    value = (value or "").strip()
    if value.startswith("["):
        host, _sep, rest = value[1:].partition("]")
        port = int(rest[1:]) if rest.startswith(":") and rest[1:] else default_port
        return host, port
    if value.count(":") == 1:
        host, port = value.split(":", 1)
        return host, int(port) if port else default_port
    return value, default_port


def _env(name: str, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Персональный DNS-сервер «Перевал Pro»: UDP/TCP 53, DoT 853 и DoH за nginx "
                    "с подменой A-записей каталога на IP воркеров по политике control plane.",
    )
    g = p.add_argument_group("слушатели")
    g.add_argument("--listen-ip", default=_env("PRO_DNS_IP"),
                   help="публичный IP для UDP/TCP 53 и DoT (env PRO_DNS_IP; пусто — не слушать 53/853)")
    g.add_argument("--port", type=int, default=53, help="порт классического DNS (по умолчанию 53)")
    g.add_argument("--dot-port", type=int, default=853, help="порт DNS-over-TLS (по умолчанию 853; 0 — выключить)")
    g.add_argument("--cert", default=_env("PRO_DNS_CERT", "/etc/pereval/ssl/fullchain.pem"),
                   help="цепочка сертификатов для DoT (по умолчанию /etc/pereval/ssl/fullchain.pem)")
    g.add_argument("--key", default=_env("PRO_DNS_KEY", "/etc/pereval/ssl/privkey.pem"),
                   help="закрытый ключ для DoT (по умолчанию /etc/pereval/ssl/privkey.pem)")
    g.add_argument("--doh-listen", default="127.0.0.1:8057",
                   help="адрес:порт DoH по обычному HTTP за nginx (по умолчанию 127.0.0.1:8057; пусто — выключить)")
    g.add_argument("--pro-domain", default=_env("PRO_DOMAIN"),
                   help="домен Pro для токена в SNI <token>.<domain> (env PRO_DOMAIN; иначе из policy map)")

    g = p.add_argument_group("политика и control plane")
    g.add_argument("--policy-map", default="/etc/pereval/pro-policy-map.json",
                   help="pro-policy-map.json из generate.py (перечитывается по SIGHUP)")
    g.add_argument("--policy-cache", default="/var/lib/pereval-pro-dns/policy-cache.json",
                   help="кеш последней политики от control plane (пусто — не кешировать)")
    g.add_argument("--cp-origin", default=_env("CP_ORIGIN"), help="origin control plane (env CP_ORIGIN)")
    g.add_argument("--node-secret", default=_env("NODE_SECRET"), help="Bearer-секрет узла (env NODE_SECRET)")
    g.add_argument("--cp-wait", type=int, default=25, help="wait для long-poll политики в секундах (по умолчанию 25)")
    g.add_argument("--cp-timeout", type=float, default=15.0, help="таймаут HTTP к control plane сверх wait (по умолчанию 15)")
    g.add_argument("--cp-ca-file", default=_env("CP_CA_FILE"), help="свой CA для HTTPS к control plane (необязательно)")
    g.add_argument("--node-name", default=_env("NODE_NAME", "pro-dns"), help="имя узла в отчётах (по умолчанию pro-dns)")
    g.add_argument("--no-cp", action="store_true",
                   help="dev-режим: без control plane, политика из --policy-file или кеша")
    g.add_argument("--policy-file", default=None,
                   help="локальный JSON политики в формате ответа /api/internal/v1/policy (с --no-cp)")

    g = p.add_argument_group("разрешение имён")
    g.add_argument("--upstream", default="127.0.0.1:53", help="upstream DNS (локальный dnsmasq, по умолчанию 127.0.0.1:53)")
    g.add_argument("--upstream-timeout", type=float, default=2.5, help="таймаут ответа upstream в секундах (по умолчанию 2.5)")
    g.add_argument("--udp-pool", type=int, default=16, help="размер пула UDP-сокетов к upstream (по умолчанию 16)")
    g.add_argument("--answer-ttl", type=int, default=60, help="TTL синтезированных A-записей (по умолчанию 60)")
    g.add_argument("--default-qps", type=int, default=DEFAULT_QPS_LIMIT,
                   help="лимит запросов в секунду на токен/IP, если политика не задала (по умолчанию 50)")
    g.add_argument("--max-ips-per-day", type=int, default=20,
                   help="порог разных IP у токена за сутки UTC для алерта too_many_ips (по умолчанию 20)")

    g = p.add_argument_group("лимиты соединений")
    g.add_argument("--tcp-idle-timeout", type=float, default=20.0, help="таймаут простоя TCP/DoT соединения (по умолчанию 20 с)")
    g.add_argument("--tcp-max-inflight", type=int, default=64, help="максимум запросов в обработке на одно TCP/DoT соединение (по умолчанию 64)")
    g.add_argument("--max-tcp-conns", type=int, default=4000, help="максимум одновременных TCP/DoT соединений (по умолчанию 4000)")
    g.add_argument("--udp-max-inflight", type=int, default=4096, help="максимум одновременных UDP/DoH запросов (по умолчанию 4096)")
    g.add_argument("--tls-handshake-timeout", type=float, default=10.0, help="таймаут TLS-рукопожатия DoT (по умолчанию 10 с)")

    g = p.add_argument_group("здоровье воркеров")
    g.add_argument("--health-interval", type=float, default=5.0, help="интервал проверки воркеров (по умолчанию 5 с)")
    g.add_argument("--probe-timeout", type=float, default=3.0, help="таймаут одной пробы (по умолчанию 3 с)")
    g.add_argument("--fail-threshold", type=int, default=2, help="ошибок подряд до DOWN (по умолчанию 2)")
    g.add_argument("--rise-threshold", type=int, default=2, help="успехов подряд до UP (по умолчанию 2)")
    g.add_argument("--worker-tls-port", type=int, default=443, help="порт TLS-прокси воркеров (по умолчанию 443)")
    g.add_argument("--worker-http-port", type=int, default=80, help="порт HTTP-прокси воркеров (по умолчанию 80)")
    g.add_argument("--health-out", default="/var/www/pereval-pro/pro-health.json",
                   help="куда писать pro-health.json (пусто — не писать)")
    return p.parse_args(argv)


def load_initial_policy(args) -> Policy:
    """Политика на старте: --policy-file (dev) -> кеш -> пустая."""
    if args.policy_file:
        try:
            data = json.loads(Path(args.policy_file).read_text(encoding="utf-8"))
            pol = Policy.from_dict(data, source="file", default_qps=args.default_qps)
            log("policy loaded from file %s (v%d, %d tokens, %d ips)" % (args.policy_file, pol.version, len(pol.tokens), len(pol.ips)))
            return pol
        except Exception as exc:
            log("warning: cannot load policy file %s: %s" % (args.policy_file, exc))
    if args.policy_cache and Path(args.policy_cache).is_file():
        try:
            data = json.loads(Path(args.policy_cache).read_text(encoding="utf-8"))
            pol = Policy.from_dict(data, source="cache", default_qps=args.default_qps)
            log("policy loaded from cache %s (v%d, %d tokens, %d ips)" % (args.policy_cache, pol.version, len(pol.tokens), len(pol.ips)))
            return pol
        except Exception as exc:
            log("warning: cannot load policy cache %s: %s" % (args.policy_cache, exc))
    log("starting with empty policy (everything REFUSED until control plane answers)")
    return Policy(source="none")


def build_server(args) -> ProDnsServer:
    try:
        policy_map = PolicyMap.load(args.policy_map)
        log("policy map %s: %d domains, %d pools, %d workers" % (
            args.policy_map, len(policy_map.domains), len(policy_map.pools), len(policy_map.workers)))
    except Exception as exc:
        log("warning: cannot load policy map %s: %s — serving without catalog" % (args.policy_map, exc))
        policy_map = PolicyMap({})
    policy = load_initial_policy(args)
    return ProDnsServer(args, policy_map, policy)


def main(argv=None) -> int:
    args = parse_args(argv)
    if not args.listen_ip and not args.doh_listen:
        print("%s nothing to listen on: give --listen-ip (PRO_DNS_IP) and/or --doh-listen" % LOG_PREFIX, file=sys.stderr)
        return 2
    server = build_server(args)
    try:
        asyncio.run(server.serve_forever())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
