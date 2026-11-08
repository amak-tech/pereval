#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает конфигурационные файлы в build/ из services.yaml и шаблонов,
а также экспортирует каталог сервисов для веб-приложения (web/).

    python3 src/generate.py services.yaml 153.80.200.170

Ни строчки конфигов здесь нет — всё лежит в templates/. Скрипт читает данные,
собирает фрагменты и подставляет их в шаблоны на месте {{имя}}. Двойные скобки
не конфликтуют ни с $переменными nginx, ни с {} в JSON.

Структура YAML (сокращённо):

    meta:
      name: Перевал
      origin: https://pereval.top          # сайт и личный кабинет
    free:
      domain: free.pereval.top             # DoH/DoT бесплатной версии
      legacy_domains: [pereval.portbuddy.tech]
    nodes:                                  # кластер Free
      primary: 153.80.200.170
      pools: {default: {}, ai: {fallback: default}}
      workers: [{ip: 1.2.3.4, name: w1, pools: [ai, default]}]
    dnsmasq_options: [...]
    categories:                             # Free-каталог
      - id: ai
        name: ИИ и языковые модели
        pool: ai                            # пул по умолчанию для категории
        services:
          - name: Anthropic / Claude
            pool: ai                        # необязательно, переопределяет категорию
            domains: [claude.ai, anthropic.com]
    disabled: [...]
    passthrough: {note: ..., domains: [...]}
    pro:                                    # инфраструктура и каталог Pro
      domain: pro.pereval.top
      dns_ip: 203.0.113.10
      pools: {...}
      workers: [...]
      categories: [...]                     # как categories (+ id, pool)

