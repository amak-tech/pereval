#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Общие DNS- и HTTP-примитивы для демонов «Перевала» (doh_proxy.py, pro_dns.py,
pro_node_agent.py). Только стандартная библиотека Python 3.9+, asyncio.

Содержимое:
  * разбор и сборка DNS-сообщений на уровне wire-формата: parse_question(),
    build_response(), build_refused(), build_nodata(), a_record();
  * TCP-фрейминг DNS (RFC 7766, 2-байтовый префикс длины);
  * UdpDnsPool — пул постоянных UDP-сокетов к upstream (dnsmasq) с мультиплексированием
    до 65536 запросов на сокет через подмену transaction ID и TCP-fallback при TC;
  * HttpServerBase / DohHttpServer — минимальный HTTP/1.1 keep-alive сервер и
    RFC 8484 DoH-обработчик с перехватываемыми точками authorize()/resolve();
  * http_request() — крошечный асинхронный HTTP/1.1-клиент (для control plane);
  * hash_ip() — хэширование IP с суточной солью (как в stats_collector.py).

Модуль лежит рядом с демонами в репозитории (src/) и в /usr/local/lib/pereval на
серверах; демоны добавляют оба пути в sys.path.
"""

import asyncio
import base64
import hashlib
import ipaddress
import ssl
import struct
import time
from collections import OrderedDict, namedtuple
from urllib.parse import parse_qs, urlsplit

DNS_MEDIA_TYPE = "application/dns-message"
MIN_DNS_PACKET_LEN = 12
MAX_DNS_PACKET_LEN = 4096
MAX_TCP_DNS_LEN = 65535
MAX_HTTP_HEADER_BYTES = 16384
EDNS_UDP_PAYLOAD = 1232   # рекомендованный размер UDP-ответа (DNS Flag Day 2020)
MIN_UDP_PAYLOAD = 512

# Типы записей и классы
QTYPE_A = 1
QTYPE_NS = 2
QTYPE_CNAME = 5
QTYPE_SOA = 6
QTYPE_PTR = 12
QTYPE_MX = 15
QTYPE_TXT = 16
QTYPE_AAAA = 28
QTYPE_OPT = 41
QTYPE_SVCB = 64
QTYPE_HTTPS = 65
QTYPE_ANY = 255
QCLASS_IN = 1

QTYPE_NAMES = {
    QTYPE_A: "A", QTYPE_NS: "NS", QTYPE_CNAME: "CNAME", QTYPE_SOA: "SOA", QTYPE_PTR: "PTR",
    QTYPE_MX: "MX", QTYPE_TXT: "TXT", QTYPE_AAAA: "AAAA", QTYPE_OPT: "OPT",
    QTYPE_SVCB: "SVCB", QTYPE_HTTPS: "HTTPS", QTYPE_ANY: "ANY",
}

# Коды ответа
RCODE_NOERROR = 0
RCODE_FORMERR = 1
RCODE_SERVFAIL = 2
RCODE_NXDOMAIN = 3
RCODE_NOTIMP = 4
RCODE_REFUSED = 5

# Флаги заголовка
FLAG_QR = 0x8000
FLAG_OPCODE_MASK = 0x7800
FLAG_AA = 0x0400
FLAG_TC = 0x0200
FLAG_RD = 0x0100
FLAG_RA = 0x0080
FLAG_AD = 0x0020
FLAG_CD = 0x0010
FLAG_RCODE_MASK = 0x000F

MAX_NAME_LEN = 255
MAX_LABEL_LEN = 63


# =============================================================================
# Разбор wire-формата DNS
# =============================================================================


def read_name(wire: bytes, offset: int):
    """Читает доменное имя (с поддержкой compression pointers) начиная с offset.

    Возвращает (labels: list[bytes], end_offset) — где end_offset указывает на
    байт сразу после имени в исходном месте (после первого указателя, если он был).
    Бросает ValueError на некорректных данных.
    """
    length = len(wire)
    labels = []
    end = -1
    jumps = 0
    total = 0
    pos = offset
    while True:
        if pos >= length:
            raise ValueError("name runs past end of packet")
        ll = wire[pos]
        if ll == 0:
            pos += 1
            break
        if (ll & 0xC0) == 0xC0:
            if pos + 1 >= length:
                raise ValueError("truncated compression pointer")
            ptr = ((ll & 0x3F) << 8) | wire[pos + 1]
            if ptr >= pos:
                raise ValueError("forward compression pointer")
            if end < 0:
                end = pos + 2
            jumps += 1
            if jumps > 32:
                raise ValueError("too many compression pointers")
            pos = ptr
            continue
        if (ll & 0xC0) != 0:
            raise ValueError("unsupported label type")
        if pos + 1 + ll > length:
            raise ValueError("label runs past end of packet")
        labels.append(bytes(wire[pos + 1:pos + 1 + ll]))
        total += ll + 1
        if total > MAX_NAME_LEN:
            raise ValueError("name too long")
        pos += 1 + ll
    if end < 0:
        end = pos
    return labels, end


def labels_to_name(labels) -> str:
    """Список меток -> строчное имя без завершающей точки («» для корня)."""
    return ".".join(lb.decode("ascii", errors="replace") for lb in labels).lower()


def encode_name(name: str) -> bytes:
    """Строка -> wire-формат имени (без компрессии)."""
    name = (name or "").strip().rstrip(".")
    if not name:
        return b"\x00"
    out = bytearray()
    for label in name.split("."):
        raw = label.encode("idna") if any(ord(ch) > 127 for ch in label) else label.encode("ascii")
        if not raw or len(raw) > MAX_LABEL_LEN:
            raise ValueError("bad label length")
        out.append(len(raw))
        out += raw
    out.append(0)
    if len(out) > MAX_NAME_LEN:
        raise ValueError("name too long")
    return bytes(out)


def skip_rr(wire: bytes, offset: int):
    """Пропускает одну RR (имя + 10 байт фиксированной части + rdata). Возвращает
    (end_offset, rtype, rclass, ttl, rdata_offset, rdlength)."""
    _labels, pos = read_name(wire, offset)
    if pos + 10 > len(wire):
        raise ValueError("truncated RR header")
    rtype, rclass, ttl, rdlength = struct.unpack("!HHIH", wire[pos:pos + 10])
    pos += 10
    if pos + rdlength > len(wire):
        raise ValueError("truncated RR rdata")
    return pos + rdlength, rtype, rclass, ttl, pos, rdlength


Question = namedtuple("Question", "qname qtype qclass has_edns edns_payload do_bit")
Question.__doc__ = ("Первый вопрос DNS-запроса: qname (строчными, без точки), qtype, qclass, "
                    "наличие OPT, заявленный размер UDP-ответа и бит DO.")


def parse_question(wire: bytes) -> Question:
    """Разбирает заголовок, первый вопрос и OPT-запись (если есть) DNS-запроса.

    Бросает ValueError, если пакет не похож на корректный запрос с одним вопросом.
    """
    if len(wire) < MIN_DNS_PACKET_LEN:
        raise ValueError("packet shorter than DNS header")
    _qid, flags, qdcount, ancount, nscount, arcount = struct.unpack("!HHHHHH", wire[:12])
    if flags & FLAG_QR:
        raise ValueError("packet is a response, not a query")
    if qdcount < 1:
        raise ValueError("query without question")
    labels, pos = read_name(wire, 12)
    if pos + 4 > len(wire):
        raise ValueError("truncated question")
    qtype, qclass = struct.unpack("!HH", wire[pos:pos + 4])
    pos += 4
    qname = labels_to_name(labels)

    has_edns = False
    edns_payload = MIN_UDP_PAYLOAD
    do_bit = False
    if arcount > 0:
        try:
            # пропускаем остальные вопросы и an/ns секции (в запросах их почти не бывает)
            for _ in range(qdcount - 1):
                _l, pos = read_name(wire, pos)
                pos += 4
            for _ in range(ancount + nscount):
                pos, _t, _c, _ttl, _ro, _rl = skip_rr(wire, pos)
            for _ in range(arcount):
                pos, rtype, rclass, ttl, _ro, _rl = skip_rr(wire, pos)
                if rtype == QTYPE_OPT:
                    has_edns = True
                    edns_payload = max(MIN_UDP_PAYLOAD, rclass)
                    do_bit = bool(ttl & 0x8000)
                    break
        except ValueError:
            # битая additional-секция не мешает ответить на сам вопрос
            pass
    return Question(qname, qtype, qclass, has_edns, edns_payload, do_bit)


def question_end(wire: bytes) -> int:
    """Смещение конца первого вопроса (для копирования вопроса в ответ)."""
    _labels, pos = read_name(wire, 12)
    if pos + 4 > len(wire):
        raise ValueError("truncated question")
    return pos + 4


def a_record(qname: str, ip: str, ttl: int):
    """Кортеж RR (name, type, class, ttl, rdata) для записи A."""
    return (qname, QTYPE_A, QCLASS_IN, int(ttl), ipaddress.IPv4Address(ip).packed)


def aaaa_record(qname: str, ip: str, ttl: int):
    """Кортеж RR для записи AAAA."""
    return (qname, QTYPE_AAAA, QCLASS_IN, int(ttl), ipaddress.IPv6Address(ip).packed)


def build_response(query_wire: bytes, answers=None, rcode: int = RCODE_NOERROR,
                   copy_opt: bool = True, tc: bool = False, aa: bool = False) -> bytes:
    """Собирает ответ на запрос: копирует ID, OPCODE, RD, CD и вопрос, ставит QR=1,
    RA=1, AA=0 (если не задано), AD=0, добавляет answers и — если в запросе был OPT
    и copy_opt — OPT-запись с UDP payload 1232 и сохранённым битом DO.

    answers: список кортежей (name, type, class, ttl, rdata). Имя, совпадающее с
    qname, сжимается указателем на вопрос.
    Бросает ValueError, если вопрос в запросе не разбирается.
    """
    answers = list(answers or [])
    q = parse_question(query_wire)
    qend = question_end(query_wire)
    _qid, qflags = struct.unpack("!HH", query_wire[:4])

    flags = FLAG_QR | FLAG_RA | (qflags & (FLAG_OPCODE_MASK | FLAG_RD | FLAG_CD))
    if tc:
        flags |= FLAG_TC
    if aa:
        flags |= FLAG_AA
    flags |= (int(rcode) & FLAG_RCODE_MASK)

    arcount = 1 if (q.has_edns and copy_opt) else 0
    out = bytearray(query_wire[:2])
    out += struct.pack("!HHHHH", flags, 1, len(answers), 0, arcount)
    out += query_wire[12:qend]

    for name, rtype, rclass, ttl, rdata in answers:
        if str(name).lower().rstrip(".") == q.qname:
            out += b"\xC0\x0C"
        else:
            out += encode_name(str(name))
        out += struct.pack("!HHIH", int(rtype), int(rclass), int(ttl) & 0xFFFFFFFF, len(rdata))
        out += rdata

    if arcount:
        opt_ttl = 0x8000 if q.do_bit else 0  # ext-rcode=0, version=0, DO как в запросе
        out += b"\x00" + struct.pack("!HHIH", QTYPE_OPT, EDNS_UDP_PAYLOAD, opt_ttl, 0)
    return bytes(out)


def build_refused(query_wire: bytes) -> bytes:
    """REFUSED без ответов (с эхом OPT, если был)."""
    return build_response(query_wire, [], rcode=RCODE_REFUSED)


def build_nodata(query_wire: bytes) -> bytes:
    """NOERROR с пустой секцией ответов (NODATA) — для AAAA/HTTPS/SVCB проксируемых доменов."""
    return build_response(query_wire, [], rcode=RCODE_NOERROR)


def build_servfail(query_wire: bytes) -> bytes:
    """SERVFAIL без ответов."""
    return build_response(query_wire, [], rcode=RCODE_SERVFAIL)


def build_truncated(query_wire: bytes) -> bytes:
    """Ответ с TC=1 и только вопросом — клиент повторит запрос по TCP."""
    return build_response(query_wire, [], rcode=RCODE_NOERROR, tc=True)


def build_header_only(query_wire: bytes, rcode: int) -> bytes:
    """Ответ из одного заголовка (QDCOUNT=0) — когда вопрос в запросе не разбирается.
    Требует хотя бы 12 байт заголовка, иначе ValueError."""
    if len(query_wire) < MIN_DNS_PACKET_LEN:
        raise ValueError("packet shorter than DNS header")
    _qid, qflags = struct.unpack("!HH", query_wire[:4])
    flags = FLAG_QR | FLAG_RA | (qflags & (FLAG_OPCODE_MASK | FLAG_RD)) | (int(rcode) & FLAG_RCODE_MASK)
    return query_wire[:2] + struct.pack("!HHHHH", flags, 0, 0, 0, 0)


def response_rcode(wire: bytes) -> int:
    """RCODE из заголовка ответа (-1, если пакет короче заголовка)."""
    if len(wire) < 4:
        return -1
    return wire[3] & FLAG_RCODE_MASK


def extract_min_ttl(packet: bytes, default_ttl: int = 60, max_ttl: int = 3600) -> int:
    """Минимальный TTL по секциям answer/authority — для Cache-Control в DoH."""
    if len(packet) < MIN_DNS_PACKET_LEN:
        return default_ttl
    try:
        _qid, flags, qdcount, ancount, nscount, arcount = struct.unpack("!HHHHHH", packet[:12])
        rcode = flags & 0x000F
        if rcode != 0:
            return 10
        rr_total = ancount + nscount
        if rr_total == 0:
            return default_ttl

        offset = 12
        length = len(packet)

        def skip_name(pos: int) -> int:
            jumps = 0
            while pos < length:
                label_len = packet[pos]
                if label_len == 0:
                    return pos + 1
                if (label_len & 0xC0) == 0xC0:
                    return pos + 2
                if (label_len & 0xC0) != 0:
                    return -1
                pos += 1 + label_len
                jumps += 1
                if jumps > 128:
                    return -1
            return -1

        for _ in range(qdcount):
            offset = skip_name(offset)
            if offset < 0 or offset + 4 > length:
                return default_ttl
            offset += 4

        min_ttl = None
        for _ in range(rr_total):
            offset = skip_name(offset)
            if offset < 0 or offset + 10 > length:
                break
            rtype, _rclass, ttl, rdlength = struct.unpack("!HHIH", packet[offset:offset + 10])
            offset += 10
            if offset + rdlength > length:
                break
            offset += rdlength
            if rtype != QTYPE_OPT:  # OPT (EDNS0) не несёт TTL
                if min_ttl is None or ttl < min_ttl:
                    min_ttl = ttl

        if min_ttl is None:
            return default_ttl
        return max(1, min(int(min_ttl), max_ttl))
    except Exception:
        return default_ttl


# =============================================================================
# TCP-фрейминг (RFC 7766)
# =============================================================================


def frame_tcp(wire: bytes) -> bytes:
    """DNS-сообщение -> кадр TCP с 2-байтовым префиксом длины."""
    if len(wire) > MAX_TCP_DNS_LEN:
        raise ValueError("DNS message too long for TCP framing")
    return struct.pack("!H", len(wire)) + wire


def unframe_tcp(buf: bytes):
    """Выделяет из буфера все полные кадры. Возвращает (messages, rest)."""
    msgs = []
    pos = 0
    n = len(buf)
    while pos + 2 <= n:
        (ln,) = struct.unpack("!H", buf[pos:pos + 2])
        if pos + 2 + ln > n:
            break
        msgs.append(bytes(buf[pos + 2:pos + 2 + ln]))
        pos += 2 + ln
    return msgs, bytes(buf[pos:])


async def read_tcp_message(reader: asyncio.StreamReader, timeout: float, max_len: int = MAX_DNS_PACKET_LEN):
    """Читает один кадр DNS-over-TCP. None при EOF до начала кадра, ValueError на
    неверной длине, asyncio.TimeoutError при простое дольше timeout."""
    try:
        hdr = await asyncio.wait_for(reader.readexactly(2), timeout=timeout)
    except asyncio.IncompleteReadError:
        return None
    (ln,) = struct.unpack("!H", hdr)
    if ln < MIN_DNS_PACKET_LEN or ln > max_len:
        raise ValueError("invalid TCP DNS frame length %d" % ln)
    try:
        return await asyncio.wait_for(reader.readexactly(ln), timeout=timeout)
    except asyncio.IncompleteReadError:
        return None


# =============================================================================
# Хэширование IP с суточной солью
# =============================================================================


def utc_day(now: float = None) -> int:
    """Номер суток UTC (как в stats_collector.py)."""
    return int((time.time() if now is None else now) // 86400)


def daily_salt(seed: str, day: int = None) -> str:
    """Детерминированная суточная соль: одинакова на всех узлах с тем же seed."""
    if day is None:
        day = utc_day()
    raw = ("pereval-dns-v1:%s:%d" % (seed, day)).encode("utf-8")
    return hashlib.blake2b(raw, digest_size=16).hexdigest()


def hash_ip(ip: str, seed: str, day: int = None) -> str:
    """16 hex-символов blake2b(соль_суток + ':' + ip). Сам IP никуда не пишется."""
    salt = daily_salt(seed, day)
    return hashlib.blake2b(("%s:%s" % (salt, ip)).encode("utf-8"), digest_size=8).hexdigest()


def normalize_ip(raw: str):
    """Строка -> каноничный IP (IPv4-mapped IPv6 -> IPv4). None, если это не IP."""
    try:
        addr = ipaddress.ip_address(str(raw).strip().split("%", 1)[0])
    except ValueError:
        return None
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        return str(mapped)
    return str(addr)


# =============================================================================
# In-memory TTL-кеш DNS-ответов и UDP-пул к upstream с TCP-fallback
# =============================================================================


def _extract_rr_min_ttl(packet: bytes):
    """Возвращает минимальный TTL среди RR в секциях answer и authority (или None)."""
    if len(packet) < MIN_DNS_PACKET_LEN:
        return None
    try:
        _qid, _flags, qdcount, ancount, nscount, _arcount = struct.unpack("!HHHHHH", packet[:12])
        rr_total = ancount + nscount
        if rr_total == 0:
            return None
        offset = 12
        length = len(packet)
        for _ in range(qdcount):
            _labels, offset = read_name(packet, offset)
            if offset + 4 > length:
                return None
            offset += 4
        min_ttl = None
        for _ in range(rr_total):
            offset, rtype, _rclass, ttl, _ro, _rl = skip_rr(packet, offset)
            if rtype != QTYPE_OPT:
                if min_ttl is None or ttl < min_ttl:
                    min_ttl = ttl
        return int(min_ttl) if min_ttl is not None else None
    except Exception:
        return None


def _packet_question_key(wire: bytes):
    """Извлекает ключ кеша (qname, qtype, qclass, do_bit) из DNS-запроса или ответа."""
    if len(wire) < MIN_DNS_PACKET_LEN:
        return None
    try:
        _qid, _flags, qdcount, ancount, nscount, arcount = struct.unpack("!HHHHHH", wire[:12])
        if qdcount < 1:
            return None
        labels, pos = read_name(wire, 12)
        if pos + 4 > len(wire):
            return None
        qtype, qclass = struct.unpack("!HH", wire[pos:pos + 4])
        pos += 4
        qname = labels_to_name(labels)
        do_bit = False
        if arcount > 0:
            try:
                for _ in range(qdcount - 1):
                    _l, pos = read_name(wire, pos)
                    pos += 4
                for _ in range(ancount + nscount):
                    pos, _t, _c, _ttl, _ro, _rl = skip_rr(wire, pos)
                for _ in range(arcount):
                    pos, rtype, _rclass, ttl, _ro, _rl = skip_rr(wire, pos)
                    if rtype == QTYPE_OPT:
                        do_bit = bool(ttl & 0x8000)
                        break
            except ValueError:
                pass
        return (qname, int(qtype), int(qclass), bool(do_bit))
    except Exception:
        return None


class DnsCache:
    """In-memory LRU/TTL-кеш DNS-ответов (NOERROR и NXDOMAIN) с подменой transaction ID."""

    def __init__(self, max_entries: int = 50000, min_ttl: int = 5, max_ttl: int = 3600, negative_ttl: int = 30):
        self.max_entries = max(1, int(max_entries))
        self.min_ttl = max(1, int(min_ttl))
        self.max_ttl = max(self.min_ttl, int(max_ttl))
        self.negative_ttl = max(1, int(negative_ttl))
        self._store = OrderedDict()  # key -> (expires_at, wire_response)
        self.hits = 0
        self.misses = 0

    @staticmethod
    def _now(now: float = None) -> float:
        return time.monotonic() if now is None else float(now)

    def __len__(self) -> int:
        return len(self._store)

    def clear(self) -> None:
        self._store.clear()

    def prune(self, now: float = None) -> int:
        ts = self._now(now)
        expired = [k for k, (exp, _w) in self._store.items() if exp <= ts]
        for k in expired:
            self._store.pop(k, None)
        return len(expired)

    def get(self, query_wire: bytes, now: float = None):
        if not isinstance(query_wire, (bytes, bytearray)) or len(query_wire) < MIN_DNS_PACKET_LEN:
            self.misses += 1
            return None
        key = _packet_question_key(query_wire)
        if key is None:
            self.misses += 1
            return None
        ts = self._now(now)
        entry = self._store.get(key)
        if entry is None:
            self.misses += 1
            return None
        expires_at, wire_resp = entry
        if expires_at <= ts:
            self._store.pop(key, None)
            self.misses += 1
            return None
        self._store.move_to_end(key)
        self.hits += 1
        return bytes(query_wire[:2]) + wire_resp[2:]

    def put(self, query_or_resp: bytes, response: bytes = None, ttl: int = None, now: float = None) -> bool:
        if response is None:
            wire_resp = bytes(query_or_resp or b"")
            key = _packet_question_key(wire_resp)
        else:
            wire_resp = bytes(response or b"")
            key = _packet_question_key(query_or_resp) if isinstance(query_or_resp, (bytes, bytearray)) else None
            if key is None:
                key = _packet_question_key(wire_resp)
        if key is None or len(wire_resp) < MIN_DNS_PACKET_LEN:
            return False
        # Не кешируем усечённые ответы (TC=1) и ошибки кроме NOERROR/NXDOMAIN
        if wire_resp[2] & 0x02:
            return False
        rcode = response_rcode(wire_resp)
        if rcode not in (RCODE_NOERROR, RCODE_NXDOMAIN):
            return False

        if ttl is None:
            rr_ttl = _extract_rr_min_ttl(wire_resp)
            if rcode == RCODE_NXDOMAIN:
                eff_ttl = rr_ttl if rr_ttl is not None else self.negative_ttl
                eff_ttl = max(1, min(eff_ttl, self.max_ttl))
            else:
                if rr_ttl is None:
                    eff_ttl = self.negative_ttl
                elif rr_ttl <= 0:
                    return False
                else:
                    eff_ttl = max(self.min_ttl, min(rr_ttl, self.max_ttl))
        else:
            eff_ttl = int(ttl)
            if eff_ttl <= 0:
                return False
            eff_ttl = min(eff_ttl, self.max_ttl)

        ts = self._now(now)
        self._store[key] = (ts + eff_ttl, wire_resp)
        self._store.move_to_end(key)
        while len(self._store) > self.max_entries:
            self._store.popitem(last=False)
        return True

    def stats(self) -> dict:
        return {
            "size": len(self._store),
            "hits": self.hits,
            "misses": self.misses,
            "max_entries": self.max_entries,
        }


def parse_upstreams(spec, default_port: int = 53) -> list:
    """Разбирает строку вида '1.1.1.1:53,8.8.8.8:53' или список в [(host, port), ...]."""
    out = []
    if isinstance(spec, (list, tuple)):
        items = list(spec)
    elif isinstance(spec, str):
        items = [part.strip() for part in spec.split(",") if part.strip()]
    else:
        items = []

    for item in items:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            host = str(item[0]).strip()
            port = int(item[1])
            if host:
                out.append((host, port))
            continue
        raw = str(item or "").strip()
        if not raw:
            continue
        host = raw
        port = int(default_port)
        if raw.startswith("[") and "]" in raw:
            end = raw.index("]")
            host = raw[1:end].strip()
            rest = raw[end + 1:].strip()
            if rest.startswith(":"):
                port = int(rest[1:])
        elif raw.count(":") == 1:
            h_part, p_part = raw.rsplit(":", 1)
            host = h_part.strip()
            port = int(p_part.strip())
        if host:
            out.append((host, port))
    return out


class _UdpDnsSocketProtocol(asyncio.DatagramProtocol):
    """Мультиплексирует до 65536 одновременных запросов через один connected UDP-сокет."""

    def __init__(self, upstream=None):
        self.upstream = upstream
        self.transport = None
        self.pending = {}  # txid -> asyncio.Future
        self._next_id = 0

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data: bytes, _addr):
        if len(data) < MIN_DNS_PACKET_LEN:
            return
        txid = (data[0] << 8) | data[1]
        fut = self.pending.pop(txid, None)
        if fut is not None and not fut.done():
            fut.set_result(data)

    def error_received(self, exc):
        pass

    def connection_lost(self, exc):
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(exc or ConnectionError("UDP transport closed"))
        self.pending.clear()

    def allocate_txid(self) -> int:
        for _ in range(65536):
            txid = self._next_id
            self._next_id = (txid + 1) & 0xFFFF
            if txid not in self.pending:
                return txid
        return -1


class UdpDnsPool:
    """Пул постоянных connected UDP-сокетов к одному или нескольким внешним upstream DNS."""

    def __init__(
        self,
        upstream_host="1.1.1.1",
        upstream_port: int = 53,
        pool_size: int = 8,
        timeout: float = 2.5,
        upstreams=None,
        cache: DnsCache = None,
    ):
        if upstreams is not None:
            parsed = parse_upstreams(upstreams, default_port=upstream_port)
        elif isinstance(upstream_host, (list, tuple)):
            parsed = parse_upstreams(upstream_host, default_port=upstream_port)
        elif isinstance(upstream_host, str) and ("," in upstream_host or ":" in upstream_host):
            parsed = parse_upstreams(upstream_host, default_port=upstream_port)
        else:
            parsed = [(str(upstream_host), int(upstream_port))]
        if not parsed:
            parsed = [("1.1.1.1", 53)]
        self.upstreams = parsed
        self.upstream_host, self.upstream_port = self.upstreams[0]
        self.pool_size = max(1, int(pool_size))
        self.timeout = timeout
        self.cache = cache
        self.protocols = []
        self._rr = 0

    async def start(self):
        loop = asyncio.get_running_loop()
        total_sockets = max(self.pool_size, len(self.upstreams))
        for i in range(total_sockets):
            target = self.upstreams[i % len(self.upstreams)]
            _, proto = await loop.create_datagram_endpoint(
                lambda t=target: _UdpDnsSocketProtocol(upstream=t),
                remote_addr=target,
            )
            self.protocols.append(proto)

    def close(self):
        for proto in self.protocols:
            if proto.transport is not None:
                proto.transport.close()
        self.protocols.clear()

    async def _query_proto(self, proto: _UdpDnsSocketProtocol, wire_query: bytes, tcp_fallback: bool):
        orig_id = wire_query[:2]
        txid = proto.allocate_txid()
        if txid < 0 or proto.transport is None:
            return await self.query_tcp(wire_query, upstream=proto.upstream), True

        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        proto.pending[txid] = fut
        try:
            rewritten = struct.pack("!H", txid) + wire_query[2:]
            proto.transport.sendto(rewritten)
            resp = await asyncio.wait_for(fut, timeout=self.timeout)
        finally:
            proto.pending.pop(txid, None)

        resp = orig_id + resp[2:]
        was_tc = bool(len(resp) >= 4 and (resp[2] & 0x02))
        if tcp_fallback and was_tc:
            try:
                return await self.query_tcp(wire_query, upstream=proto.upstream), True
            except Exception:
                return resp, True
        return resp, was_tc

    async def query(self, wire_query: bytes, tcp_fallback: bool = True, use_cache: bool = True) -> bytes:
        """Отправляет запрос по UDP (с проверкой DnsCache и перебором апстримов при ошибке/таймауте)."""
        if len(wire_query) < MIN_DNS_PACKET_LEN or len(wire_query) > MAX_DNS_PACKET_LEN:
            raise ValueError("invalid DNS query size")
        if self.cache is not None and use_cache:
            cached = self.cache.get(wire_query)
            if cached is not None:
                return cached

        if not self.protocols:
            resp = await self.query_tcp(wire_query)
            if self.cache is not None and use_cache and resp:
                self.cache.put(wire_query, resp)
            return resp

        start_idx = self._rr
        self._rr += 1
        n_protos = len(self.protocols)
        # Пробуем выбранный сокет, а при ошибке/таймауте — сокеты других апстримов
        tried_upstreams = set()
        last_exc = None
        last_resp = None
        for step in range(n_protos):
            proto = self.protocols[(start_idx + step) % n_protos]
            if step > 0 and proto.upstream in tried_upstreams:
                continue
            tried_upstreams.add(proto.upstream)
            try:
                resp, was_tc = await self._query_proto(proto, wire_query, tcp_fallback)
                last_resp = resp
                if response_rcode(resp) == RCODE_SERVFAIL and len(tried_upstreams) < len(self.upstreams):
                    continue
                if not was_tc and self.cache is not None and use_cache and resp:
                    self.cache.put(wire_query, resp)
                return resp
            except Exception as exc:
                last_exc = exc
                continue

        if last_resp is not None:
            return last_resp
        if last_exc is not None:
            raise last_exc
        return await self.query_tcp(wire_query)

    async def query_tcp(self, wire_query: bytes, upstream=None) -> bytes:
        targets = [upstream] if upstream else list(self.upstreams)
        last_exc = None
        for host, port in targets:
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(host, port),
                    timeout=self.timeout,
                )
                try:
                    writer.write(frame_tcp(wire_query))
                    await asyncio.wait_for(writer.drain(), timeout=self.timeout)
                    hdr = await asyncio.wait_for(reader.readexactly(2), timeout=self.timeout)
                    (resp_len,) = struct.unpack("!H", hdr)
                    if resp_len < MIN_DNS_PACKET_LEN or resp_len > MAX_TCP_DNS_LEN:
                        raise ValueError("invalid TCP DNS response length")
                    return await asyncio.wait_for(reader.readexactly(resp_len), timeout=self.timeout)
                finally:
                    writer.close()
                    try:
                        await writer.wait_closed()
                    except Exception:
                        pass
            except Exception as exc:
                last_exc = exc
                continue
        if last_exc is not None:
            raise last_exc
        raise ConnectionError("no upstreams available")


# =============================================================================
# DoH: base64url и HTTP/1.1 keep-alive сервер
# =============================================================================


def decode_base64url_dns(param: str) -> bytes:
    """Декодирует параметр `dns` RFC 8484 (base64url без паддинга)."""
    cleaned = param.strip()
    if not cleaned:
        raise ValueError("empty dns parameter")
    pad = (-len(cleaned)) % 4
    if pad:
        cleaned += "=" * pad
    raw = base64.urlsafe_b64decode(cleaned.encode("ascii"))
    if len(raw) < MIN_DNS_PACKET_LEN or len(raw) > MAX_DNS_PACKET_LEN:
        raise ValueError("DNS packet length out of bounds")
    return raw


def encode_base64url_dns(wire: bytes) -> str:
    """Обратное преобразование — для клиентов и тестов."""
    return base64.urlsafe_b64encode(wire).decode("ascii").rstrip("=")


HttpRequest = namedtuple("HttpRequest", "method target path query headers body keep_alive version peer")
HttpRequest.__doc__ = ("Разобранный HTTP/1.1-запрос: заголовки — dict с ключами в нижнем регистре, "
                       "peer — адрес клиента из транспорта (может быть None).")

HTTP_REASONS = {
    200: "OK", 204: "No Content", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 411: "Length Required", 413: "Payload Too Large",
    415: "Unsupported Media Type",
    429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
    503: "Service Unavailable", 504: "Gateway Timeout",
}


class HttpServerBase:
    """Минимальный HTTP/1.1 сервер с keep-alive: читает запросы по одному и отдаёт
    их в handle_request(writer, req) -> bool (продолжать ли соединение).

    Тело ограничено max_body (по умолчанию размером DNS-сообщения) — сервер
    рассчитан на nginx-upstream с маленькими запросами, а не на весь интернет.
    """

    header_timeout = 30.0
    body_timeout = 5.0
    max_body = MAX_DNS_PACKET_LEN

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        peer = writer.get_extra_info("peername")
        try:
            while True:
                try:
                    header_block = await asyncio.wait_for(
                        reader.readuntil(b"\r\n\r\n"),
                        timeout=self.header_timeout,
                    )
                except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError):
                    break
                except asyncio.LimitOverrunError:
                    await self.send_response(writer, 413, b"Header too large", keep_alive=False)
                    break

                if len(header_block) > MAX_HTTP_HEADER_BYTES:
                    await self.send_response(writer, 413, b"Header too large", keep_alive=False)
                    break

                lines = header_block[:-4].decode("latin-1", errors="replace").split("\r\n")
                if not lines or not lines[0]:
                    break

                parts = lines[0].split(" ")
                if len(parts) != 3:
                    await self.send_response(writer, 400, b"Bad Request", keep_alive=False)
                    break

                method, target, version = parts[0].upper(), parts[1], parts[2].upper()
                headers = {}
                for hline in lines[1:]:
                    if ":" in hline:
                        k, v = hline.split(":", 1)
                        headers[k.strip().lower()] = v.strip()

                conn_hdr = headers.get("connection", "").lower()
                if version == "HTTP/1.0":
                    keep_alive = conn_hdr == "keep-alive"
                else:
                    keep_alive = conn_hdr != "close"

                content_length = 0
                if "content-length" in headers:
                    try:
                        content_length = int(headers["content-length"])
                    except ValueError:
                        await self.send_response(writer, 400, b"Invalid Content-Length", keep_alive=False)
                        break
                    if content_length < 0 or content_length > self.max_body:
                        await self.send_response(writer, 413, b"Payload Too Large", keep_alive=False)
                        break
                elif "chunked" in headers.get("transfer-encoding", "").lower():
                    await self.send_response(writer, 411, b"Length Required", keep_alive=False)
                    break

                body = b""
                if content_length > 0:
                    try:
                        body = await asyncio.wait_for(reader.readexactly(content_length), timeout=self.body_timeout)
                    except (asyncio.IncompleteReadError, asyncio.TimeoutError):
                        break

                parsed = urlsplit(target)
                req = HttpRequest(method, target, parsed.path, parsed.query, headers, body,
                                  keep_alive, version, peer)
                keep_alive = await self.handle_request(writer, req)
                if not keep_alive:
                    break
        except Exception:
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def handle_request(self, writer: asyncio.StreamWriter, req: HttpRequest) -> bool:
        raise NotImplementedError

    @staticmethod
    async def send_response(
        writer: asyncio.StreamWriter,
        status: int,
        body: bytes,
        content_type: str = "text/plain; charset=utf-8",
        keep_alive: bool = True,
        content_length_override: int = None,
        extra_headers: str = "",
    ):
        reason = HTTP_REASONS.get(status, "OK")
        clen = len(body) if content_length_override is None else content_length_override
        conn_val = "keep-alive" if keep_alive else "close"
        head = (
            "HTTP/1.1 %d %s\r\n"
            "Content-Type: %s\r\n"
            "Content-Length: %d\r\n"
            "Connection: %s\r\n"
            "%s"
            "\r\n" % (status, reason, content_type, clen, conn_val, extra_headers)
        ).encode("latin-1")
        writer.write(head + body)
        await writer.drain()

    @staticmethod
    async def send_json(writer: asyncio.StreamWriter, status: int, obj, keep_alive: bool = True):
        import json
        body = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        await HttpServerBase.send_response(
            writer, status, body, content_type="application/json; charset=utf-8",
            keep_alive=keep_alive, extra_headers="Cache-Control: no-store\r\n",
        )


class DohHttpServer(HttpServerBase):
    """RFC 8484 DoH поверх HttpServerBase: GET /dns-query?dns=<base64url>,
    POST /dns-query (application/dns-message), HEAD, CORS OPTIONS и GET /healthz.

    Точки расширения для наследников:
      * authorize(req) -> None | (status, body)  — проверка до обращения к DNS;
      * resolve(wire_query, req) -> bytes       — сам ответ (по умолчанию dns_pool.query);
      * handle_other(writer, req) -> bool       — остальные пути (по умолчанию 404).
    """

    def __init__(self, dns_pool: UdpDnsPool = None, endpoint_path: str = "/dns-query", max_inflight: int = 4096):
        self.dns_pool = dns_pool
        self.endpoint_path = endpoint_path
        self._sem = asyncio.Semaphore(max_inflight)

    async def authorize(self, req: HttpRequest):
        return None

    async def resolve(self, wire_query: bytes, req: HttpRequest) -> bytes:
        return await self.dns_pool.query(wire_query)

    async def handle_other(self, writer: asyncio.StreamWriter, req: HttpRequest) -> bool:
        await self.send_response(writer, 404, b"Not Found", keep_alive=req.keep_alive)
        return req.keep_alive

    async def handle_request(self, writer: asyncio.StreamWriter, req: HttpRequest) -> bool:
        keep_alive = req.keep_alive
        method = req.method

        if req.path == "/healthz":
            await self.send_response(writer, 200, b"ok\n", content_type="text/plain", keep_alive=keep_alive)
            return keep_alive

        if req.path != self.endpoint_path:
            return await self.handle_other(writer, req)

        if method == "OPTIONS":
            await self.send_response(
                writer,
                204,
                b"",
                content_type="text/plain",
                keep_alive=keep_alive,
                extra_headers=(
                    "Access-Control-Allow-Origin: *\r\n"
                    "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                    "Access-Control-Allow-Headers: Content-Type, Accept\r\n"
                    "Access-Control-Max-Age: 86400\r\n"
                ),
            )
            return keep_alive

        wire_query = None
        if method == "POST":
            ctype = req.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if ctype and ctype != DNS_MEDIA_TYPE:
                await self.send_response(writer, 415, b"Unsupported Media Type", keep_alive=keep_alive)
                return keep_alive
            if len(req.body) < MIN_DNS_PACKET_LEN or len(req.body) > MAX_DNS_PACKET_LEN:
                await self.send_response(writer, 400, b"Bad DNS message size", keep_alive=keep_alive)
                return keep_alive
            wire_query = req.body
        elif method in ("GET", "HEAD"):
            qs = parse_qs(req.query, keep_blank_values=True)
            dns_vals = qs.get("dns")
            if not dns_vals:
                await self.send_response(
                    writer,
                    400,
                    b"Missing ?dns= parameter (RFC 8484 DNS-over-HTTPS endpoint)\n",
                    content_type="text/plain; charset=utf-8",
                    keep_alive=keep_alive,
                )
                return keep_alive
            try:
                wire_query = decode_base64url_dns(dns_vals[0])
            except Exception:
                await self.send_response(writer, 400, b"Invalid base64url dns parameter", keep_alive=keep_alive)
                return keep_alive
        else:
            await self.send_response(
                writer,
                405,
                b"Method Not Allowed",
                keep_alive=keep_alive,
                extra_headers="Allow: GET, POST, OPTIONS\r\n",
            )
            return keep_alive

        denied = await self.authorize(req)
        if denied is not None:
            status, body = denied
            await self.send_response(writer, status, body, keep_alive=keep_alive)
            return keep_alive

        try:
            async with self._sem:
                wire_resp = await self.resolve(wire_query, req)
        except asyncio.TimeoutError:
            await self.send_response(writer, 504, b"DNS Upstream Timeout", keep_alive=keep_alive)
            return keep_alive
        except Exception:
            await self.send_response(writer, 502, b"DNS Upstream Error", keep_alive=keep_alive)
            return keep_alive

        if not wire_resp:
            await self.send_response(writer, 502, b"DNS Upstream Error", keep_alive=keep_alive)
            return keep_alive

        ttl = extract_min_ttl(wire_resp)
        payload = b"" if method == "HEAD" else wire_resp
        await self.send_response(
            writer,
            200,
            payload,
            content_type=DNS_MEDIA_TYPE,
            keep_alive=keep_alive,
            content_length_override=len(wire_resp),
            extra_headers=(
                "Cache-Control: max-age=%d\r\n"
                "Access-Control-Allow-Origin: *\r\n" % ttl
            ),
        )
        return keep_alive


# =============================================================================
# Асинхронный HTTP/1.1-клиент (control plane)
# =============================================================================


HttpResponse = namedtuple("HttpResponse", "status headers body")


async def _read_chunked(reader: asyncio.StreamReader, max_len: int) -> bytes:
    out = bytearray()
    while True:
        line = await reader.readline()
        if not line:
            raise ValueError("truncated chunked body")
        size_str = line.split(b";", 1)[0].strip()
        size = int(size_str, 16)
        if size == 0:
            # trailers до пустой строки
            while True:
                tl = await reader.readline()
                if not tl or tl in (b"\r\n", b"\n"):
                    break
            break
        chunk = await reader.readexactly(size)
        out += chunk
        if len(out) > max_len:
            raise ValueError("response body too large")
        await reader.readexactly(2)  # CRLF после чанка
    return bytes(out)


async def http_request(url: str, method: str = "GET", headers: dict = None, body: bytes = None,
                       timeout: float = 30.0, ssl_context: ssl.SSLContext = None,
                       max_body: int = 16 * 1024 * 1024) -> HttpResponse:
    """Один HTTP/1.1-запрос (Connection: close) средствами asyncio. Поддерживает
    http/https, Content-Length и chunked. Возвращает HttpResponse(status, headers, body).
    Бросает asyncio.TimeoutError при превышении общего timeout, OSError/ValueError при
    сетевых и протокольных ошибках.
    """
    parts = urlsplit(url)
    scheme = (parts.scheme or "http").lower()
    if scheme not in ("http", "https"):
        raise ValueError("unsupported URL scheme: %s" % scheme)
    host = parts.hostname
    if not host:
        raise ValueError("URL without host")
    port = parts.port or (443 if scheme == "https" else 80)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query

    use_ssl = None
    if scheme == "https":
        use_ssl = ssl_context or ssl.create_default_context()

    async def _do():
        reader, writer = await asyncio.open_connection(
            host, port, ssl=use_ssl, server_hostname=host if use_ssl else None
        )
        try:
            hdrs = {
                "Host": host if port in (80, 443) else "%s:%d" % (host, port),
                "User-Agent": "pereval-node/1.0",
                "Accept": "application/json, */*",
                "Connection": "close",
            }
            for k, v in (headers or {}).items():
                hdrs[k] = v
            payload = body or b""
            if method.upper() in ("POST", "PUT", "PATCH") or payload:
                hdrs["Content-Length"] = str(len(payload))
            head = "%s %s HTTP/1.1\r\n" % (method.upper(), path)
            head += "".join("%s: %s\r\n" % (k, v) for k, v in hdrs.items())
            head += "\r\n"
            writer.write(head.encode("latin-1") + payload)
            await writer.drain()

            status_line = await reader.readline()
            if not status_line:
                raise ConnectionError("empty response from server")
            sparts = status_line.decode("latin-1", errors="replace").split(" ", 2)
            if len(sparts) < 2 or not sparts[0].startswith("HTTP/"):
                raise ValueError("malformed status line")
            status = int(sparts[1])
            resp_headers = {}
            while True:
                line = await reader.readline()
                if not line or line in (b"\r\n", b"\n"):
                    break
                text = line.decode("latin-1", errors="replace").rstrip("\r\n")
                if ":" in text:
                    k, v = text.split(":", 1)
                    resp_headers[k.strip().lower()] = v.strip()

            if status == 304 or status == 204 or method.upper() == "HEAD":
                data = b""
            elif "chunked" in resp_headers.get("transfer-encoding", "").lower():
                data = await _read_chunked(reader, max_body)
            elif "content-length" in resp_headers:
                ln = int(resp_headers["content-length"])
                if ln > max_body:
                    raise ValueError("response body too large")
                data = await reader.readexactly(ln) if ln > 0 else b""
            else:
                data = await reader.read(max_body + 1)
                if len(data) > max_body:
                    raise ValueError("response body too large")
            return HttpResponse(status, resp_headers, data)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    return await asyncio.wait_for(_do(), timeout=timeout)
