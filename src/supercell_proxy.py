#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Мини-демон прозрачного TCP-релея для игр Supercell на порту :9339 (pereval-supercell.service).

Работает на прокси-воркерах «Перевал Pro» под защитой nftables-набора @pro_clients
(правила синхронизирует pro_node_agent.py). Только стандартная библиотека Python 3.9+, asyncio.

Зачем нужен отдельный демон вместо nginx stream:
  Игровые клиенты Supercell (Brawl Stars, Clash Royale, Clash of Clans, Hay Day,
  Boom Beach, Squad Busters, mo.co) подключаются к своим лобби-серверам по TCP/9339 по
  собственному бинарному протоколу Pepper без TLS и без SNI. Первый пакет клиента —
  всегда незашифрованный ClientHello с msg_id == 10100 (первые два байта 0x27 0x74),
  содержащий protocol, key_version, major_version, minor/build и SHA-1 content_hash.

Как работает маршрутизация на одном IP:
  1. Читается заголовок первого пакета (7 байт). Если msg_id != 10100 или длина
     вне [24..1024] байт — сокет мгновенно закрывается (закрытый релей).
  2. По разобранным полям ClientHello (content_hash, major_version, protocol)
     выбирается целевой сервер Supercell :9339:
       - однозначное совпадение по content_hash или major_version -> 0 лишних RTT,
         сразу открывается соединение к апстриму и пересылается стартовый пакет;
       - коллизия major_version между двумя играми или совершенно новый major_version
         (клиент обновился раньше фонового опроса) -> параллельный live-probe этим же
         пакетом ClientHello к кандидатам; выигрывает сокет, ответивший ServerHello
         (20100) или кодом своей игры, после чего соединение бесшовно продолжается,
         а новая сигнатура кешируется в памяти.
  3. На старте и каждые --refresh-interval секунд демон в фоне опрашивает апстримы
     Supercell бинарным поиском major_version (по кодам LoginFailed 20103: 8 = старая,
     9/12 = будущая, 7 = сжатый fingerprint.json) и атомарно сохраняет актуальные
     сигнатуры в --state-file.
