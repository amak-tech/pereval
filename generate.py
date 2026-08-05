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
import sys
from collections import OrderedDict
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("нужен PyYAML: pip3 install pyyaml   "
             "(Debian/Ubuntu: sudo apt install python3-yaml)")

DOMAIN_RE = re.compile(r'^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$')
IPISH_RE = re.compile(r'^\d{1,3}(\.\d{1,3}){3}$')
FAQ_RE = re.compile(r'<details class="faq">\s*<summary>(.*?)</summary>\s*'
                    r'<p>(.*?)</p>\s*</details>', re.S)
PLACEHOLDER_RE = re.compile(r'\{\{\s*(\w+)\s*\}\}')

TEMPLATES = OrderedDict([
    ("dnsmasq.conf", "dnsmasq-geoblock.conf"),
    ("nginx.conf", "nginx.conf"),
    ("nginx-sni-allow.map", "nginx-sni-allow.map"),
    ("index.html", "index.html"),
])
SEO_TEMPLATES = OrderedDict([
    ("robots.txt", "robots.txt"),
    ("sitemap.xml", "sitemap.xml"),
    ("og-image.svg", "og-image.svg"),
])


# --------------------------------------------------------------------- модель


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


def validate(doc):
    errors, warnings = [], []

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
    return "".join(f'<a href="#cat-{i}">{e(c.name)} <span>{c.count}</span></a>'
                   for i, c in enumerate(doc.categories, 1))


def html_cards(doc):
    e = html.escape
    out = []
    for i, c in enumerate(doc.categories, 1):
        rows = []
        for s in c.services:
            chips = "".join(f'<code class="d">{e(d)}</code>' for d in s.domains)
            key = f'{s.name.lower()} {" ".join(s.domains)}'
            rows.append(f'<div class="sub" data-search="{e(key)}">'
                        f'<h4 class="subhead">{e(s.name)}</h4>'
                        f'<div class="chips">{chips}</div></div>')
        out.append(f'<section class="cat" id="cat-{i}" aria-labelledby="cat-{i}-h">'
                   f'<h3 id="cat-{i}-h">{e(c.name)}<span class="count">{c.count}</span></h3>'
                   f'{"".join(rows)}</section>')
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


def faq_entities(template_text, template_name):
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
    entities = [{"@type": "Question",
                 "name": html.unescape(strip_tags.sub("", q)).strip(),
                 "acceptedAnswer": {"@type": "Answer",
                                    "text": html.unescape(strip_tags.sub("", a)).strip()}}
                for q, a in items]
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
    out = []
    for i, c in enumerate(doc.categories, 1):
        out.append("#" + "=" * 78)
        out.append(f"# {i}. {c.name.upper()} ({c.count})")
        out.append("#" + "=" * 78)
        for s in c.services:
            out.append("")
            out.append(f"# --- {s.name} ---")
            out.extend(f"address=/{d}/{ip}" for d in s.domains)
        out.append("")
    return "\n".join(out)


def sni_entries(doc):
    """Ключи для map в nginx: только активные домены, по одному на строку.

    Ключ «.example.com» вместе с директивой hostnames совпадает и с самим
    доменом, и со всеми поддоменами — то же покрытие, что address=/x/ в dnsmasq.
    Значение — тот же хост с портом 443, то есть сессия уходит на настоящий
    origin. Всё, чего в списке нет, попадает в default и обрывается.
    """
    width = max((len(d) for d, _, _ in doc.active()), default=0) + 1
    out = []
    for i, c in enumerate(doc.categories, 1):
        out.append(f"# {i}. {c.name}")
        for s in c.services:
            out.append(f"#   {s.name}")
            for d in s.domains:
                key = "." + d
                out.append(f"{key:<{width + 1}} $ssl_preread_server_name:443;")
        out.append("")
    return "\n".join(out)


def conf_disabled(doc, ip):
    out = []
    for g in doc.disabled:
        out.append("#" + "=" * 78)
        out.append(f"# ОТКЛЮЧЕНО: {g.name.upper()}")
        out.append("#" + "=" * 78)
        if g.note:
            out.append(wrap_comment(g.note))
        out.append("")
        out.extend(f"#address=/{d}/{ip}" for d in g.domains)
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


def build_values(doc, ip, source, templates_dir):
    """Все подстановки: скаляры из данных плюс собранные фрагменты."""
    idx = templates_dir / "index.html"
    values = {
        "name": doc.meta.get("name", ""),
        "ip": ip,
        "origin": doc.meta.get("origin", "").rstrip("/"),
        "date": doc.meta.get("date", ""),
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
        "sni_entries": sni_entries(doc),
    }
    # FAQPage собирается из самой страницы, но только если шаблон его просит —
    # иначе отсутствие блоков FAQ маскировало бы настоящие ошибки шаблона.
    values["faq_entities"] = "[]"
    if idx.is_file():
        text = idx.read_text(encoding="utf-8")
        if re.search(r'\{\{\s*faq_entities\s*\}\}', text):
            values["faq_entities"] = faq_entities(text, str(idx))
    return values


def render(templates_dir, tpl_name, values, doc, ip):
    """Подставляет значения в шаблон. disabled и passthrough_note зависят
    от формата: в HTML это разметка, в конфиге — комментарии."""
    path = templates_dir / tpl_name
    if not path.is_file():
        raise ParseError(f"шаблон не найден: {path}")
    local = dict(values)
    if tpl_name.endswith(".html"):
        local["disabled"] = values["disabled_html"]
    else:
        local["disabled"] = conf_disabled(doc, ip)
        local["passthrough_note"] = wrap_comment(doc.passthrough.note)
    return substitute(path.read_text(encoding="utf-8"), local, str(path))


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
    p.add_argument("ip", help="IPv4-адрес прокси-сервера")
    p.add_argument("-t", "--templates", default=None,
                   help="каталог с шаблонами (по умолчанию templates/ рядом со скриптом)")
    p.add_argument("-o", "--out-dir", default=None,
                   help="каталог для результатов (по умолчанию — рядом с YAML)")
    p.add_argument("--name", help="название сервиса (переопределяет meta.name)")
    p.add_argument("--origin", help="адрес сайта (переопределяет meta.origin)")
    p.add_argument("--date", help="дата обновления YYYY-MM-DD (переопределяет meta.date)")
    p.add_argument("--check", action="store_true",
                   help="только проверить данные и шаблоны, ничего не записывать")
    p.add_argument("--seo-extras", action="store_true",
                   help="дополнительно собрать robots.txt, sitemap.xml и og-image.svg")
    p.add_argument("-q", "--quiet", action="store_true", help="не печатать предупреждения")
    a = p.parse_args(argv)

    try:
        ip = str(ipaddress.IPv4Address(a.ip))
    except ipaddress.AddressValueError as exc:
        p.error(f"«{a.ip}» не похож на IPv4-адрес: {exc}")

    src = Path(a.services)
    if not src.is_file():
        p.error(f"файл не найден: {src}")

    tpl_dir = Path(a.templates) if a.templates else Path(__file__).resolve().parent / "templates"
    if not tpl_dir.is_dir():
        p.error(f"каталог шаблонов не найден: {tpl_dir}")

    try:
        doc = parse(src)
    except ParseError as exc:
        print(f"ошибка разбора: {exc}", file=sys.stderr)
        return 2

    for key, val in (("name", a.name), ("origin", a.origin), ("date", a.date)):
        if val:
            doc.meta[key] = val

    errors, warnings = validate(doc)
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