Требуется PyYAML:  pip3 install pyyaml   (в Debian/Ubuntu: apt install python3-yaml)
Совместимо с Python 3.9+.
"""

import argparse
import ipaddress
import json
import re
import sys
from collections import OrderedDict
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import poolrouting  # noqa: E402

try:
    import yaml
except ImportError:
    sys.exit("нужен PyYAML: pip3 install pyyaml   "
             "(Debian/Ubuntu: sudo apt install python3-yaml)")

DOMAIN_RE = re.compile(r'^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$')
IPISH_RE = re.compile(r'^\d{1,3}(\.\d{1,3}){3}$')
ENV_VAR_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
SLUG_RE = re.compile(r'^[a-z0-9_]{2,24}$')
PLACEHOLDER_RE = re.compile(r'\{\{\s*(\w+)\s*\}\}')
PLACEHOLDER_NET = ipaddress.ip_network("203.0.113.0/24")  # TEST-NET-3: адреса-заглушки

# (шаблон, имя файла в build/, вариант значений: None = Free, "pro" = каталог Free+Pro)
TEMPLATES = [
    ("dnsmasq/dnsmasq.conf", "dnsmasq-geoblock.conf", None),
    ("nginx/nginx.conf", "nginx.conf", None),
    ("nginx/nginx-sni-allow.map", "nginx-sni-allow.map", None),
    ("nginx/nginx-host-allow.map", "nginx-host-allow.map", None),
    ("nginx/nginx-workers-stream.conf", "nginx-workers-stream.conf", None),
    ("nginx/nginx-workers-http.conf", "nginx-workers-http.conf", None),
]
PRO_TEMPLATES = [
    ("nginx/pro-dns-nginx.conf", "pro-dns-nginx.conf", "pro"),
    ("nginx/pro-worker-nginx.conf", "pro-worker-nginx.conf", "pro"),
    ("nginx/nginx-sni-allow.map", "pro-nginx-sni-allow.map", "pro"),
    ("nginx/nginx-host-allow.map", "pro-nginx-host-allow.map", "pro"),
    ("dnsmasq/cache-dnsmasq.conf", "cache-dnsmasq.conf", "pro"),
]
SERVICES_JSON_DEFAULT = Path("web") / "src" / "generated" / "services.json"


# --------------------------------------------------------------------- модель


class Pool:
    def __init__(self, name, note="", fallback=None, strict_allowlist=False):
        self.name = name
        self.note = note
        self.fallback = fallback
        self.strict_allowlist = strict_allowlist

    def as_dict(self):
        return OrderedDict([
            ("note", self.note),
            ("fallback", self.fallback),
            ("strict_allowlist", bool(self.strict_allowlist)),
        ])


class WorkerNode:
    def __init__(self, ip, name="", weight=1, pools=None, ssh_user=None, ssh_user_env=None,
                 ssh_key=None, ssh_key_env=None, ssh_port=None):
        self.ip = ip
        self.name = name
        self.weight = weight
        self.pools = list(pools or [poolrouting.DEFAULT_POOL])
        self.ssh_user = ssh_user
        self.ssh_user_env = ssh_user_env
        self.ssh_key = ssh_key
        self.ssh_key_env = ssh_key_env
        self.ssh_port = ssh_port

    def as_dict(self, idx=1, with_ssh=True):
        d = OrderedDict([
            ("ip", self.ip),
            ("name", self.name or "worker-%d" % idx),
            ("weight", self.weight),
            ("pools", list(self.pools)),
        ])
        if with_ssh:
            d["ssh_user"] = self.ssh_user
            d["ssh_user_env"] = self.ssh_user_env
            d["ssh_key"] = self.ssh_key
            d["ssh_key_env"] = self.ssh_key_env
            d["ssh_port"] = self.ssh_port
        return d


class Cluster:
    """Набор воркеров с пулами — общий для Free (nodes) и Pro (pro)."""

    def __init__(self):
        self.pools = OrderedDict([(poolrouting.DEFAULT_POOL, Pool(poolrouting.DEFAULT_POOL))])
        self.workers = []

    def pools_dict(self):
        return poolrouting.normalize_pools(OrderedDict((n, p.as_dict()) for n, p in self.pools.items()))

    def workers_by_pool(self, extra_ips=None):
        return poolrouting.workers_by_pool([w.as_dict(with_ssh=False) for w in self.workers],
                                           self.pools_dict(), extra_ips=extra_ips)

    def weights(self):
        return {w.ip: w.weight for w in self.workers}


class NodesConfig(Cluster):
    def __init__(self):
        super().__init__()
        self.primary = None
        self.include_primary_in_dns = False
        self.probe_sni = "claude.ai"


class ProConfig(Cluster):
    def __init__(self):
        super().__init__()
        self.enabled = False
        self.domain = None
        self.dns_ip = None
        self.cp_ip = None
        self.categories = []


class FreeConfig:
    def __init__(self):
        self.domain = None
        self.legacy_domains = []


class Service:
    def __init__(self, name, pool=None):
        self.name = name
        self.pool = pool
        self.domains = []


class Category:
    def __init__(self, cid, name, pool=None, tier="free"):
        self.id = cid
        self.name = name
        self.pool = pool
        self.tier = tier
        self.services = []

    @property
    def count(self):
        return sum(len(s.domains) for s in self.services)


class Group:
    def __init__(self, name):
        self.name = name
        self.note = ""
        self.domains = []


class Doc:
    def __init__(self):
        self.meta = OrderedDict()
        self.free = FreeConfig()
        self.nodes = NodesConfig()
        self.pro = ProConfig()
        self.dnsmasq_options = []
        self.categories = []
        self.disabled = []
        self.passthrough = Group("passthrough")

    @property
    def total(self):
        return sum(c.count for c in self.categories)

    def active(self, categories=None):
        """(домен, категория, сервис) для каждого активного домена."""
        for c in (categories if categories is not None else self.categories):
            for s in c.services:
                for d in s.domains:
                    yield d, c, s

    def all_categories(self):
        return list(self.categories) + list(self.pro.categories)

    def active_workers(self, primary_ip=None):
        """Воркеры Free, исключая совпадающие с primary_ip."""
        eff_primary = primary_ip or self.nodes.primary
        return [w for w in self.nodes.workers if w.ip != eff_primary]

    def free_healthy_by_pool(self, primary_ip):
        """{pool: [ip]} для Free при условии, что все воркеры живы (для сборки)."""
        workers = self.active_workers(primary_ip)
        if not workers:
            pools = self.nodes.pools_dict()
            return OrderedDict((p, [primary_ip]) for p in pools)
        extra = [primary_ip] if (self.nodes.include_primary_in_dns and primary_ip) else None
        return poolrouting.workers_by_pool([w.as_dict(with_ssh=False) for w in workers],
                                           self.nodes.pools_dict(), extra_ips=extra)


def effective_pool(category, service):
    return poolrouting.effective_pool(service.pool, category.pool)


# -------------------------------------------------------------------- парсер


class ParseError(Exception):
    pass


def _need(obj, key, where, kind):
    """Достаёт obj[key] с проверкой типа. Ошибка указывает, где именно сломалось."""
    if not isinstance(obj, dict):
        raise ParseError("%s: ожидался словарь, а не %s" % (where, type(obj).__name__))
    if key not in obj:
        raise ParseError("%s: не хватает поля «%s»" % (where, key))
    val = obj[key]
    if not isinstance(val, kind):
        want = "строка" if kind is str else ("словарь" if kind is dict else "список")
        raise ParseError("%s: поле «%s» должно быть %s, а не %s"
                         % (where, key, want, type(val).__name__))
    return val


def _domains(raw, where):
    out = []
    for i, d in enumerate(raw):
        if not isinstance(d, str):
            raise ParseError("%s: домен #%d — не строка, а %s (%r). "
                             "Домены вида 1.1.1.1 нужно брать в кавычки"
                             % (where, i + 1, type(d).__name__, d))
        out.append(d.strip().lower())
    return out


def _opt_str(obj, key, where):
    if key not in obj or obj[key] is None:
        return None
    val = obj[key]
    if not isinstance(val, str):
        raise ParseError("%s: поле «%s» должно быть строкой, а не %s" % (where, key, type(val).__name__))
    s = val.strip()
    return s if s else None


def _opt_int(obj, key, where, default=None):
    if key not in obj or obj[key] is None:
        return default
    val = obj[key]
    if isinstance(val, bool) or not isinstance(val, int):
        raise ParseError("%s: поле «%s» должно быть целым числом, а не %s" % (where, key, type(val).__name__))
    return val


def _opt_bool(obj, key, where, default=False):
    if key not in obj or obj[key] is None:
        return default
    val = obj[key]
    if not isinstance(val, bool):
        raise ParseError("%s: поле «%s» должно быть булевым значением" % (where, key))
    return val


def _slugify(text):
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s[:24] or "cat"


def parse_workers_arg(raw_workers, pools):
    """Разбирает CLI-аргумент --workers ip1,ip2 (или name=ip:weight); воркеры попадают во все пулы."""
    workers = []
    for idx, item in enumerate(raw_workers.split(","), 1):
        token = item.strip()
        if not token:
            continue
        name = "worker-%d" % idx
        weight = 1
        if "=" in token:
            name_part, token = token.split("=", 1)
            name = name_part.strip() or name
        if ":" in token:
            ip_part, weight_part = token.rsplit(":", 1)
            ip_str = ip_part.strip()
            try:
                weight = int(weight_part.strip())
            except ValueError:
                raise ParseError("--workers: некорректный вес «%s» для «%s»" % (weight_part, ip_str))
        else:
            ip_str = token.strip()
        workers.append(WorkerNode(ip=ip_str, name=name, weight=weight, pools=list(pools)))
    return workers


def _parse_pools(raw, where, cluster):
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise ParseError("%s: pools должен быть словарём {имя: {...}}" % where)
    for name, praw in raw.items():
        pname = str(name).strip()
        praw = praw or {}
        if not isinstance(praw, dict):
            raise ParseError("%s: pools.%s должен быть словарём" % (where, pname))
        cluster.pools[pname] = Pool(
            pname,
            note=str(praw.get("note") or "").strip(),
            fallback=_opt_str(praw, "fallback", "%s: pools.%s" % (where, pname)),
            strict_allowlist=_opt_bool(praw, "strict_allowlist", "%s: pools.%s" % (where, pname)),
        )
    if poolrouting.DEFAULT_POOL not in cluster.pools:
        cluster.pools[poolrouting.DEFAULT_POOL] = Pool(poolrouting.DEFAULT_POOL)


def _parse_workers(raw, where, cluster):
    if raw is None:
        return
    if not isinstance(raw, list):
        raise ParseError("%s: workers должен быть списком" % where)
    for wi, wraw in enumerate(raw, 1):
        wwhere = "%s: workers[%d]" % (where, wi)
        if isinstance(wraw, str):
            cluster.workers.append(WorkerNode(ip=wraw.strip(), name="worker-%d" % wi))
        elif isinstance(wraw, dict):
            wip = _need(wraw, "ip", wwhere, str).strip()
            wname = _opt_str(wraw, "name", wwhere) or "worker-%d" % wi
            wweight = _opt_int(wraw, "weight", wwhere, default=1)
            wpools = wraw.get("pools")
            if wpools is None:
                wpools = [poolrouting.DEFAULT_POOL]
            elif isinstance(wpools, str):
                wpools = [wpools]
            elif not isinstance(wpools, list):
                raise ParseError("%s: pools должен быть списком имён пулов" % wwhere)
            cluster.workers.append(WorkerNode(
                ip=wip, name=wname, weight=wweight,
                pools=[str(p).strip() for p in wpools if str(p).strip()],
                ssh_user=_opt_str(wraw, "ssh_user", wwhere),
                ssh_user_env=_opt_str(wraw, "ssh_user_env", wwhere),
                ssh_key=_opt_str(wraw, "ssh_key", wwhere),
                ssh_key_env=_opt_str(wraw, "ssh_key_env", wwhere),
                ssh_port=_opt_int(wraw, "ssh_port", wwhere, default=None),
            ))
        else:
            raise ParseError("%s: ожидался словарь или строка с IP" % wwhere)


def _parse_categories(raw, where, tier):
    if not isinstance(raw, list) or not raw:
        raise ParseError("%s: categories должен быть непустым списком" % where)
    out = []
    for ci, craw in enumerate(raw, 1):
        cwhere = "%s: categories[%d]" % (where, ci)
        cname = _need(craw, "name", cwhere, str).strip()
        cid = _opt_str(craw, "id", cwhere) or _slugify(cname)
        cat = Category(cid, cname, pool=_opt_str(craw, "pool", cwhere), tier=tier)
        for si, sraw in enumerate(_need(craw, "services", "categories «%s»" % cname, list), 1):
            swhere = "categories «%s» / services[%d]" % (cname, si)
            sname = _need(sraw, "name", swhere, str).strip()
            svc = Service(sname, pool=_opt_str(sraw, "pool", swhere))
            svc.domains = _domains(_need(sraw, "domains", "сервис «%s»" % sname, list),
                                   "сервис «%s»" % sname)
            cat.services.append(svc)
        out.append(cat)
    return out


def parse(path):
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ParseError("%s: не разобрался YAML — %s" % (path, exc))
    if not isinstance(data, dict):
        raise ParseError("%s: на верхнем уровне ожидался словарь с ключами meta / categories" % path)

    doc = Doc()

    meta = data.get("meta") or {}
    if not isinstance(meta, dict):
        raise ParseError("%s: meta должен быть словарём" % path)
    for k, v in meta.items():
        doc.meta[str(k)] = "" if v is None else str(v)

    free_raw = data.get("free")
    if free_raw is not None:
        if not isinstance(free_raw, dict):
            raise ParseError("%s: free должен быть словарём" % path)
        doc.free.domain = (_opt_str(free_raw, "domain", "%s: free" % path) or "").lower() or None
        legacy = free_raw.get("legacy_domains") or []
        if isinstance(legacy, str):
            legacy = [legacy]
        if not isinstance(legacy, list):
            raise ParseError("%s: free.legacy_domains должен быть списком" % path)
        doc.free.legacy_domains = [str(d).strip().lower() for d in legacy if str(d).strip()]

    nodes_raw = data.get("nodes")
    if nodes_raw is not None:
        where = "%s: nodes" % path
        if not isinstance(nodes_raw, dict):
            raise ParseError("%s должен быть словарём" % where)
        if nodes_raw.get("primary") is not None:
            doc.nodes.primary = str(nodes_raw["primary"]).strip()
        doc.nodes.include_primary_in_dns = _opt_bool(nodes_raw, "include_primary_in_dns", where)
        probe_sni = _opt_str(nodes_raw, "probe_sni", where)
        if probe_sni:
            doc.nodes.probe_sni = probe_sni.lower()
        _parse_pools(nodes_raw.get("pools"), where, doc.nodes)
        _parse_workers(nodes_raw.get("workers"), where, doc.nodes)

    opts = data.get("dnsmasq_options") or []
    if not isinstance(opts, list):
        raise ParseError("%s: dnsmasq_options должен быть списком строк" % path)
    doc.dnsmasq_options = [str(o).strip() for o in opts if str(o).strip()]

    doc.categories = _parse_categories(data.get("categories"), path, "free")

    for gi, graw in enumerate(data.get("disabled") or [], 1):
        where = "%s: disabled[%d]" % (path, gi)
        g = Group(_need(graw, "name", where, str).strip())
        g.note = str(graw.get("note") or "").strip()
        g.domains = _domains(_need(graw, "domains", where, list), where)
        doc.disabled.append(g)

    pt = data.get("passthrough") or {}
    if pt:
        if not isinstance(pt, dict):
            raise ParseError("%s: passthrough должен быть словарём с note и domains" % path)
        doc.passthrough.note = str(pt.get("note") or "").strip()
        doc.passthrough.domains = _domains(pt.get("domains") or [], "%s: passthrough" % path)

    pro_raw = data.get("pro")
    if pro_raw is not None:
        where = "%s: pro" % path
        if not isinstance(pro_raw, dict):
            raise ParseError("%s должен быть словарём" % where)
        doc.pro.enabled = True
        doc.pro.domain = (_need(pro_raw, "domain", where, str).strip().lower())
        doc.pro.dns_ip = _need(pro_raw, "dns_ip", where, str).strip()
        doc.pro.cp_ip = _opt_str(pro_raw, "cp_ip", where)
        _parse_pools(pro_raw.get("pools"), where, doc.pro)
        _parse_workers(_need(pro_raw, "workers", where, list), where, doc.pro)
        doc.pro.categories = _parse_categories(pro_raw.get("categories"), where, "pro")

    return doc


# ---------------------------------------------------------------- валидация


def _validate_env_ref(val, field_name, worker_name, errors):
    var_name = val[2:-1] if (val.startswith("${") and val.endswith("}")) else val[1:]
    if not ENV_VAR_RE.match(var_name):
        errors.append("некорректное имя переменной окружения в %s=«%s» у воркера «%s»"
                      % (field_name, val, worker_name))


def _is_placeholder_ip(ip):
    try:
        return ipaddress.IPv4Address(ip) in PLACEHOLDER_NET
    except ipaddress.AddressValueError:
        return False


def _validate_cluster(cluster, label, forbidden_ips, errors, warnings):
    """Проверяет воркеры и пулы одного кластера (Free или Pro)."""
    pools = cluster.pools
    seen_worker_ips = set()
    for w in cluster.workers:
        try:
            ipaddress.IPv4Address(w.ip)
        except ipaddress.AddressValueError:
            errors.append("%s: некорректный IPv4-адрес воркера «%s»: «%s»" % (label, w.name, w.ip))
        if w.ip in forbidden_ips:
            errors.append("%s: IP воркера «%s» (%s) совпадает с другим узлом кластера" % (label, w.name, w.ip))
        if w.ip in seen_worker_ips:
            errors.append("%s: дублирующийся IP воркера: %s" % (label, w.ip))
        seen_worker_ips.add(w.ip)
        if _is_placeholder_ip(w.ip):
            warnings.append("%s: IP воркера «%s» (%s) — адрес-заглушка из 203.0.113.0/24, замените на настоящий"
                            % (label, w.name, w.ip))
        if w.weight < 1:
            errors.append("%s: вес (weight) воркера «%s» (%s) должен быть >= 1" % (label, w.name, w.ip))
        if not w.pools:
            errors.append("%s: у воркера «%s» пустой список pools" % (label, w.name))
        for pname in w.pools:
            if pname not in pools:
                errors.append("%s: воркер «%s» ссылается на неизвестный пул «%s»" % (label, w.name, pname))
        if w.ssh_port is not None and not (1 <= w.ssh_port <= 65535):
            errors.append("%s: некорректный ssh_port у воркера «%s»: %s" % (label, w.name, w.ssh_port))
        for fname, fval in (("ssh_user_env", w.ssh_user_env), ("ssh_key_env", w.ssh_key_env)):
            if fval is not None and not ENV_VAR_RE.match(fval):
                errors.append("%s: некорректное имя переменной окружения %s=«%s» у воркера «%s»"
                              % (label, fname, fval, w.name))
        if w.ssh_user is not None and w.ssh_user.startswith("$"):
            _validate_env_ref(w.ssh_user, "ssh_user", w.name, errors)
        if w.ssh_key is not None:
            if "-----BEGIN" in w.ssh_key or "\n" in w.ssh_key:
                errors.append("%s: воркер «%s»: нельзя хранить приватный SSH-ключ в services.yaml; "
                              "используйте ssh_key_env или путь к файлу" % (label, w.name))
            elif w.ssh_key.startswith("$"):
                _validate_env_ref(w.ssh_key, "ssh_key", w.name, errors)

    for pname, pool in pools.items():
        if not SLUG_RE.match(pname):
            errors.append("%s: имя пула «%s» должно соответствовать %s" % (label, pname, SLUG_RE.pattern))
        if pool.fallback and pool.fallback not in pools:
            errors.append("%s: пул «%s» ссылается на неизвестный fallback «%s»" % (label, pname, pool.fallback))
        # цикл fallback
        seen, cur = set(), pname
        while cur:
            if cur in seen:
                errors.append("%s: цикл fallback среди пулов начиная с «%s»" % (label, pname))
                break
            seen.add(cur)
            nxt = pools.get(cur)
            cur = nxt.fallback if nxt else None
    if cluster.workers:
        by_pool = cluster.workers_by_pool()
        for pname in pools:
            if not by_pool.get(pname):
                errors.append("%s: в пуле «%s» нет ни одного воркера" % (label, pname))


def _validate_categories(categories, pools, label, errors, warnings, seen):
    """Проверяет домены/пулы категорий; seen — общий словарь домен -> «кат / сервис»."""
    ids = set()
    for c in categories:
        if not SLUG_RE.match(c.id):
            errors.append("%s: id категории «%s» («%s») должен соответствовать %s"
                          % (label, c.id, c.name, SLUG_RE.pattern))
        if c.id in ids:
            errors.append("%s: id категории «%s» встречается дважды" % (label, c.id))
        ids.add(c.id)
        if c.pool and c.pool not in pools:
            errors.append("%s: категория «%s» ссылается на неизвестный пул «%s»" % (label, c.name, c.pool))
        if not c.services:
            warnings.append("%s: категория «%s» пуста" % (label, c.name))
        names = [s.name for s in c.services]
        for n in sorted(set(n for n in names if names.count(n) > 1)):
            warnings.append("%s: в категории «%s» два сервиса с именем «%s»" % (label, c.name, n))
        for s in c.services:
            if s.pool and s.pool not in pools:
                errors.append("%s: сервис «%s / %s» ссылается на неизвестный пул «%s»"
                              % (label, c.name, s.name, s.pool))
            if not s.domains:
                warnings.append("%s: сервис «%s / %s» без доменов" % (label, c.name, s.name))
            for d in s.domains:
                if not DOMAIN_RE.match(d):
                    errors.append("некорректный домен «%s» (%s / %s)" % (d, c.name, s.name))
                elif IPISH_RE.match(d):
                    warnings.append("«%s» похож на IP-адрес, а не на домен (%s / %s)" % (d, c.name, s.name))
                if d in seen:
                    errors.append("домен %s указан дважды: «%s» и «%s / %s»" % (d, seen[d], c.name, s.name))
                else:
                    seen[d] = "%s / %s" % (c.name, s.name)
    return ids


def validate(doc, primary_ip=None):
    errors, warnings = [], []

    if doc.nodes.primary:
        try:
            ipaddress.IPv4Address(doc.nodes.primary)
        except ipaddress.AddressValueError:
            errors.append("некорректный IPv4-адрес nodes.primary: «%s»" % doc.nodes.primary)

    if doc.nodes.probe_sni and not DOMAIN_RE.match(doc.nodes.probe_sni):
        errors.append("некорректный домен nodes.probe_sni: «%s»" % doc.nodes.probe_sni)

    try:
        extract_domain(doc)
    except ParseError as exc:
        errors.append(str(exc))
    for d in doc.free.legacy_domains:
        if not DOMAIN_RE.match(d):
            errors.append("некорректный домен в free.legacy_domains: «%s»" % d)

    primary_ips = set(p for p in (doc.nodes.primary, primary_ip) if p)
    _validate_cluster(doc.nodes, "nodes", primary_ips, errors, warnings)

    seen = {}
    free_ids = _validate_categories(doc.categories, doc.nodes.pools, "categories", errors, warnings, seen)

    if doc.pro.enabled:
        if not DOMAIN_RE.match(doc.pro.domain or ""):
            errors.append("некорректный домен pro.domain: «%s»" % doc.pro.domain)
        for ip_label, ip_val in (("pro.dns_ip", doc.pro.dns_ip), ("pro.cp_ip", doc.pro.cp_ip)):
            if ip_val is None:
                continue
            try:
                ipaddress.IPv4Address(ip_val)
            except ipaddress.AddressValueError:
                errors.append("некорректный IPv4-адрес %s: «%s»" % (ip_label, ip_val))
            else:
                if _is_placeholder_ip(ip_val):
                    warnings.append("%s = %s — адрес-заглушка из 203.0.113.0/24, замените на настоящий"
                                    % (ip_label, ip_val))
        if not doc.pro.workers:
            errors.append("pro.workers должен содержать хотя бы один воркер")
        forbidden = set(primary_ips)
        forbidden.update(w.ip for w in doc.nodes.workers)
        if doc.pro.dns_ip:
            forbidden.add(doc.pro.dns_ip)
        _validate_cluster(doc.pro, "pro", forbidden, errors, warnings)
        pro_ids = _validate_categories(doc.pro.categories, doc.pro.pools, "pro.categories", errors, warnings, seen)
        for cid in sorted(free_ids & pro_ids):
            errors.append("id категории «%s» используется и в categories, и в pro.categories" % cid)

    pt = set(doc.passthrough.domains)
    for d in sorted(set(seen) & pt):
        errors.append("домен %s есть и в каталоге, и в passthrough — уберите его из одного из списков" % d)

    dis = {d: g.name for g in doc.disabled for d in g.domains}
    for d in sorted(set(seen) & set(dis)):
        warnings.append("домен %s активен, но также перечислен в disabled «%s» — эта строка ни на что не влияет"
                        % (d, dis[d]))

    # поддомен, уже покрытый родительской записью
    parents = sorted(seen, key=len)
    for d in sorted(seen):
        for p in parents:
            if p != d and d.endswith("." + p):
                warnings.append("домен %s уже покрыт записью %s — строку можно удалить" % (d, p))
                break

    return errors, warnings


# ---------------------------------------------------- фрагменты для dnsmasq


def wrap_comment(text, width=76):
    out, line = [], "#"
    for word in text.split():
        if len(line) + 1 + len(word) > width:
            out.append(line)
            line = "#"
        line += " " + word
    if line.strip("# "):
        out.append(line)
    return "\n".join(out)


def conf_body(doc, ip):
    """address=/домен/IP для Free: IP выбирается пулом сервиса (rendezvous-хэш)."""
    pools = doc.nodes.pools_dict()
    by_pool = doc.free_healthy_by_pool(ip)
    out = []
    for i, c in enumerate(doc.categories, 1):
        out.append("#" + "=" * 78)
        out.append("# %d. %s (%d)" % (i, c.name.upper(), c.count))
        out.append("#" + "=" * 78)
        for s in c.services:
            pool = effective_pool(c, s)
            node_ip = poolrouting.pick(s.name, pool, pools, by_pool, last_resort=[ip])
            out.append("")
            out.append("# --- %s [pool: %s] ---" % (s.name, pool))
            for d in s.domains:
                out.append("address=/%s/%s" % (d, node_ip))
        out.append("")
    return "\n".join(out)


def conf_disabled(doc, ip):
    pools = doc.nodes.pools_dict()
    by_pool = doc.free_healthy_by_pool(ip)
    out = []
    for g in doc.disabled:
        out.append("#" + "=" * 78)
        out.append("# ОТКЛЮЧЕНО: %s" % g.name.upper())
        out.append("#" + "=" * 78)
        if g.note:
            out.append(wrap_comment(g.note))
        out.append("")
        node_ip = poolrouting.pick(g.name, poolrouting.DEFAULT_POOL, pools, by_pool, last_resort=[ip])
        for d in g.domains:
            out.append("#address=/%s/%s" % (d, node_ip))
        out.append("")
    return "\n".join(out)


def map_entries(categories, value):
    """Ключи для map в nginx: только активные домены, по одному на строку."""
    width = max((len(d) for c in categories for s in c.services for d in s.domains), default=0) + 2
    out = []
    for i, c in enumerate(categories, 1):
        out.append("# %d. %s" % (i, c.name))
        for svc in c.services:
            out.append("#   %s [pool: %s]" % (svc.name, effective_pool(c, svc)))
            for d in svc.domains:
                out.append("%-*s %s;" % (width, "." + d, value))
        out.append("")
    return "\n".join(out)


def map_entries_for_pool(categories, value, pool_name):
    """То же, но только домены, чей сервис маршрутизируется в указанный пул."""
    subset = []
    for c in categories:
        services = [s for s in c.services if effective_pool(c, s) == pool_name]
        if services:
            cc = Category(c.id, c.name, pool=c.pool, tier=c.tier)
            cc.services = services
            subset.append(cc)
    return map_entries(subset, value)


def domain_pools(categories):
    """{домен: пул} для всех активных доменов."""
    out = OrderedDict()
    for c in categories:
        for s in c.services:
            pool = effective_pool(c, s)
            for d in s.domains:
                out[d] = pool
    return out


def service_map_json(doc, categories=None):
    """{домен: {service, category, category_id, tier, pool}} для статистики и healthcheck."""
    mapping = OrderedDict()
    for d, c, s in doc.active(categories):
        mapping[d] = OrderedDict([
            ("service", s.name),
            ("category", c.name),
            ("category_id", c.id),
            ("tier", c.tier),
            ("pool", effective_pool(c, s)),
        ])
    return json.dumps(mapping, ensure_ascii=False, indent=2) + "\n"


def cluster_nodes_json(doc, primary_ip):
    """JSON-описание кластера Free для healthcheck.py и deploy.sh."""
    domain = extract_domain(doc)
    payload = OrderedDict([
        ("primary", primary_ip),
        ("domain", domain),
        ("free_domains", free_domains(doc)),
        ("site_origin", doc.meta.get("origin", "").rstrip("/")),
        ("include_primary_in_dns", bool(doc.nodes.include_primary_in_dns)),
        ("probe_sni", doc.nodes.probe_sni or "claude.ai"),
        ("pools", OrderedDict((n, p.as_dict()) for n, p in doc.nodes.pools.items())),
        ("workers", [w.as_dict(idx) for idx, w in enumerate(doc.active_workers(primary_ip), 1)]),
    ])
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def pro_nodes_json(doc):
    payload = OrderedDict([
        ("domain", doc.pro.domain),
        ("dns_ip", doc.pro.dns_ip),
        ("cp_ip", doc.pro.cp_ip),
        ("site_origin", doc.meta.get("origin", "").rstrip("/")),
        ("probe_sni", doc.nodes.probe_sni or "claude.ai"),
        ("pools", OrderedDict((n, p.as_dict()) for n, p in doc.pro.pools.items())),
        ("workers", [w.as_dict(idx) for idx, w in enumerate(doc.pro.workers, 1)]),
    ])
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def pro_policy_map_json(doc):
    """Карта доменов и пулов для pro_dns.py (каталог Free + Pro)."""
    cats = doc.all_categories()
    domains = OrderedDict()
    for d, c, s in doc.active(cats):
        domains[d] = OrderedDict([
            ("service", s.name),
            ("category_id", c.id),
            ("tier", c.tier),
            ("pool", effective_pool(c, s)),
        ])
    payload = OrderedDict([
        ("domain", doc.pro.domain),
        ("dns_ip", doc.pro.dns_ip),
        ("probe_sni", doc.nodes.probe_sni or "claude.ai"),
        ("pools", OrderedDict((n, p.as_dict()) for n, p in doc.pro.pools.items())),
        ("workers", [w.as_dict(idx, with_ssh=False) for idx, w in enumerate(doc.pro.workers, 1)]),
        ("categories", [
            OrderedDict([
                ("id", c.id), ("name", c.name), ("tier", c.tier),
                ("pool", c.pool or poolrouting.DEFAULT_POOL),
                ("service_count", len(c.services)), ("domain_count", c.count),
            ]) for c in cats
        ]),
        ("domains", domains),
    ])
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def services_json(doc, primary_ip):
    """Каталог для веб-приложения (web/src/generated/services.json). Без даты —
    файл коммитится, и его свежесть проверяется в CI."""
    free_domain = extract_domain(doc)

    def cat_dict(c):
        return OrderedDict([
            ("id", c.id), ("name", c.name), ("tier", c.tier),
            ("pool", c.pool or poolrouting.DEFAULT_POOL),
            ("services", [
                OrderedDict([
                    ("name", s.name),
                    ("pool", effective_pool(c, s)),
                    ("domains", list(s.domains)),
                ]) for s in c.services
            ]),
        ])

    def pools_dict(cluster):
        return OrderedDict((n, p.as_dict()) for n, p in cluster.pools.items())

    pro = None
    if doc.pro.enabled:
        pro = OrderedDict([
            ("domain", doc.pro.domain),
            ("dns_ip", doc.pro.dns_ip),
            ("doh_url_template", "https://%s/dns/{token}" % doc.pro.domain),
            ("dot_host_template", "{token}.%s" % doc.pro.domain),
            ("pools", pools_dict(doc.pro)),
            ("workers", [w.as_dict(idx, with_ssh=False) for idx, w in enumerate(doc.pro.workers, 1)]),
        ])
    payload = OrderedDict([
        ("meta", OrderedDict([
            ("name", doc.meta.get("name", "")),
            ("origin", doc.meta.get("origin", "").rstrip("/")),
        ])),
        ("free", OrderedDict([
            ("domain", free_domain),
            ("legacy_domains", list(doc.free.legacy_domains)),
            ("dns_ip", primary_ip),
            ("doh_url", "https://%s/dns-query" % free_domain),
            ("dot_host", free_domain),
            ("pools", pools_dict(doc.nodes)),
            ("workers", [w.as_dict(idx, with_ssh=False) for idx, w in enumerate(doc.active_workers(primary_ip), 1)]),
        ])),
        ("pro", pro),
        ("categories", [cat_dict(c) for c in doc.all_categories()]),
        ("disabled", [OrderedDict([("name", g.name), ("note", g.note), ("domains", list(g.domains))])
                      for g in doc.disabled]),
        ("passthrough", OrderedDict([("note", doc.passthrough.note),
                                     ("domains", sorted(set(doc.passthrough.domains)))])),
        ("counts", OrderedDict([
            ("free_categories", len(doc.categories)),
            ("free_services", sum(len(c.services) for c in doc.categories)),
            ("free_domains", doc.total),
            ("pro_categories", len(doc.pro.categories)),
            ("pro_services", sum(len(c.services) for c in doc.pro.categories)),
            ("pro_domains", sum(c.count for c in doc.pro.categories)),
        ])),
    ])
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


# ----------------------------------------------------------------- рендеринг


def substitute(text, values, where):
    """Подставляет {{имя}}. Про опечатку в имени сообщает с номером строки."""
    missing = []

    def repl(m):
        key = m.group(1)
        if key not in values:
            line = text.count("\n", 0, m.start()) + 1
            missing.append((line, key))
            return m.group(0)
        return values[key]

    out = PLACEHOLDER_RE.sub(repl, text)
    if missing:
        first = ", ".join("строка %d: {{%s}}" % (ln, k) for ln, k in missing[:5])
        raise ParseError("%s: в шаблоне есть подстановки, которых скрипт не готовит — %s. "
                         "Доступны: %s" % (where, first, ", ".join(sorted(values))))
    return out


def extract_domain(doc):
    """Домен DNS бесплатной версии: free.domain, иначе meta.domain, иначе хост meta.origin."""
    raw = (doc.free.domain or doc.meta.get("domain") or "").strip().lower()
    if not raw:
        origin = (doc.meta.get("origin") or "").strip()
        if "://" in origin:
            raw = (urlparse(origin).hostname or "").strip().lower()
        else:
            raw = origin.split("/")[0].split(":")[0].strip().lower()
    if not raw or not DOMAIN_RE.match(raw):
        raise ParseError("не удалось определить корректный DNS-домен из free.domain / meta.origin "
                         "(получено: %r); укажите free.domain в YAML или --domain" % raw)
    return raw


def site_domain(doc):
    origin = (doc.meta.get("origin") or "").strip()
    host = (urlparse(origin).hostname or "").strip().lower() if "://" in origin else origin.split("/")[0]
    return host


def free_domains(doc):
    """Все имена, по которым доступен Free DNS: основное, затем legacy."""
    main = extract_domain(doc)
    out = [main]
    for d in doc.free.legacy_domains:
        if d not in out:
            out.append(d)
    return out


def resolve_template_path(templates_dir, tpl_name):
    """Находит шаблон по относительному пути в templates/ (с фолбэком на плоский каталог)."""
    candidate = templates_dir / tpl_name
    if candidate.is_file():
        return candidate
    flat = templates_dir / Path(tpl_name).name
    if flat.is_file():
        return flat
    matches = list(templates_dir.rglob(Path(tpl_name).name))
    if matches:
        return matches[0]
    return candidate


def build_values(doc, ip, source):
    """Все подстановки: скаляры из данных плюс собранные фрагменты (вариант Free)."""
    domain = extract_domain(doc)
    fdomains = free_domains(doc)
    dt = doc.meta.get("date") or date.today().isoformat()
    pools = doc.nodes.pools_dict()
    by_pool = doc.free_healthy_by_pool(ip)
    dpools = domain_pools(doc.categories)
    pro_domain = doc.pro.domain or "pro.%s" % site_domain(doc)
    values = {
        "name": doc.meta.get("name", ""),
        "ip": ip,
        "origin": doc.meta.get("origin", "").rstrip("/"),
        "site_domain": site_domain(doc),
        "domain": domain,
        "free_domain": domain,
        "free_domains": " ".join(fdomains),
        "free_server_names": " ".join(fdomains),
        "free_sni_targets": "\n".join("        %-32s 127.0.0.1:8443;" % d for d in fdomains),
        "certbot_domains": " ".join("-d %s" % d for d in fdomains),
        "pro_domain": pro_domain,
        "pro_dns_ip": doc.pro.dns_ip or "",
        "cp_ip": doc.pro.cp_ip or "",
        "date": dt,
        "source": source,
        "total": str(doc.total),
        "category_count": str(len(doc.categories)),
        "service_count": str(sum(len(c.services) for c in doc.categories)),
        "options": "\n".join(doc.dnsmasq_options),
        "body": conf_body(doc, ip),
        "disabled": conf_disabled(doc, ip),
        "passthrough_note": wrap_comment(doc.passthrough.note),
        "passthrough": "\n".join("# passthrough: %s" % d for d in sorted(set(doc.passthrough.domains))),
        "sni_entries": map_entries(doc.categories, "$ssl_preread_server_name:443"),
        "host_entries": map_entries(doc.categories, "$host"),
        "workers_stream_body": poolrouting.render_stream_workers(
            pools, by_pool if doc.active_workers(ip) else {}, dpools, weights=doc.nodes.weights()),
        "workers_http_body": poolrouting.render_http_workers(
            pools, by_pool if doc.active_workers(ip) else {}, dpools, weights=doc.nodes.weights()),
        "service_map_json": service_map_json(doc),
        "cluster_nodes_json": cluster_nodes_json(doc, ip),
    }
    return values


def pro_values(doc, base):
    """Переопределения для шаблонов Pro: каталог Free + Pro, узлы Pro."""
    cats = doc.all_categories()
    pro_workers_ips = [w.ip for w in doc.pro.workers]
    v = dict(base)
    v.update({
        "total": str(sum(c.count for c in cats)),
        "category_count": str(len(cats)),
        "service_count": str(sum(len(c.services) for c in cats)),
        "sni_entries": map_entries(cats, "$ssl_preread_server_name:443"),
        "host_entries": map_entries(cats, "$host"),
        "pro_worker_ips": " ".join(pro_workers_ips),
        "pro_worker_ips_nft": ", ".join(pro_workers_ips),
        "trusted_probe_ips_nft": ", ".join(ipx for ipx in [doc.pro.dns_ip, doc.pro.cp_ip, doc.nodes.primary] if ipx),
    })
    return v


def render(templates_dir, tpl_name, values):
    path = resolve_template_path(templates_dir, tpl_name)
    if not path.is_file():
        raise ParseError("шаблон не найден: %s" % path)
    return substitute(path.read_text(encoding="utf-8"), values, str(path))


def strict_pool_maps(doc, cluster, categories, prefix):
    """Карты allowlist для пулов со strict_allowlist: только домены их сервисов."""
    out = []
    for pname, pool in cluster.pools.items():
        if not pool.strict_allowlist:
            continue
        out.append(("%snginx-sni-allow.%s.map" % (prefix, pname),
                    "# allowlist только для пула «%s»\n\n" % pname
                    + map_entries_for_pool(categories, "$ssl_preread_server_name:443", pname)))
        out.append(("%snginx-host-allow.%s.map" % (prefix, pname),
                    "# allowlist только для пула «%s»\n\n" % pname
                    + map_entries_for_pool(categories, "$host", pname)))
    return out


# --------------------------------------------------------------------- CLI


def plural_errors(n):
    if n % 10 == 1 and n % 100 != 11:
        return "ошибка"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return "ошибки"
    return "ошибок"


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Собирает конфиги dnsmasq/nginx и каталог сервисов из YAML и шаблонов.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Примеры:\n"
               "  python3 src/generate.py services.yaml 153.80.200.170\n"
               "  python3 src/generate.py services.yaml 153.80.200.170 --check\n")
    p.add_argument("services", help="путь к YAML с категориями, сервисами и доменами")
    p.add_argument("ip", nargs="?", default=None,
                   help="IPv4-адрес основного узла Free (по умолчанию берётся из nodes.primary)")
    p.add_argument("-t", "--templates", default=None,
                   help="каталог с шаблонами (по умолчанию templates/ в корне проекта)")
    p.add_argument("-o", "--out-dir", default=None,
                   help="каталог для сгенерированных файлов (по умолчанию build/ в корне проекта)")
    p.add_argument("--services-json", default=None,
                   help="куда писать каталог для веб-приложения (по умолчанию web/src/generated/services.json)")
    p.add_argument("--no-services-json", action="store_true",
                   help="не записывать и не проверять services.json")
    p.add_argument("--name", help="название сервиса (переопределяет meta.name)")
    p.add_argument("--origin", help="адрес сайта (переопределяет meta.origin)")
    p.add_argument("--domain", help="домен Free DNS (переопределяет free.domain)")
    p.add_argument("--date", help="дата обновления YYYY-MM-DD (переопределяет meta.date)")
    p.add_argument("--workers", default=None,
                   help="список IP воркеров Free через запятую (переопределяет nodes.workers; попадают во все пулы)")
    p.add_argument("--include-primary-in-dns", action="store_true",
                   help="включать основной IP в ответы dnsmasq наравне с воркерами")
    p.add_argument("--check", action="store_true",
                   help="только проверить данные, шаблоны и свежесть services.json, ничего не записывать")
    p.add_argument("-q", "--quiet", action="store_true", help="не печатать предупреждения")
    a = p.parse_args(argv)

    src = Path(a.services)
    if not src.is_file():
        p.error("файл не найден: %s" % src)

    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent if (script_dir.parent / "templates").is_dir() else script_dir
    tpl_dir = Path(a.templates) if a.templates else project_root / "templates"
    if not tpl_dir.is_dir():
        p.error("каталог шаблонов не найден: %s" % tpl_dir)

    try:
        doc = parse(src)
        if a.workers is not None:
            doc.nodes.workers = parse_workers_arg(a.workers, list(doc.nodes.pools))
    except ParseError as exc:
        print("ошибка разбора: %s" % exc, file=sys.stderr)
        return 2

    if a.include_primary_in_dns:
        doc.nodes.include_primary_in_dns = True

    raw_ip = a.ip or doc.nodes.primary
    if not raw_ip:
        p.error("не указан IP-адрес сервера (передайте позиционным аргументом ip или укажите nodes.primary в YAML)")
    try:
        ip = str(ipaddress.IPv4Address(raw_ip))
    except ipaddress.AddressValueError as exc:
        p.error("«%s» не похож на IPv4-адрес: %s" % (raw_ip, exc))

    for key, val in (("name", a.name), ("origin", a.origin), ("date", a.date)):
        if val:
            doc.meta[key] = val
    if a.domain:
        doc.free.domain = a.domain.strip().lower()

    errors, warnings = validate(doc, primary_ip=ip)
    if warnings and not a.quiet:
        for m in warnings:
            print("предупреждение: %s" % m, file=sys.stderr)
    if errors:
        for m in errors:
            print("ошибка: %s" % m, file=sys.stderr)
        n = len(errors)
        print("\n%d %s — файлы не записаны" % (n, plural_errors(n)), file=sys.stderr)
        return 1

    try:
        values = build_values(doc, ip, src.name)
        rendered = [(out_name, render(tpl_dir, tpl_name, values)) for tpl_name, out_name, _ in TEMPLATES]
        rendered.append(("service-map.json", values["service_map_json"]))
        rendered.append(("cluster-nodes.json", values["cluster_nodes_json"]))
        rendered.extend(strict_pool_maps(doc, doc.nodes, doc.categories, ""))
        if doc.pro.enabled:
            pv = pro_values(doc, values)
            rendered.extend((out_name, render(tpl_dir, tpl_name, pv)) for tpl_name, out_name, _ in PRO_TEMPLATES)
            rendered.append(("pro-policy-map.json", pro_policy_map_json(doc)))
            rendered.append(("pro-nodes.json", pro_nodes_json(doc)))
            rendered.append(("pro-service-map.json", service_map_json(doc, doc.all_categories())))
            rendered.extend(strict_pool_maps(doc, doc.pro, doc.all_categories(), "pro-"))
        catalog = services_json(doc, ip)
    except ParseError as exc:
        print("ошибка шаблона: %s" % exc, file=sys.stderr)
        return 2

    pro_note = ""
    if doc.pro.enabled:
        pro_note = "; Pro: %d категорий, %d сервисов, %d доменов" % (
            len(doc.pro.categories), sum(len(c.services) for c in doc.pro.categories),
            sum(c.count for c in doc.pro.categories))
    print("%s: Free: %d категорий, %s сервисов, %d доменов, %d отключено, %d passthrough%s" % (
        src, len(doc.categories), values["service_count"], doc.total,
        sum(len(g.domains) for g in doc.disabled), len(set(doc.passthrough.domains)), pro_note))
    print("шаблоны: %s" % tpl_dir)

    services_path = None
    if not a.no_services_json:
        services_path = Path(a.services_json) if a.services_json else project_root / SERVICES_JSON_DEFAULT

    if a.check:
        if services_path is not None:
            current = services_path.read_text(encoding="utf-8") if services_path.is_file() else None
            if current != catalog:
                print("ошибка: %s устарел — запустите python3 src/generate.py %s %s"
                      % (services_path, src, ip), file=sys.stderr)
                return 1
            print("каталог %s актуален" % services_path)
        print("проверка пройдена")
        return 0

    out = Path(a.out_dir) if a.out_dir else project_root / "build"
    out.mkdir(parents=True, exist_ok=True)
    for fname, body in rendered:
        target = out / fname
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
        print(("  записан %s (%s байт)" % (target, "{:,}".format(len(body)).replace(",", " "))))
    if services_path is not None:
        services_path.parent.mkdir(parents=True, exist_ok=True)
        if not services_path.is_file() or services_path.read_text(encoding="utf-8") != catalog:
            services_path.write_text(catalog, encoding="utf-8")
            print("  записан %s" % services_path)
        else:
            print("  без изменений %s" % services_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