"""

import argparse
import asyncio
import json
import os
import signal
import struct
import sys
import time
import zlib
from collections import OrderedDict, namedtuple
from pathlib import Path

LOG_PREFIX = "[supercell-proxy]"

MSG_CLIENT_HELLO = 10100
MSG_SERVER_HELLO = 20100
MSG_LOGIN_FAILED = 20103

HEADER_LEN = 7
MIN_HELLO_PAYLOAD = 24
MAX_HELLO_PAYLOAD = 1024
MAX_PROBE_REPLY_PAYLOAD = 65536

# Коды LoginFailed (20103) в протоколе Supercell
ERR_CONTENT_UPDATE = 7     # несовпадение content_hash (содержит актуальный fingerprint.json)
ERR_CLIENT_TOO_OLD = 8     # версия клиента ниже боевой (ссылка на магазин приложений)
ERR_CLIENT_TOO_NEW = 9     # версия выше боевой (редирект на stage)
ERR_MAINTENANCE = 10       # техработы на целевом сервере
ERR_CLIENT_TOO_NEW_HD = 12 # аналог кода 9 в Hay Day
ERR_BAD_KEY = 16           # чужой key_version / protocol

# Базовые сигнатуры апстримов (сняты с боевых серверов Supercell 2026-11-16;
# автоматически обновляются демоном в фоне и кешируются в --state-file).
DEFAULT_GAMES = (
    {
        "id": "brawlstars",
        "name": "Brawl Stars",
        "host": "game.brawlstarsgame.com",
        "port": 9339,
        "major": 70,
        "protocols": [2],
        "msg_version": 12,
        "vint_error": False,
        "version": "70.820.1",
        "sha": "15f41bec0b4ef44565550ef0a80aea899c7e70a6",
    },
    {
        "id": "clashroyale",
        "name": "Clash Royale",
        "host": "game.clashroyaleapp.com",
        "port": 9339,
        "major": 16,
        "protocols": [3],
        "msg_version": 10,
        "vint_error": True,
        "version": "16.635.0",
        "sha": "",
    },
    {
        "id": "clashofclans",
        "name": "Clash of Clans",
        "host": "gamea.clashofclans.com",
        "port": 9339,
        "major": 18,
        "protocols": [3, 2],
        "msg_version": 13,
        "vint_error": False,
        "version": "18.647.4",
        "sha": "",
    },
    {
        "id": "hayday",
        "name": "Hay Day",
        "host": "game.haydaygame.com",
        "port": 9339,
        "major": 1,
        "protocols": [3],
        "msg_version": 5,
        "vint_error": False,
        "version": "1.73.82",
        "sha": "a737c818aab605beef4e27e9a0f96ba4e3a70921",
    },
    {
        "id": "boombeach",
        "name": "Boom Beach",
        "host": "game.boombeachgame.com",
        "port": 9339,
        "major": 63,
        "protocols": [1],
        "msg_version": 4,
        "vint_error": False,
        "version": "63.216.1",
        "sha": "73f58997c6d1e83b2e608d76900406fbe84e5fe3",
    },
    {
        "id": "squadbusters",
        "name": "Squad Busters",
        "host": "game.squadbustersgame.com",
        "port": 9339,
        "major": 14,
        "protocols": [1],
        "msg_version": 11,
        "vint_error": False,
        "version": "14.415.0",
        "sha": "",
    },
    {
        "id": "moco",
        "name": "mo.co",
        "host": "game.mocogame.com",
        "port": 9339,
        "major": 13,
        "protocols": [1],
        "msg_version": 11,
        "vint_error": False,
        "version": "13.5.1.1",
        "sha": "6bb2cf52ebd2f26a4a7c78154daea6ca2dd371a6",
    },
)

ClientHello = namedtuple(
    "ClientHello",
    "msg_id payload_len msg_version protocol key_version major field4 field5 content_hash raw",
)


def log(msg: str) -> None:
    print("%s %s" % (LOG_PREFIX, msg), file=sys.stderr, flush=True)


def atomic_write_json(path: Path, data) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.parent / (".%s.%d.tmp" % (target.name, os.getpid()))
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(target)


# =============================================================================
# Протокол Supercell (заголовок, ClientHello 10100, LoginFailed 20103)
# =============================================================================


def parse_header(hdr: bytes):
    """Разбирает 7-байтный заголовок пакета Supercell -> (msg_id, payload_len, msg_version)."""
    if len(hdr) != HEADER_LEN:
        raise ValueError("header must be %d bytes, got %d" % (HEADER_LEN, len(hdr)))
    msg_id = struct.unpack(">H", hdr[:2])[0]
    payload_len = int.from_bytes(hdr[2:5], "big")
    msg_version = struct.unpack(">H", hdr[5:7])[0]
    return msg_id, payload_len, msg_version


def validate_client_hello_header(hdr: bytes):
    """Проверяет заголовок первого пакета клиента до чтения тела."""
    msg_id, payload_len, msg_version = parse_header(hdr)
    if msg_id != MSG_CLIENT_HELLO:
        raise ValueError("unexpected first message id: %d" % msg_id)
    if payload_len < MIN_HELLO_PAYLOAD or payload_len > MAX_HELLO_PAYLOAD:
        raise ValueError("invalid ClientHello payload length: %d" % payload_len)
    if msg_version > 64:
        raise ValueError("invalid ClientHello message version: %d" % msg_version)
    return msg_id, payload_len, msg_version


def parse_client_hello(raw: bytes) -> ClientHello:
    """Разбирает полный пакет ClientHello (7 байт заголовка + payload)."""
    if len(raw) < HEADER_LEN + MIN_HELLO_PAYLOAD:
        raise ValueError("packet shorter than minimum ClientHello")
    msg_id, payload_len, msg_version = validate_client_hello_header(raw[:HEADER_LEN])
    if len(raw) != HEADER_LEN + payload_len:
        raise ValueError("packet size mismatch: expected %d, got %d" % (HEADER_LEN + payload_len, len(raw)))
    body = raw[HEADER_LEN:]
    protocol, key_version, major, field4, field5, hash_len = struct.unpack(">iiiiii", body[:24])
    if not (0 <= protocol <= 32):
        raise ValueError("invalid protocol: %d" % protocol)
    if not (0 <= key_version <= 512):
        raise ValueError("invalid key_version: %d" % key_version)
    if not (1 <= major <= 1000):
        raise ValueError("invalid major version: %d" % major)
    if not (0 <= field4 <= 10_000_000 and 0 <= field5 <= 10_000_000):
        raise ValueError("invalid minor/build fields: %d, %d" % (field4, field5))
    if hash_len < -1 or hash_len > 256:
        raise ValueError("invalid content_hash length: %d" % hash_len)
    content_hash = ""
    pos = 24
    if hash_len > 0:
        if pos + hash_len > len(body):
            raise ValueError("content_hash runs past payload")
        raw_hash = body[pos:pos + hash_len]
        try:
            content_hash = raw_hash.decode("ascii").strip().lower()
        except UnicodeDecodeError:
            raise ValueError("non-ascii content_hash")
    return ClientHello(
        msg_id=msg_id,
        payload_len=payload_len,
        msg_version=msg_version,
        protocol=protocol,
        key_version=key_version,
        major=major,
        field4=field4,
        field5=field5,
        content_hash=content_hash,
        raw=bytes(raw),
    )


def build_client_hello(
    protocol: int = 2,
    key_version: int = 50,
    major: int = 1,
    field4: int = 0,
    field5: int = 0,
    content_hash: str = "0" * 40,
    device_type: int = 2,
    app_store: int = 2,
) -> bytes:
    """Собирает тестовый пакет ClientHello (10100) для проверки апстримов."""
    if content_hash is None:
        hbytes = struct.pack(">i", -1)
    else:
        enc = content_hash.encode("ascii")
        hbytes = struct.pack(">i", len(enc)) + enc
    payload = struct.pack(">iiiii", protocol, key_version, major, field4, field5) + hbytes + struct.pack(">ii", device_type, app_store)
    hdr = struct.pack(">H", MSG_CLIENT_HELLO) + len(payload).to_bytes(3, "big") + struct.pack(">H", 0)
    return hdr + payload


def decode_login_failed_code(body: bytes, vint_error: bool = False) -> int:
    """Извлекает код ошибки из начала тела LoginFailed (20103).
    В Clash Royale код кодируется одним байтом VInt, в остальных играх — big-endian int32."""
    if not body:
        return -1
    if vint_error:
        b0 = body[0]
        # В Supercell VInt младшие 6 бит первого байта (при отсутствии знака 0x40) хранят малые положительные числа
        if (b0 & 0xC0) == 0 and (len(body) < 4 or body[:3] != b"\x00\x00\x00"):
            return b0 & 0x3F
    if len(body) >= 4 and body[0] == 0 and body[1] == 0 and body[2] == 0:
        return struct.unpack(">i", body[:4])[0]
    return body[0] & 0x3F


def extract_fingerprint(body: bytes):
    """Извлекает JSON fingerprint ({version, sha, ...}) из ответа LoginFailed с кодом 7
    (поддерживает как открытый JSON, так и сжатое поле zlib)."""
    if not body:
        return None
    idx = body.find(b'{"files"')
    if idx == -1:
        idx = body.find(b'{"sha"')
    if idx != -1:
        end = body.rfind(b"}")
        if end > idx:
            try:
                obj = json.loads(body[idx:end + 1].decode("utf-8"))
                if isinstance(obj, dict) and ("sha" in obj or "version" in obj):
                    return obj
            except Exception:
                pass
    limit = min(len(body) - 6, 512)
    for i in range(max(0, limit)):
        if body[i] == 0x78 and body[i + 1] in (0x01, 0x5E, 0x9C, 0xDA):
            try:
                raw = zlib.decompress(body[i:])
            except Exception:
                continue
            end = raw.rfind(b"}")
            start = raw.find(b"{")
            if start != -1 and end > start:
                try:
                    obj = json.loads(raw[start:end + 1].decode("utf-8"))
                    if isinstance(obj, dict) and ("sha" in obj or "version" in obj):
                        return obj
                except Exception:
                    continue
    return None


def score_upstream_reply(msg_id: int, err_code: int) -> int:
    """Ранжирует ответ апстрима при live-probe с реальным ClientHello клиента:
      3 — ServerHello (20100): точное попадание в целевую игру;
      2 — LoginFailed (20103) с кодом 7 (контент-патч) или 10 (техработы этой игры);
      1 — прочие коды игры, кроме версионных/ключевых отказов чужого сервера;
      0 — чужая игра (8 = слишком старая, 9/12 = слишком новая, 16 = чужой ключ)."""
    if msg_id == MSG_SERVER_HELLO:
        return 3
    if msg_id != MSG_LOGIN_FAILED:
        return 0
    if err_code in (ERR_CONTENT_UPDATE, ERR_MAINTENANCE):
        return 2
    if err_code in (ERR_CLIENT_TOO_OLD, ERR_CLIENT_TOO_NEW, ERR_CLIENT_TOO_NEW_HD, ERR_BAD_KEY, -1):
        return 0
    return 1


# =============================================================================
# Опрос апстримов (бинарный поиск боевого major_version)
# =============================================================================


async def probe_single_hello(host: str, port: int, hello_wire: bytes, timeout: float = 3.0, read_full_body: bool = False):
    """Отправляет один ClientHello апстриму и читает заголовок + (опционально) тело ответа.
    Возвращает (msg_id, msg_version, payload_len, body_bytes)."""
    coro = asyncio.open_connection(host, port)
    reader, writer = await asyncio.wait_for(coro, timeout=timeout)
    try:
        writer.write(hello_wire)
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        hdr = await asyncio.wait_for(reader.readexactly(HEADER_LEN), timeout=timeout)
        msg_id, payload_len, msg_version = parse_header(hdr)
        to_read = payload_len if read_full_body else min(payload_len, 64)
        to_read = min(to_read, MAX_PROBE_REPLY_PAYLOAD)
        body = b""
        if to_read > 0:
            body = await asyncio.wait_for(reader.readexactly(to_read), timeout=timeout)
        return msg_id, msg_version, payload_len, body
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def discover_game_signature(game: dict, timeout: float = 3.0, max_major: int = 200) -> dict:
    """Определяет актуальный боевой major_version апстрима бинарным поиском (8 запросов)
    и при возможности вытаскивает полный version и sha из fingerprint."""
    host = game["host"]
    port = int(game.get("port") or 9339)
    vint_err = bool(game.get("vint_error", False))
    t0 = time.monotonic()

    lo, hi = 1, max_major
    saw_old = False
    saw_new = False
    last_msg_ver = game.get("msg_version")
    found_major = None
    fp = None

    while lo <= hi:
        mid = (lo + hi) // 2
        pkt = build_client_hello(protocol=4, key_version=50, major=mid, field4=0, field5=0)
        msg_id, msg_ver, _plen, body = await probe_single_hello(host, port, pkt, timeout=timeout, read_full_body=False)
        if msg_id not in (MSG_SERVER_HELLO, MSG_LOGIN_FAILED):
            raise RuntimeError("unexpected msg_id=%d from %s:%d" % (msg_id, host, port))
        last_msg_ver = msg_ver
        ec = 0 if msg_id == MSG_SERVER_HELLO else decode_login_failed_code(body, vint_error=vint_err)
        if ec == ERR_CLIENT_TOO_OLD:
            saw_old = True
            lo = mid + 1
        elif ec in (ERR_CLIENT_TOO_NEW, ERR_CLIENT_TOO_NEW_HD):
            saw_new = True
            hi = mid - 1
        else:
            found_major = mid
            break

    if found_major is None and saw_old and saw_new and hi >= 1:
        found_major = hi

    if found_major is None:
        raise RuntimeError("cannot determine live major version for %s:%d (lo=%d, hi=%d)" % (host, port, lo, hi))

    # Пробуем получить сжатый fingerprint (ec == 7) на найденном major с большим build/minor
    for f4, f5 in ((0, 5000), (5000, 0)):
        try:
            pkt = build_client_hello(protocol=2, key_version=50, major=found_major, field4=f4, field5=f5)
            msg_id, msg_ver, plen, _preview = await probe_single_hello(host, port, pkt, timeout=timeout, read_full_body=False)
            if msg_id == MSG_LOGIN_FAILED and plen <= 1_000_000:
                ec = decode_login_failed_code(_preview, vint_error=vint_err)
                if ec == ERR_CONTENT_UPDATE:
                    # Перечитываем полное тело для распаковки fingerprint.json
                    _m2, _v2, _pl2, full_body = await probe_single_hello_full(host, port, pkt, timeout=timeout)
                    fp = extract_fingerprint(full_body)
                    if fp:
                        break
        except Exception:
            continue

    latency_ms = round((time.monotonic() - t0) * 1000.0, 1)
    out = OrderedDict([
        ("id", game["id"]),
        ("name", game["name"]),
        ("host", host),
        ("port", port),
        ("ok", True),
        ("major", int(found_major)),
        ("msg_version", int(last_msg_ver) if last_msg_ver is not None else None),
        ("version", str(fp.get("version") or "") if fp else ""),
        ("sha", str(fp.get("sha") or "").lower() if fp else ""),
        ("latency_ms", latency_ms),
    ])
    return out


async def probe_single_hello_full(host: str, port: int, hello_wire: bytes, timeout: float = 4.0, max_bytes: int = 1_048_576):
    coro = asyncio.open_connection(host, port)
    reader, writer = await asyncio.wait_for(coro, timeout=timeout)
    try:
        writer.write(hello_wire)
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        hdr = await asyncio.wait_for(reader.readexactly(HEADER_LEN), timeout=timeout)
        msg_id, payload_len, msg_version = parse_header(hdr)
        if payload_len > max_bytes:
            raise ValueError("fingerprint payload too large: %d" % payload_len)
        body = await asyncio.wait_for(reader.readexactly(payload_len), timeout=timeout) if payload_len > 0 else b""
        return msg_id, msg_version, payload_len, body
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


# =============================================================================
# Таблица маршрутизации и кеш выученных сигнатур
# =============================================================================


class SupercellRouter:
    """Хранит сигнатуры игр Supercell и выбирает апстрим по полям ClientHello."""

    def __init__(self, games=DEFAULT_GAMES, learned_ttl: float = 21600.0, max_learned: int = 256):
        self.games = OrderedDict()
        for g in games:
            gid = str(g["id"])
            self.games[gid] = {
                "id": gid,
                "name": str(g.get("name") or gid),
                "host": str(g["host"]),
                "port": int(g.get("port") or 9339),
                "major": int(g["major"]),
                "protocols": list(g.get("protocols") or []),
                "msg_version": g.get("msg_version"),
                "vint_error": bool(g.get("vint_error", False)),
                "version": str(g.get("version") or ""),
                "sha": str(g.get("sha") or "").strip().lower(),
            }
        self.learned_ttl = float(learned_ttl)
        self.max_learned = int(max_learned)
        self.learned = OrderedDict()  # (major, protocol, key_version, content_hash) -> (game_id, expires_at)

    def load_state_file(self, path: Path) -> bool:
        p = Path(path)
        if not p.is_file():
            return False
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            items = raw.get("games") if isinstance(raw, dict) else None
            if not isinstance(items, dict):
                return False
            updated = 0
            for gid, info in items.items():
                if gid in self.games and isinstance(info, dict):
                    maj = info.get("major")
                    if isinstance(maj, int) and 1 <= maj <= 1000:
                        self.games[gid]["major"] = maj
                        updated += 1
                    sha = str(info.get("sha") or "").strip().lower()
                    if sha:
                        self.games[gid]["sha"] = sha
                    ver = str(info.get("version") or "").strip()
                    if ver:
                        self.games[gid]["version"] = ver
            return updated > 0
        except Exception as exc:
            log("warning: cannot load state file %s: %s" % (p, exc))
            return False

    def save_state_file(self, path: Path) -> None:
        if not path:
            return
        payload = OrderedDict([
            ("updated_at", int(time.time())),
            ("games", OrderedDict(
                (gid, OrderedDict([
                    ("major", g["major"]),
                    ("protocols", list(g["protocols"])),
                    ("version", g["version"]),
                    ("sha", g["sha"]),
                    ("host", g["host"]),
                    ("port", g["port"]),
                ]))
                for gid, g in self.games.items()
            )),
        ])
        atomic_write_json(Path(path), payload)

    def apply_discovered(self, info: dict) -> bool:
        """Обновляет сигнатуру игры по результату discover_game_signature. Возвращает True при изменениях."""
        gid = info.get("id")
        if gid not in self.games or not info.get("ok"):
            return False
        g = self.games[gid]
        changed = False
        new_major = info.get("major")
        if isinstance(new_major, int) and new_major >= 1 and new_major != g["major"]:
            log("signature update: %s major %d -> %d" % (gid, g["major"], new_major))
            g["major"] = new_major
            changed = True
        new_sha = str(info.get("sha") or "").strip().lower()
        if new_sha and new_sha != g["sha"]:
            g["sha"] = new_sha
            changed = True
        new_ver = str(info.get("version") or "").strip()
        if new_ver and new_ver != g["version"]:
            g["version"] = new_ver
            changed = True
        if info.get("msg_version") is not None:
            g["msg_version"] = int(info["msg_version"])
        return changed

    def remember_route(self, hello: ClientHello, game_id: str, confirmed_server_hello: bool = False, now: float = None) -> None:
        if game_id not in self.games:
            return
        now = time.monotonic() if now is None else now
        key = (hello.major, hello.protocol, hello.key_version, hello.content_hash)
        self.learned[key] = (game_id, now + self.learned_ttl)
        self.learned.move_to_end(key)
        while len(self.learned) > self.max_learned:
            self.learned.popitem(last=False)
        if confirmed_server_hello:
            g = self.games[game_id]
            if g["major"] != hello.major:
                log("live-learned new major for %s: %d -> %d" % (game_id, g["major"], hello.major))
                g["major"] = hello.major
            if hello.protocol not in g["protocols"]:
                g["protocols"].append(hello.protocol)
            if len(hello.content_hash) == 40:
                g["sha"] = hello.content_hash

    def select_static(self, hello: ClientHello, now: float = None):
        """Пытается выбрать игру без сетевых проб.
        Возвращает (game_dict, None) при однозначном совпадении либо (None, [candidates]) для live-probe."""
        now = time.monotonic() if now is None else now
        lkey = (hello.major, hello.protocol, hello.key_version, hello.content_hash)
        cached = self.learned.get(lkey)
        if cached is not None:
            gid, exp = cached
            if exp > now and gid in self.games:
                self.learned.move_to_end(lkey)
                return self.games[gid], None
            del self.learned[lkey]

        # 1. Точное совпадение по непустому SHA-1 content_hash
        if hello.content_hash and hello.content_hash != "0" * len(hello.content_hash):
            by_sha = [g for g in self.games.values() if g["sha"] and g["sha"] == hello.content_hash]
            if len(by_sha) == 1:
                return by_sha[0], None

        # 2. Совпадение по major_version
        by_major = [g for g in self.games.values() if g["major"] == hello.major]
        if len(by_major) == 1:
            return by_major[0], None
        if len(by_major) > 1:
            by_proto = [g for g in by_major if hello.protocol in g["protocols"]]
            if len(by_proto) == 1:
                return by_proto[0], None
            return None, (by_proto if by_proto else by_major)

        # 3. Неизвестный major_version (вышел свежий патч или устаревший клиент) — проверяем все игры
        return None, list(self.games.values())


# =============================================================================
# TCP-релей на :9339
# =============================================================================


class SupercellProxyServer:
    def __init__(self, args, router: SupercellRouter = None):
        self.args = args
        self.router = router or SupercellRouter()
        if args.state_file:
            self.router.load_state_file(Path(args.state_file))
        self.server = None
        self.stop_event = None
        self.conn_sem = None
        self.per_ip_conns = {}
        self.refresh_task = None
        self.counters = OrderedDict([
            ("accepted", 0),
            ("routed_static", 0),
            ("routed_probed", 0),
            ("rejected_invalid", 0),
            ("rejected_limit", 0),
            ("upstream_errors", 0),
            ("refresh_ok", 0),
            ("refresh_errors", 0),
        ])
        self.by_game = OrderedDict((gid, 0) for gid in self.router.games)

    def _peer_ip(self, writer: asyncio.StreamWriter) -> str:
        peer = writer.get_extra_info("peername")
        if not peer:
            return "unknown"
        return str(peer[0])

    async def handle_client(self, client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
        peer_ip = self._peer_ip(client_writer)
        if self.conn_sem.locked() or self.per_ip_conns.get(peer_ip, 0) >= self.args.max_conns_per_ip:
            self.counters["rejected_limit"] += 1
            await self._safe_close(client_writer)
            return

        await self.conn_sem.acquire()
        self.per_ip_conns[peer_ip] = self.per_ip_conns.get(peer_ip, 0) + 1
        self.counters["accepted"] += 1
        up_writer = None
        try:
            hello = await self._read_client_hello(client_reader)
            if hello is None:
                self.counters["rejected_invalid"] += 1
                return

            game, candidates = self.router.select_static(hello)
            initial_reply = b""
            if game is not None:
                try:
                    up_reader, up_writer = await asyncio.wait_for(
                        asyncio.open_connection(game["host"], game["port"]),
                        timeout=self.args.connect_timeout,
                    )
                    up_writer.write(hello.raw)
                    await asyncio.wait_for(up_writer.drain(), timeout=self.args.connect_timeout)
                    self.counters["routed_static"] += 1
                except Exception:
                    self.counters["upstream_errors"] += 1
                    await self._safe_close(up_writer)
                    up_writer = None
                    return
            else:
                picked = await self._live_probe_candidates(candidates, hello)
                if picked is None:
                    self.counters["upstream_errors"] += 1
                    return
                game, up_reader, up_writer, initial_reply = picked
                self.counters["routed_probed"] += 1

            self.by_game[game["id"]] = self.by_game.get(game["id"], 0) + 1
            if initial_reply:
                client_writer.write(initial_reply)
                await asyncio.wait_for(client_writer.drain(), timeout=self.args.connect_timeout)

            await self._splice(client_reader, client_writer, up_reader, up_writer)
        finally:
            await self._safe_close(up_writer)
            await self._safe_close(client_writer)
            rem = self.per_ip_conns.get(peer_ip, 1) - 1
            if rem <= 0:
                self.per_ip_conns.pop(peer_ip, None)
            else:
                self.per_ip_conns[peer_ip] = rem
            self.conn_sem.release()

    async def _read_client_hello(self, reader: asyncio.StreamReader):
        deadline = time.monotonic() + self.args.handshake_timeout
        try:
            hdr = await asyncio.wait_for(reader.readexactly(HEADER_LEN), timeout=self.args.handshake_timeout)
            _mid, payload_len, _ver = validate_client_hello_header(hdr)
            rem = max(0.1, deadline - time.monotonic())
            body = await asyncio.wait_for(reader.readexactly(payload_len), timeout=rem)
            return parse_client_hello(hdr + body)
        except (asyncio.IncompleteReadError, asyncio.TimeoutError, ValueError, ConnectionError):
            return None

    async def _live_probe_candidates(self, candidates: list, hello: ClientHello):
        """Параллельно отправляет ClientHello кандидатам и оставляет открытым сокет победителя."""
        timeout = self.args.connect_timeout

        async def try_one(g):
            r, w = await asyncio.wait_for(asyncio.open_connection(g["host"], g["port"]), timeout=timeout)
            try:
                w.write(hello.raw)
                await asyncio.wait_for(w.drain(), timeout=timeout)
                hdr = await asyncio.wait_for(r.readexactly(HEADER_LEN), timeout=timeout)
                msg_id, payload_len, _ver = parse_header(hdr)
                peek_len = min(payload_len, 8)
                peek = await asyncio.wait_for(r.readexactly(peek_len), timeout=timeout) if peek_len > 0 else b""
                ec = 0 if msg_id == MSG_SERVER_HELLO else decode_login_failed_code(peek, vint_error=g["vint_error"])
                rank = score_upstream_reply(msg_id, ec)
                return g, r, w, hdr + peek, rank, msg_id, ec
            except Exception:
                await self._safe_close(w)
                raise

        tasks = [asyncio.ensure_future(try_one(g)) for g in candidates]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        valid = [res for res in results if not isinstance(res, Exception)]
        if not valid:
            return None

        # Сортируем: максимальный rank (3 = ServerHello 20100), а если клиент устарел (все вернули 0) —
        # предпочитаем игру с минимальным major > hello.major, вернувшую ec == 8 (ссылка на обновление именно этой игры).
        def sort_key(item):
            g, _r, _w, _buf, rank, _mid, ec = item
            stale_hint = 1 if (rank == 0 and ec == ERR_CLIENT_TOO_OLD and g["major"] > hello.major) else 0
            major_dist = abs(g["major"] - hello.major)
            return (rank, stale_hint, -major_dist)

        valid.sort(key=sort_key, reverse=True)
        winner = valid[0]
        win_game, win_r, win_w, win_buf, win_rank, win_mid, _win_ec = winner

        for item in valid[1:]:
            await self._safe_close(item[2])

        if win_rank == 0 and _win_ec != ERR_CLIENT_TOO_OLD:
            await self._safe_close(win_w)
            return None

        if win_rank >= 2:
            self.router.remember_route(hello, win_game["id"], confirmed_server_hello=(win_mid == MSG_SERVER_HELLO))
        return win_game, win_r, win_w, win_buf

    async def _splice(
        self,
        c_reader: asyncio.StreamReader,
        c_writer: asyncio.StreamWriter,
        u_reader: asyncio.StreamReader,
        u_writer: asyncio.StreamWriter,
    ) -> None:
        idle = self.args.idle_timeout

        async def pump(src: asyncio.StreamReader, dst: asyncio.StreamWriter):
            try:
                while True:
                    chunk = await asyncio.wait_for(src.read(32768), timeout=idle)
                    if not chunk:
                        break
                    dst.write(chunk)
                    await asyncio.wait_for(dst.drain(), timeout=idle)
            except Exception:
                pass
            finally:
                try:
                    if dst.can_write_eof():
                        dst.write_eof()
                except Exception:
                    pass

        t1 = asyncio.ensure_future(pump(c_reader, u_writer))
        t2 = asyncio.ensure_future(pump(u_reader, c_writer))
        try:
            await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (t1, t2):
                if not t.done():
                    t.cancel()
            await asyncio.gather(t1, t2, return_exceptions=True)

    @staticmethod
    async def _safe_close(writer) -> None:
        if writer is None:
            return
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

    async def refresh_signatures_once(self) -> list:
        games = list(self.router.games.values())
        results = await asyncio.gather(
            *(discover_game_signature(g, timeout=self.args.probe_timeout) for g in games),
            return_exceptions=True,
        )
        any_changed = False
        summary = []
        for g, res in zip(games, results):
            if isinstance(res, Exception):
                self.counters["refresh_errors"] += 1
                log("probe error for %s (%s): %s" % (g["id"], g["host"], res))
                summary.append(OrderedDict([
                    ("id", g["id"]),
                    ("name", g["name"]),
                    ("host", g["host"]),
                    ("port", g["port"]),
                    ("ok", False),
                    ("error", str(res)),
                ]))
            else:
                self.counters["refresh_ok"] += 1
                if self.router.apply_discovered(res):
                    any_changed = True
                summary.append(res)
        if (any_changed or (self.args.state_file and not Path(self.args.state_file).is_file())) and self.args.state_file:
            try:
                self.router.save_state_file(Path(self.args.state_file))
            except Exception as exc:
                log("warning: cannot write state file %s: %s" % (self.args.state_file, exc))
        return summary

    async def _refresh_loop(self) -> None:
        interval = max(60.0, float(self.args.refresh_interval))
        while not self.stop_event.is_set():
            try:
                await self.refresh_signatures_once()
            except Exception as exc:
                log("refresh cycle failed: %s" % exc)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass

    def trigger_refresh(self) -> None:
        log("SIGHUP: scheduling upstream signature refresh")
        asyncio.ensure_future(self.refresh_signatures_once())

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self.stop_event = asyncio.Event()
        self.conn_sem = asyncio.Semaphore(self.args.max_conns)
        self.server = await asyncio.start_server(
            self.handle_client,
            host=self.args.listen_host,
            port=self.args.port,
            reuse_address=True,
            backlog=1024,
        )
        addrs = ", ".join(str(s.getsockname()) for s in (self.server.sockets or []))
        log("listening on %s (%d Supercell upstreams)" % (addrs, len(self.router.games)))

        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self.stop_event.set)
            except (NotImplementedError, RuntimeError, ValueError):
                pass
        try:
            loop.add_signal_handler(signal.SIGHUP, self.trigger_refresh)
        except (NotImplementedError, RuntimeError, ValueError, AttributeError):
            pass

        if not self.args.no_refresh:
            self.refresh_task = asyncio.ensure_future(self._refresh_loop())

    async def shutdown(self) -> None:
        if self.refresh_task is not None:
            self.refresh_task.cancel()
            await asyncio.gather(self.refresh_task, return_exceptions=True)
            self.refresh_task = None
        if self.server is not None:
            self.server.close()
            try:
                await self.server.wait_closed()
            except Exception:
                pass
            self.server = None
        log("stopped")

    async def serve_forever(self) -> None:
        await self.start()
        try:
            await self.stop_event.wait()
        finally:
            await self.shutdown()


# =============================================================================
# CLI
# =============================================================================


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Прозрачный TCP-релей протокола Supercell (:9339) для воркеров «Перевал Pro».",
    )
    p.add_argument("--listen-host", default="0.0.0.0", help="адрес прослушивания (по умолчанию 0.0.0.0)")
    p.add_argument("--port", type=int, default=9339, help="TCP-порт прослушивания (по умолчанию 9339)")
    p.add_argument("--state-file", default="/var/lib/pereval-supercell/signatures.json",
                   help="файл кеша актуальных сигнатур игр (пусто — не сохранять)")
    p.add_argument("--refresh-interval", type=float, default=1800.0,
                   help="интервал фоновой сверки сигнатур с апстримами Supercell в секундах (по умолчанию 1800)")
    p.add_argument("--no-refresh", action="store_true", help="отключить фоновый опрос апстримов")
    p.add_argument("--probe-once", action="store_true",
                   help="однократно проверить все апстримы Supercell, вывести JSON и завершиться")
    p.add_argument("--handshake-timeout", type=float, default=5.0,
                   help="таймаут чтения первого пакета ClientHello от клиента (по умолчанию 5 с)")
    p.add_argument("--connect-timeout", type=float, default=8.0,
                   help="таймаут подключения к игровому серверу Supercell (по умолчанию 8 с)")
    p.add_argument("--probe-timeout", type=float, default=4.0,
                   help="таймаут одного пробного рукопожатия при сверке версий (по умолчанию 4 с)")
    p.add_argument("--idle-timeout", type=float, default=180.0,
                   help="таймаут простоя игровой TCP-сессии (по умолчанию 180 с)")
    p.add_argument("--max-conns", type=int, default=4000,
                   help="максимум одновременных TCP-сессий (по умолчанию 4000)")
    p.add_argument("--max-conns-per-ip", type=int, default=32,
                   help="максимум одновременных TCP-сессий с одного IP клиента (по умолчанию 32)")
    return p.parse_args(argv)


async def _run_probe_once(args) -> int:
    srv = SupercellProxyServer(args)
    results = await srv.refresh_signatures_once()
    all_ok = all(r.get("ok") for r in results)
    print(json.dumps({"ok": all_ok, "checked_at": int(time.time()), "upstreams": results}, ensure_ascii=False, indent=2))
    return 0 if all_ok else 1


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.probe_once:
        return asyncio.run(_run_probe_once(args))
    srv = SupercellProxyServer(args)
    try:
        asyncio.run(srv.serve_forever())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
