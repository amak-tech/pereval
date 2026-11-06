#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает dnsmasq-geoblock.conf и index.html из YAML с доменами и шаблонов.

    python3 generate.py services.yaml 153.80.200.170

Ни строчки вёрстки, стилей и текста страницы здесь нет — всё лежит в templates/.
Скрипт читает данные, собирает из них фрагменты и подставляет в шаблоны на месте
подстановок вида {{имя}}. Двойные скобки выбраны потому, что не конфликтуют
ни с $переменными nginx, ни с @media в CSS, ни с {} в JavaScript.

Структура YAML:

    meta:
      name: Перевал
      origin: https://example.com
      date: 2026-08-05

    dnsmasq_options:            # попадут в блок опций конфига как есть
      - listen-address=0.0.0.0

    categories:
      - name: ИИ и языковые модели
        services:
          - name: Anthropic / Claude
            domains:            # поддомены включаются автоматически
              - claude.ai
              - anthropic.com

    disabled:                   # домены, закомментированные в конфиге
      - name: Общая инфраструктура Google
        note: Почему отключено
        domains:
          - clients6.google.com

    passthrough:                # домены, которые НЕЛЬЗЯ проксировать
      note: Почему нельзя
      domains:
        - gosuslugi.ru

Требуется PyYAML:  pip3 install pyyaml   (в Debian/Ubuntu: apt install python3-yaml)
"""

import argparse
import html
import ipaddress
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid
from collections import OrderedDict
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

try:
    import yaml
except ImportError:
    sys.exit("нужен PyYAML: pip3 install pyyaml   "
             "(Debian/Ubuntu: sudo apt install python3-yaml)")

DOMAIN_RE = re.compile(r'^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$')
IPISH_RE = re.compile(r'^\d{1,3}(\.\d{1,3}){3}$')
ENV_VAR_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
FAQ_RE = re.compile(r'<details class="faq">\s*<summary>(.*?)</summary>\s*'
                    r'<p>(.*?)</p>\s*</details>', re.S)
PLACEHOLDER_RE = re.compile(r'\{\{\s*(\w+)\s*\}\}')

TEMPLATES = OrderedDict([
    ("dnsmasq.conf", "dnsmasq-geoblock.conf"),
    ("nginx.conf", "nginx.conf"),
    ("nginx-sni-allow.map", "nginx-sni-allow.map"),
    ("nginx-host-allow.map", "nginx-host-allow.map"),
    ("nginx-workers-stream.conf", "nginx-workers-stream.conf"),
    ("nginx-workers-http.conf", "nginx-workers-http.conf"),
    ("index.html", "index.html"),
    ("pro.html", "pro.html"),
    ("dedicated.html", "dedicated.html"),
    ("stats.html", "stats.html"),
    ("terms.html", "terms.html"),
    ("privacy.html", "privacy.html"),
    ("dns.mobileconfig", "dns.mobileconfig"),
    ("favicon.svg", "favicon.svg"),
    ("og-image.svg", "og-image.svg"),
    ("robots.txt", "robots.txt"),
    ("sitemap.xml", "sitemap.xml"),
])
SEO_TEMPLATES = OrderedDict([
    ("favicon.svg", "favicon.svg"),
    ("og-image.svg", "og-image.svg"),
])


# --------------------------------------------------------------------- модель


class WorkerNode:
    def __init__(self, ip, name="", weight=1, ssh_user=None, ssh_user_env=None,
                 ssh_key=None, ssh_key_env=None, ssh_port=None):
        self.ip = ip
        self.name = name
        self.weight = weight
        self.ssh_user = ssh_user
        self.ssh_user_env = ssh_user_env
        self.ssh_key = ssh_key
        self.ssh_key_env = ssh_key_env
        self.ssh_port = ssh_port


class NodesConfig:
    def __init__(self):
        self.primary = None
        self.include_primary_in_dns = False
        self.probe_sni = "claude.ai"
        self.workers = []


class Service:
    def __init__(self, name):
        self.name = name
        self.domains = []


class Category:
    def __init__(self, name):
        self.name = name
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
        self.nodes = NodesConfig()
        self.dnsmasq_options = []
        self.categories = []
        self.disabled = []
        self.passthrough = Group("passthrough")

    @property
    def total(self):
        return sum(c.count for c in self.categories)

    def active(self):
        """(домен, категория, сервис) для каждого активного домена."""
        for c in self.categories:
            for s in c.services:
                for d in s.domains:
                    yield d, c, s

    def active_workers(self, primary_ip=None):
        """Список воркеров, исключая совпадающие с primary_ip."""
        eff_primary = primary_ip or self.nodes.primary
        return [w for w in self.nodes.workers if w.ip != eff_primary]

    def active_dns_ips(self, primary_ip):
        """Список IP-адресов для выдачи в A-записях dnsmasq."""
        workers = self.active_workers(primary_ip)
        if not workers:
            return [primary_ip]
        ips = []
        if self.nodes.include_primary_in_dns and primary_ip:
            ips.append(primary_ip)
        for w in workers:
            if w.ip not in ips:
                ips.append(w.ip)
        return ips or [primary_ip]


# -------------------------------------------------------------------- парсер


class ParseError(Exception):
    pass


def _need(obj, key, where, kind):
    """Достаёт obj[key] с проверкой типа. Ошибка указывает, где именно сломалось."""
    if not isinstance(obj, dict):
        raise ParseError(f"{where}: ожидался словарь, а не {type(obj).__name__}")
    if key not in obj:
        raise ParseError(f"{where}: не хватает поля «{key}»")
    val = obj[key]
    if not isinstance(val, kind):
        want = "строка" if kind is str else "список"
        raise ParseError(f"{where}: поле «{key}» должно быть {want}, "
                         f"а не {type(val).__name__}")
    return val


def _domains(raw, where):
    out = []
    for i, d in enumerate(raw):
        if not isinstance(d, str):
            raise ParseError(f"{where}: домен #{i + 1} — не строка, а {type(d).__name__} "
                             f"({d!r}). Домены вида 1.1.1.1 нужно брать в кавычки")
        out.append(d.strip().lower())
    return out


def _opt_str(obj, key, where):
    if key not in obj or obj[key] is None:
        return None
    val = obj[key]
    if not isinstance(val, str):
        raise ParseError(f"{where}: поле «{key}» должно быть строкой, а не {type(val).__name__}")
    s = val.strip()
    return s if s else None


def _opt_int(obj, key, where, default=None):
    if key not in obj or obj[key] is None:
        return default
    val = obj[key]
    if isinstance(val, bool) or not isinstance(val, int):
        raise ParseError(f"{where}: поле «{key}» должно быть целым числом, а не {type(val).__name__}")
    return val


def parse_workers_arg(raw_workers):
    """Разбирает CLI-аргумент --workers ip1,ip2 (или name=ip:weight)."""
    workers = []
    for idx, item in enumerate(raw_workers.split(","), 1):
        token = item.strip()
        if not token:
            continue
        name = f"worker-{idx}"
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
                raise ParseError(f"--workers: некорректный вес «{weight_part}» для «{ip_str}»")
        else:
            ip_str = token.strip()
        workers.append(WorkerNode(ip=ip_str, name=name, weight=weight))
    return workers


def parse(path):
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ParseError(f"{path}: не разобрался YAML — {exc}")
    if not isinstance(data, dict):
        raise ParseError(f"{path}: на верхнем уровне ожидался словарь "
                         f"с ключами meta / categories")

    doc = Doc()

    meta = data.get("meta") or {}
    if not isinstance(meta, dict):
        raise ParseError(f"{path}: meta должен быть словарём")
    for k, v in meta.items():
        doc.meta[str(k)] = "" if v is None else str(v)

    nodes_raw = data.get("nodes")
    if nodes_raw is not None:
        if not isinstance(nodes_raw, dict):
            raise ParseError(f"{path}: nodes должен быть словарём")
        if nodes_raw.get("primary") is not None:
            doc.nodes.primary = str(nodes_raw["primary"]).strip()
        inc_primary = nodes_raw.get("include_primary_in_dns")
        if inc_primary is not None:
            if not isinstance(inc_primary, bool):
                raise ParseError(f"{path}: nodes.include_primary_in_dns должен быть булевым значением")
            doc.nodes.include_primary_in_dns = inc_primary
        probe_sni = _opt_str(nodes_raw, "probe_sni", f"{path}: nodes")
        if probe_sni:
            doc.nodes.probe_sni = probe_sni.lower()
        w_list = nodes_raw.get("workers")
        if w_list is not None:
            if not isinstance(w_list, list):
                raise ParseError(f"{path}: nodes.workers должен быть списком")
            for wi, wraw in enumerate(w_list, 1):
                where = f"{path}: nodes.workers[{wi}]"
                if isinstance(wraw, str):
                    doc.nodes.workers.append(WorkerNode(ip=wraw.strip(), name=f"worker-{wi}"))
                elif isinstance(wraw, dict):
                    wip = _need(wraw, "ip", where, str).strip()
                    wname = _opt_str(wraw, "name", where) or f"worker-{wi}"
                    wweight = _opt_int(wraw, "weight", where, default=1)
                    doc.nodes.workers.append(WorkerNode(
                        ip=wip,
                        name=wname,
                        weight=wweight,
                        ssh_user=_opt_str(wraw, "ssh_user", where),
                        ssh_user_env=_opt_str(wraw, "ssh_user_env", where),
                        ssh_key=_opt_str(wraw, "ssh_key", where),
                        ssh_key_env=_opt_str(wraw, "ssh_key_env", where),
                        ssh_port=_opt_int(wraw, "ssh_port", where, default=None),
                    ))
                else:
                    raise ParseError(f"{where}: ожидался словарь или строка с IP")

    opts = data.get("dnsmasq_options") or []
    if not isinstance(opts, list):
        raise ParseError(f"{path}: dnsmasq_options должен быть списком строк")
    doc.dnsmasq_options = [str(o).strip() for o in opts if str(o).strip()]

    cats = data.get("categories")
    if not isinstance(cats, list) or not cats:
        raise ParseError(f"{path}: categories должен быть непустым списком")
    for ci, craw in enumerate(cats, 1):
        cname = _need(craw, "name", f"{path}: categories[{ci}]", str)
        cat = Category(cname.strip())
        for si, sraw in enumerate(_need(craw, "services", f"categories «{cname}»", list), 1):
            where = f"categories «{cname}» / services[{si}]"
            sname = _need(sraw, "name", where, str)
            svc = Service(sname.strip())
            svc.domains = _domains(_need(sraw, "domains", f"сервис «{sname}»", list),
                                   f"сервис «{sname}»")
            cat.services.append(svc)
        doc.categories.append(cat)

    for gi, graw in enumerate(data.get("disabled") or [], 1):
        where = f"{path}: disabled[{gi}]"
        g = Group(_need(graw, "name", where, str).strip())
        g.note = str(graw.get("note") or "").strip()
        g.domains = _domains(_need(graw, "domains", where, list), where)
        doc.disabled.append(g)

    pt = data.get("passthrough") or {}
    if pt:
        if not isinstance(pt, dict):
            raise ParseError(f"{path}: passthrough должен быть словарём с note и domains")
        doc.passthrough.note = str(pt.get("note") or "").strip()
        doc.passthrough.domains = _domains(pt.get("domains") or [], f"{path}: passthrough")

    return doc


# ---------------------------------------------------------------- валидация


def _validate_env_ref(val, field_name, worker_name, errors):
    var_name = val[2:-1] if (val.startswith("${") and val.endswith("}")) else val[1:]
    if not ENV_VAR_RE.match(var_name):
        errors.append(f"некорректное имя переменной окружения в {field_name}=«{val}» "
                      f"у воркера «{worker_name}»")


def validate(doc, primary_ip=None):
    errors, warnings = [], []

    if doc.nodes.primary:
        try:
            ipaddress.IPv4Address(doc.nodes.primary)
        except ipaddress.AddressValueError:
            errors.append(f"некорректный IPv4-адрес nodes.primary: «{doc.nodes.primary}»")

    if doc.nodes.probe_sni and not DOMAIN_RE.match(doc.nodes.probe_sni):
        errors.append(f"некорректный домен nodes.probe_sni: «{doc.nodes.probe_sni}»")

    primary_ips = {p for p in (doc.nodes.primary, primary_ip) if p}
    seen_worker_ips = set()
    for w in doc.nodes.workers:
        try:
            ipaddress.IPv4Address(w.ip)
        except ipaddress.AddressValueError:
            errors.append(f"некорректный IPv4-адрес воркера «{w.name}»: «{w.ip}»")
        if w.ip in primary_ips:
            errors.append(f"IP воркера «{w.name}» ({w.ip}) совпадает с основным узлом (primary)")
        if w.ip in seen_worker_ips:
            errors.append(f"дублирующийся IP воркера: {w.ip}")
        seen_worker_ips.add(w.ip)
        if w.weight < 1:
            errors.append(f"вес (weight) воркера «{w.name}» ({w.ip}) должен быть >= 1 (указано {w.weight})")
        if w.ssh_port is not None and not (1 <= w.ssh_port <= 65535):
            errors.append(f"некорректный ssh_port у воркера «{w.name}» ({w.ip}): {w.ssh_port} (ожидается 1..65535)")
        for fname, fval in (("ssh_user_env", w.ssh_user_env), ("ssh_key_env", w.ssh_key_env)):
            if fval is not None and not ENV_VAR_RE.match(fval):
                errors.append(f"некорректное имя переменной окружения {fname}=«{fval}» у воркера «{w.name}»")
        if w.ssh_user is not None and w.ssh_user.startswith("$"):
            _validate_env_ref(w.ssh_user, "ssh_user", w.name, errors)
        if w.ssh_key is not None:
            if "-----BEGIN" in w.ssh_key or "\n" in w.ssh_key:
                errors.append(f"воркер «{w.name}»: нельзя хранить приватный SSH-ключ напрямую в services.yaml; "
                              f"используйте ssh_key_env или путь к файлу")
            elif w.ssh_key.startswith("$"):
                _validate_env_ref(w.ssh_key, "ssh_key", w.name, errors)

    seen = {}
    for d, c, s in doc.active():
        if not DOMAIN_RE.match(d):
            errors.append(f"некорректный домен «{d}» ({c.name} / {s.name})")
        elif IPISH_RE.match(d):
            warnings.append(f"«{d}» похож на IP-адрес, а не на домен "
                            f"({c.name} / {s.name}) — подменять DNS для него бессмысленно")
        if d in seen:
            errors.append(f"домен {d} указан дважды: «{seen[d]}» и «{c.name} / {s.name}»")
        else:
            seen[d] = f"{c.name} / {s.name}"

    pt = set(doc.passthrough.domains)
    for d in sorted(set(seen) & pt):
        errors.append(f"домен {d} есть и в categories, и в passthrough — "
                      f"уберите его из одного из списков")

    dis = {d: g.name for g in doc.disabled for d in g.domains}
    for d in sorted(set(seen) & set(dis)):
        warnings.append(f"домен {d} активен, но также перечислен в disabled "
                        f"«{dis[d]}» — эта строка ни на что не влияет")

    # поддомен, уже покрытый родительской записью
    parents = sorted(seen, key=len)
    for d in sorted(seen):
        for p in parents:
            if p != d and d.endswith("." + p):
                warnings.append(f"домен {d} уже покрыт записью {p} — строку можно удалить")
                break

    for c in doc.categories:
        if not c.services:
            warnings.append(f"категория «{c.name}» пуста")
        names = [s.name for s in c.services]
        for n in sorted(set(n for n in names if names.count(n) > 1)):
            warnings.append(f"в категории «{c.name}» два сервиса с именем «{n}»")
        for s in c.services:
            if not s.domains:
                warnings.append(f"сервис «{c.name} / {s.name}» без доменов")

    return errors, warnings


# ------------------------------------------------------- фрагменты для HTML


def html_toc(doc):
    e = html.escape
    return "".join(f'<a href="#cat-{i}">{e(c.name)} <span>{len(c.services)}</span></a>'
                   for i, c in enumerate(doc.categories, 1))


def html_cards(doc):
    e = html.escape
    out = []
    for i, c in enumerate(doc.categories, 1):
        chips = []
        for s in c.services:
            key = f'{s.name.lower()} {" ".join(s.domains)}'
            chips.append(f'<span class="svc sub" data-search="{e(key)}">{e(s.name)}</span>')
        out.append(f'<section class="cat" id="cat-{i}" aria-labelledby="cat-{i}-h">'
                   f'<h3 id="cat-{i}-h">{e(c.name)}<span class="count">{len(c.services)}</span></h3>'
                   f'<div class="chips">{"".join(chips)}</div></section>')
    return "".join(out)


def html_disabled(doc):
    e = html.escape
    out = []
    for g in doc.disabled:
        out.append(f'<h3 class="subhead">{e(g.name)}</h3>')
        if g.note:
            out.append(f'<p>{e(g.note)}</p>')
        out.append('<div class="chips">'
                   + "".join(f'<code class="d off">{e(d)}</code>' for d in g.domains)
                   + '</div>')
    return "".join(out)


def html_chips(domains):
    e = html.escape
    return "".join(f'<code class="d">{e(d)}</code>' for d in sorted(set(domains)))


def faq_entities(template_text, template_name, values):
    """Собирает mainEntity для FAQPage из блоков <details class="faq"> шаблона.

    Вопросы и ответы редактируются только в шаблоне — разметка для поисковиков
    выводится из той же разметки, поэтому расходиться им негде.
    """
    items = FAQ_RE.findall(template_text)
    if not items:
        raise ParseError(f"{template_name}: не нашлось ни одного блока "
                         f'<details class="faq"><summary>…</summary><p>…</p></details>, '
                         f"а {{faq_entities}} в шаблоне используется")
    strip_tags = re.compile(r'<[^>]+>')
    entities = []
    for q, a in items:
        q_sub = substitute(q, values, template_name)
        a_sub = substitute(a, values, template_name)
        entities.append({
            "@type": "Question",
            "name": html.unescape(strip_tags.sub("", q_sub)).strip(),
            "acceptedAnswer": {
                "@type": "Answer",
                "text": html.unescape(strip_tags.sub("", a_sub)).strip(),
            },
        })
    return json.dumps(entities, ensure_ascii=False, separators=(",", ":"))


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
    dns_ips = doc.active_dns_ips(ip) if isinstance(ip, str) else list(ip)
    n_ips = len(dns_ips)
    out = []
    domain_idx = 0
    for i, c in enumerate(doc.categories, 1):
        out.append("#" + "=" * 78)
        out.append(f"# {i}. {c.name.upper()} ({c.count})")
        out.append("#" + "=" * 78)
        for s in c.services:
            out.append("")
            out.append(f"# --- {s.name} ---")
            for d in s.domains:
                if n_ips <= 1:
                    out.append(f"address=/{d}/{dns_ips[0]}")
                else:
                    rot = domain_idx % n_ips
                    for node_ip in dns_ips[rot:] + dns_ips[:rot]:
                        out.append(f"address=/{d}/{node_ip}")
                domain_idx += 1
        out.append("")
    return "\n".join(out)


def map_entries(doc, value):
    """Ключи для map в nginx: только активные домены, по одному на строку.

    Ключ «.example.com» вместе с директивой hostnames совпадает и с самим
    доменом, и со всеми поддоменами — то же покрытие, что address=/x/ в dnsmasq.
    Всё, чего в списке нет, попадает в default и обрывается.
    """
    width = max((len(d) for d, _, _ in doc.active()), default=0) + 2
    out = []
    for i, c in enumerate(doc.categories, 1):
        out.append(f"# {i}. {c.name}")
        for svc in c.services:
            out.append(f"#   {svc.name}")
            for d in svc.domains:
                out.append(f"{'.' + d:<{width}} {value};")
        out.append("")
    return "\n".join(out)


def service_map_json(doc):
    """Словарь {домен: {service, category}} для агрегации статистики."""
    mapping = OrderedDict()
    for d, c, s in doc.active():
        mapping[d] = OrderedDict([
            ("service", s.name),
            ("category", c.name),
        ])
    return json.dumps(mapping, ensure_ascii=False, indent=2) + "\n"


def nginx_workers_stream_body(doc, primary_ip):
    """Содержимое nginx-workers-stream.conf (пул воркеров на 443 или прямой выход)."""
    workers = doc.active_workers(primary_ip)
    if not workers:
        return "\n".join([
            "map $sni_allow_target $sni_upstream {",
            "    default           $sni_allow_target;",
            '    "__WORKERS__"     $ssl_preread_server_name:443;',
            "}",
        ])
    lines = [
        "upstream pereval_stream_workers {",
        "    least_conn;",
    ]
    for w in workers:
        lines.append(f"    server {w.ip}:443 weight={w.weight} max_fails=2 fail_timeout=10s;")
    lines.extend([
        "}",
        "",
        "map $sni_allow_target $sni_upstream {",
        '    "127.0.0.1:9"     127.0.0.1:9;',
        '    "127.0.0.1:8443"  127.0.0.1:8443;',
        "    default           pereval_stream_workers;",
        '    "__WORKERS__"     pereval_stream_workers;',
        "}",
    ])
    return "\n".join(lines)


def nginx_workers_http_body(doc, primary_ip):
    """Содержимое nginx-workers-http.conf (пул воркеров на 80 или прямой выход)."""
    workers = doc.active_workers(primary_ip)
    if not workers:
        return "\n".join([
            "map $http_allow_target $http_upstream {",
            "    default           $http_allow_target;",
            '    "__WORKERS__"     $host;',
            "}",
        ])
    lines = [
        "upstream pereval_http_workers {",
        "    least_conn;",
    ]
    for w in workers:
        lines.append(f"    server {w.ip}:80 weight={w.weight} max_fails=2 fail_timeout=10s;")
    lines.extend([
        "    keepalive 32;",
        "}",
        "",
        "map $http_allow_target $http_upstream {",
        '    ""                "";',
        "    default           pereval_http_workers;",
        '    "__WORKERS__"     pereval_http_workers;',
        "}",
    ])
    return "\n".join(lines)


def cluster_nodes_json(doc, primary_ip):
    """JSON-описание узлов кластера для healthcheck.py и deploy.sh."""
    domain = extract_domain(doc)
    payload = OrderedDict([
        ("primary", primary_ip),
        ("domain", domain),
        ("include_primary_in_dns", bool(doc.nodes.include_primary_in_dns)),
        ("probe_sni", doc.nodes.probe_sni or "claude.ai"),
        ("workers", [
            OrderedDict([
                ("ip", w.ip),
                ("name", w.name or f"worker-{idx}"),
                ("weight", w.weight),
                ("ssh_user", w.ssh_user),
                ("ssh_user_env", w.ssh_user_env),
                ("ssh_key", w.ssh_key),
                ("ssh_key_env", w.ssh_key_env),
                ("ssh_port", w.ssh_port),
            ])
            for idx, w in enumerate(doc.active_workers(primary_ip), 1)
        ]),
    ])
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def conf_disabled(doc, ip):
    dns_ips = doc.active_dns_ips(ip) if isinstance(ip, str) else list(ip)
    n_ips = len(dns_ips)
    out = []
    domain_idx = 0
    for g in doc.disabled:
        out.append("#" + "=" * 78)
        out.append(f"# ОТКЛЮЧЕНО: {g.name.upper()}")
        out.append("#" + "=" * 78)
        if g.note:
            out.append(wrap_comment(g.note))
        out.append("")
        for d in g.domains:
            if n_ips <= 1:
                out.append(f"#address=/{d}/{dns_ips[0]}")
            else:
                rot = domain_idx % n_ips
                for node_ip in dns_ips[rot:] + dns_ips[:rot]:
                    out.append(f"#address=/{d}/{node_ip}")
            domain_idx += 1
        out.append("")
    return "\n".join(out)


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
        first = ", ".join(f"строка {ln}: {{{{{k}}}}}" for ln, k in missing[:5])
        raise ParseError(f"{where}: в шаблоне есть подстановки, которых скрипт "
                         f"не готовит — {first}. "
                         f"Доступны: {', '.join(sorted(values))}")
    return out


def extract_domain(doc):
    """Извлекает имя хоста (domain) из meta.domain или meta.origin."""
    raw = (doc.meta.get("domain") or "").strip().lower()
    if not raw:
        origin = (doc.meta.get("origin") or "").strip()
        if "://" in origin:
            raw = (urlparse(origin).hostname or "").strip().lower()
        else:
            raw = origin.split("/")[0].split(":")[0].strip().lower()
    if not raw or not DOMAIN_RE.match(raw):
        raise ParseError(f"не удалось определить корректный домен из meta.origin / meta.domain "
                         f"(получено: {raw!r}); укажите meta.origin в YAML или --domain")
    return raw


def build_values(doc, ip, source, templates_dir):
    """Все подстановки: скаляры из данных плюс собранные фрагменты."""
    idx = templates_dir / "index.html"
    domain = extract_domain(doc)
    profile_identifier = ".".join(reversed(domain.split("."))) + ".dns"
    profile_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{domain}:profile")).upper()
    dns_payload_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{domain}:dnsSettings")).upper()
    values = {
        "name": doc.meta.get("name", ""),
        "ip": ip,
        "origin": doc.meta.get("origin", "").rstrip("/"),
        "domain": domain,
        "profile_identifier": profile_identifier,
        "profile_uuid": profile_uuid,
        "dns_payload_uuid": dns_payload_uuid,
        "date": doc.meta.get("date") or date.today().isoformat(),
        "source": source,
        "total": str(doc.total),
        "category_count": str(len(doc.categories)),
        "service_count": str(sum(len(c.services) for c in doc.categories)),
        "toc": html_toc(doc),
        "cards": html_cards(doc),
        "disabled_html": html_disabled(doc),
        "passthrough_note": html.escape(doc.passthrough.note),
        "passthrough_chips": html_chips(doc.passthrough.domains),
        "options": "\n".join(doc.dnsmasq_options),
        "body": conf_body(doc, ip),
        "passthrough": "\n".join(f"# passthrough: {d}"
                                 for d in sorted(set(doc.passthrough.domains))),
        "sni_entries": map_entries(doc, "$ssl_preread_server_name:443"),
        "host_entries": map_entries(doc, "$host"),
        "workers_stream_body": nginx_workers_stream_body(doc, ip),
        "workers_http_body": nginx_workers_http_body(doc, ip),
        "service_map_json": service_map_json(doc),
        "cluster_nodes_json": cluster_nodes_json(doc, ip),
    }
    # FAQPage собирается из самой страницы, но только если шаблон его просит —
    # иначе отсутствие блоков FAQ маскировало бы настоящие ошибки шаблона.
    values["faq_entities"] = "[]"
    if idx.is_file():
        text = idx.read_text(encoding="utf-8")
        if re.search(r'\{\{\s*faq_entities\s*\}\}', text):
            values["faq_entities"] = faq_entities(text, str(idx), values)
    return values


def render(templates_dir, tpl_name, values, doc, ip):
    """Подставляет значения в шаблон. disabled и passthrough_note зависят
    от формата: в HTML это разметка, в конфиге — комментарии."""
    path = templates_dir / tpl_name
    if not path.is_file():
        raise ParseError(f"шаблон не найден: {path}")
    raw_text = path.read_text(encoding="utf-8")
    local = dict(values)
    if tpl_name.endswith(".html"):
        local["disabled"] = values["disabled_html"]
        if re.search(r'\{\{\s*faq_entities\s*\}\}', raw_text):
            local["faq_entities"] = faq_entities(raw_text, str(path), local)
    else:
        local["disabled"] = conf_disabled(doc, ip)
        local["passthrough_note"] = wrap_comment(doc.passthrough.note)
    return substitute(raw_text, local, str(path))


def render_svg_png(svg_path, png_path, width, height):
    """Растеризует SVG в PNG заданного размера (width x height)."""
    cmds = []
    if shutil.which("rsvg-convert"):
        cmds.append(["rsvg-convert", "-w", str(width), "-h", str(height),
                     str(svg_path), "-o", str(png_path)])
    if shutil.which("resvg"):
        cmds.append(["resvg", "-w", str(width), "-h", str(height),
                     str(svg_path), str(png_path)])
    if shutil.which("sips"):
        cmds.append(["sips", "-s", "format", "png", "-z", str(height), str(width),
                     str(svg_path), "--out", str(png_path)])
    if shutil.which("inkscape"):
        cmds.append(["inkscape", "--export-type=png", f"--export-filename={png_path}",
                     "-w", str(width), "-h", str(height), str(svg_path)])
    if shutil.which("magick"):
        cmds.append(["magick", "-background", "none", str(svg_path),
                     "-resize", f"{width}x{height}!", str(png_path)])
    if shutil.which("convert"):
        cmds.append(["convert", "-background", "none", str(svg_path),
                     "-resize", f"{width}x{height}!", str(png_path)])
    for cmd in cmds:
        png_path.unlink(missing_ok=True)
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res.returncode == 0 and png_path.is_file() and png_path.stat().st_size > 0:
            return True
    try:
        import cairosvg
        png_path.unlink(missing_ok=True)
        cairosvg.svg2png(url=str(svg_path), write_to=str(png_path),
                         output_width=width, output_height=height)
        if png_path.is_file() and png_path.stat().st_size > 0:
            return True
    except Exception:
        pass
    try:
        import resvg_py
        png_path.unlink(missing_ok=True)
        png_bytes = resvg_py.svg_to_bytes(svg_path=str(svg_path), width=width, height=height)
        if png_bytes:
            png_path.write_bytes(bytes(png_bytes))
            return True
    except Exception:
        pass
    return False


def render_og_png(svg_path, png_path):
    """Растеризует og-image.svg в og-image.png (1200x630), необходимый для X / Open Graph."""
    return render_svg_png(svg_path, png_path, 1200, 630)


def render_apple_touch_icon(favicon_svg_path, png_path):
    """Собирает apple-touch-icon.png (180x180) без скругления углов (iOS применяет свою маску)."""
    svg_text = favicon_svg_path.read_text(encoding="utf-8")
    full_bleed = re.sub(r'<rect[^>]*stroke="#2e3342"[^>]*/>\s*', '', svg_text)
    full_bleed = full_bleed.replace('rx="112"', 'rx="0"')
    with tempfile.TemporaryDirectory() as tmp:
        tmp_svg = Path(tmp) / "apple-touch.svg"
        tmp_svg.write_text(full_bleed, encoding="utf-8")
        return render_svg_png(tmp_svg, png_path, 180, 180)


def render_favicon_ico(favicon_svg_path, ico_path, sizes=(16, 32, 48)):
    """Собирает мультиразмерный favicon.ico (16x16, 32x32, 48x48) из favicon.svg."""
    frames = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        for sz in sizes:
            png_file = tmp_dir / f"icon-{sz}.png"
            if not render_svg_png(favicon_svg_path, png_file, sz, sz):
                return False
            frames.append((sz, sz, png_file.read_bytes()))
    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = []
    payloads = []
    for w, h, data in frames:
        bw = 0 if w >= 256 else w
        bh = 0 if h >= 256 else h
        entries.append(struct.pack("<BBBBHHII", bw, bh, 0, 0, 1, 32, len(data), offset))
        payloads.append(data)
        offset += len(data)
    ico_path.write_bytes(header + b"".join(entries) + b"".join(payloads))
    return ico_path.is_file() and ico_path.stat().st_size > 0


# --------------------------------------------------------------------- CLI


def plural_errors(n):
    if n % 10 == 1 and n % 100 != 11:
        return "ошибка"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return "ошибки"
    return "ошибок"


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Собирает dnsmasq-geoblock.conf и index.html из YAML и шаблонов.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Примеры:\n"
               "  python3 generate.py services.yaml 153.80.200.170\n"
               "  python3 generate.py services.yaml 153.80.200.170 --check\n"
               "  python3 generate.py services.yaml 153.80.200.170 --seo-extras\n")
    p.add_argument("services", help="путь к YAML с категориями, сервисами и доменами")
    p.add_argument("ip", nargs="?", default=None,
                   help="IPv4-адрес основного прокси-сервера (по умолчанию берётся из nodes.primary)")
    p.add_argument("-t", "--templates", default=None,
                   help="каталог с шаблонами (по умолчанию templates/ рядом со скриптом)")
    p.add_argument("-o", "--out-dir", default=None,
                   help="каталог для результатов (по умолчанию — рядом с YAML)")
    p.add_argument("--name", help="название сервиса (переопределяет meta.name)")
    p.add_argument("--origin", help="адрес сайта (переопределяет meta.origin)")
    p.add_argument("--domain", help="домен DNS-сервера (переопределяет хост из meta.origin)")
    p.add_argument("--date", help="дата обновления YYYY-MM-DD (переопределяет meta.date)")
    p.add_argument("--workers", default=None,
                   help="список IP воркеров через запятую (переопределяет nodes.workers, напр. 153.80.200.171,153.80.200.172)")
    p.add_argument("--include-primary-in-dns", action="store_true",
                   help="включать основной IP в ответы dnsmasq наравне с воркерами")
    p.add_argument("--check", action="store_true",
                   help="только проверить данные и шаблоны, ничего не записывать")
    p.add_argument("--seo-extras", action="store_true",
                   help="дополнительно собрать og-image.svg")
    p.add_argument("-q", "--quiet", action="store_true", help="не печатать предупреждения")
    a = p.parse_args(argv)

    src = Path(a.services)
    if not src.is_file():
        p.error(f"файл не найден: {src}")

    tpl_dir = Path(a.templates) if a.templates else Path(__file__).resolve().parent / "templates"
    if not tpl_dir.is_dir():
        p.error(f"каталог шаблонов не найден: {tpl_dir}")

    try:
        doc = parse(src)
        if a.workers is not None:
            doc.nodes.workers = parse_workers_arg(a.workers)
    except ParseError as exc:
        print(f"ошибка разбора: {exc}", file=sys.stderr)
        return 2

    if a.include_primary_in_dns:
        doc.nodes.include_primary_in_dns = True

    raw_ip = a.ip or doc.nodes.primary
    if not raw_ip:
        p.error("не указан IP-адрес сервера (передайте позиционным аргументом ip или укажите nodes.primary в YAML)")
    try:
        ip = str(ipaddress.IPv4Address(raw_ip))
    except ipaddress.AddressValueError as exc:
        p.error(f"«{raw_ip}» не похож на IPv4-адрес: {exc}")

    for key, val in (("name", a.name), ("origin", a.origin), ("domain", a.domain), ("date", a.date)):
        if val:
            doc.meta[key] = val

    errors, warnings = validate(doc, primary_ip=ip)
    if warnings and not a.quiet:
        for m in warnings:
            print(f"предупреждение: {m}", file=sys.stderr)
    if errors:
        for m in errors:
            print(f"ошибка: {m}", file=sys.stderr)
        n = len(errors)
        print(f"\n{n} {plural_errors(n)} — файлы не записаны", file=sys.stderr)
        return 1

    wanted = OrderedDict(TEMPLATES)
    if a.seo_extras:
        wanted.update(SEO_TEMPLATES)
        if not doc.meta.get("origin"):
            print("предупреждение: meta.origin не задан — canonical и sitemap "
                  "получатся с пустым адресом", file=sys.stderr)

    try:
        values = build_values(doc, ip, src.name, tpl_dir)
        rendered = [(out_name, render(tpl_dir, tpl_name, values, doc, ip))
                    for tpl_name, out_name in wanted.items()]
        rendered.append(("service-map.json", values["service_map_json"]))
        rendered.append(("cluster-nodes.json", values["cluster_nodes_json"]))
    except ParseError as exc:
        print(f"ошибка шаблона: {exc}", file=sys.stderr)
        return 2

    print(f"{src}: {len(doc.categories)} категорий, {values['service_count']} сервисов, "
          f"{doc.total} доменов, {sum(len(g.domains) for g in doc.disabled)} отключено, "
          f"{len(set(doc.passthrough.domains))} passthrough")
    print(f"шаблоны: {tpl_dir}")

    if a.check:
        print("проверка пройдена")
        return 0

    out = Path(a.out_dir) if a.out_dir else src.parent
    out.mkdir(parents=True, exist_ok=True)
    for fname, body in rendered:
        (out / fname).write_text(body, encoding="utf-8")
        print(f"  записан {out / fname} ({len(body):,} байт)".replace(",", " "))
    fav_svg = out / "favicon.svg"
    if fav_svg.is_file():
        ico_out = out / "favicon.ico"
        if render_favicon_ico(fav_svg, ico_out):
            print(f"  записан {ico_out} ({ico_out.stat().st_size:,} байт)".replace(",", " "))
        touch_out = out / "apple-touch-icon.png"
        if render_apple_touch_icon(fav_svg, touch_out):
            print(f"  записан {touch_out} ({touch_out.stat().st_size:,} байт)".replace(",", " "))
    svg_out = out / "og-image.svg"
    png_out = out / "og-image.png"
    if svg_out.is_file():
        if render_og_png(svg_out, png_out):
            print(f"  записан {png_out} ({png_out.stat().st_size:,} байт)".replace(",", " "))
        elif not a.quiet:
            print("предупреждение: не удалось сконвертировать og-image.svg в og-image.png "
                  "(нужен rsvg-convert, resvg, sips, inkscape или ImageMagick; "
                  "Debian/Ubuntu: sudo apt install librsvg2-bin)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
