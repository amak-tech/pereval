# -*- coding: utf-8 -*-
import asyncio
import json
import struct
import sys
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import dnstestutil as tu  # noqa: E402
import supercell_proxy as sp  # noqa: E402

sp.log = lambda msg: None


def make_packet(msg_id: int, body: bytes, version: int = 0) -> bytes:
    hdr = struct.pack(">H", msg_id) + len(body).to_bytes(3, "big") + struct.pack(">H", version)
    return hdr + body


def make_login_failed(err_code: int, extra: bytes = b"", vint: bool = False, msg_ver: int = 12) -> bytes:
    prefix = bytes([err_code & 0x3F]) if vint else struct.pack(">i", err_code)
    return make_packet(sp.MSG_LOGIN_FAILED, prefix + extra, version=msg_ver)


def make_server_hello(token: bytes = b"S" * 24) -> bytes:
    return make_packet(sp.MSG_SERVER_HELLO, struct.pack(">i", len(token)) + token, version=0)


class ProtocolParsingTests(unittest.TestCase):
    def test_parse_valid_client_hello(self):
        sha = "15f41bec0b4ef44565550ef0a80aea899c7e70a6"
        raw = sp.build_client_hello(protocol=2, key_version=60, major=70, field4=1, field5=820, content_hash=sha)
        hello = sp.parse_client_hello(raw)
        self.assertEqual(hello.msg_id, 10100)
        self.assertEqual(hello.protocol, 2)
        self.assertEqual(hello.key_version, 60)
        self.assertEqual(hello.major, 70)
        self.assertEqual(hello.field4, 1)
        self.assertEqual(hello.field5, 820)
        self.assertEqual(hello.content_hash, sha)
        self.assertEqual(hello.raw, raw)

        # null content_hash (-1)
        raw_null = sp.build_client_hello(protocol=1, key_version=24, major=63, field4=1, field5=216, content_hash=None)
        hello_null = sp.parse_client_hello(raw_null)
        self.assertEqual(hello_null.content_hash, "")
        self.assertEqual(hello_null.major, 63)

    def test_reject_non_supercell_traffic(self):
        # HTTP GET
        with self.assertRaises(ValueError):
            sp.parse_client_hello(b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")
        # TLS ClientHello
        with self.assertRaises(ValueError):
            sp.parse_client_hello(b"\x16\x03\x01\x00\x20" + b"\x00" * 32)
        # Неверный msg_id (10101 вместо 10100)
        bad_id = make_packet(10101, b"\x00" * 40)
        with self.assertRaises(ValueError):
            sp.parse_client_hello(bad_id)
        # Слишком маленькая длина payload
        too_short = make_packet(10100, b"\x00" * 12)
        with self.assertRaises(ValueError):
            sp.parse_client_hello(too_short)
        # Длина строки хэша выходит за пределы пакета
        bad_hash_len = make_packet(10100, struct.pack(">iiiiii", 2, 50, 70, 1, 1, 200) + b"abcd")
        with self.assertRaises(ValueError):
            sp.parse_client_hello(bad_hash_len)

    def test_decode_login_failed_and_extract_fingerprint(self):
        self.assertEqual(sp.decode_login_failed_code(b"\x00\x00\x00\x08rest", vint_error=False), 8)
        self.assertEqual(sp.decode_login_failed_code(b"\x08\xff\xff\xff\xff", vint_error=True), 8)
        self.assertEqual(sp.decode_login_failed_code(b"\x09\xff\xff\xff\xff", vint_error=True), 9)
        self.assertEqual(sp.decode_login_failed_code(b"\x10\xff\xff\xff\xff", vint_error=True), 16)

        fp_json = json.dumps({"files": [], "sha": "deadbeef" * 5, "version": "71.100.1"}).encode("utf-8")
        compressed = zlib.compress(fp_json)
        blob = b"\x00\x00\x00\x07\xff\xff\xff\xff" + struct.pack("<I", len(fp_json)) + compressed + b"\x00\x00"
        extracted = sp.extract_fingerprint(blob)
        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["version"], "71.100.1")
        self.assertEqual(extracted["sha"], "deadbeef" * 5)


class RouterTests(unittest.TestCase):
    def test_static_selection_and_collision_handling(self):
        router = sp.SupercellRouter([
            {"id": "bs", "name": "BS", "host": "127.0.0.1", "port": 19001, "major": 70, "protocols": [2], "sha": "a" * 40},
            {"id": "cr", "name": "CR", "host": "127.0.0.1", "port": 19002, "major": 16, "protocols": [3], "sha": ""},
            {"id": "sb", "name": "SB", "host": "127.0.0.1", "port": 19003, "major": 16, "protocols": [1], "sha": ""},
        ])

        # Однозначный major=70 -> bs
        h_bs = sp.parse_client_hello(sp.build_client_hello(protocol=2, key_version=60, major=70))
        game, cands = router.select_static(h_bs)
        self.assertEqual(game["id"], "bs")
        self.assertIsNone(cands)

        # Коллизия major=16 разрешается по protocol (3 -> cr, 1 -> sb)
        h_cr = sp.parse_client_hello(sp.build_client_hello(protocol=3, key_version=55, major=16))
        game_cr, _ = router.select_static(h_cr)
        self.assertEqual(game_cr["id"], "cr")

        h_sb = sp.parse_client_hello(sp.build_client_hello(protocol=1, key_version=52, major=16))
        game_sb, _ = router.select_static(h_sb)
        self.assertEqual(game_sb["id"], "sb")

        # Неизвестный protocol при коллизии major=16 -> возвращает обоих кандидатов
        h_amb = sp.parse_client_hello(sp.build_client_hello(protocol=9, key_version=50, major=16))
        game_amb, cands_amb = router.select_static(h_amb)
        self.assertIsNone(game_amb)
        self.assertEqual([c["id"] for c in cands_amb], ["cr", "sb"])

        # Новый major=71 -> возвращает всех кандидатов для live-probe
        h_new = sp.parse_client_hello(sp.build_client_hello(protocol=2, key_version=60, major=71))
        game_new, cands_new = router.select_static(h_new)
        self.assertIsNone(game_new)
        self.assertEqual(len(cands_new), 3)

    def test_state_file_roundtrip(self):
        tmp = Path(tu.tmpdir()) / "signatures.json"
        r1 = sp.SupercellRouter()
        r1.apply_discovered({"id": "brawlstars", "ok": True, "major": 72, "version": "72.10.1", "sha": "b" * 40})
        r1.save_state_file(tmp)

        r2 = sp.SupercellRouter()
        self.assertTrue(r2.load_state_file(tmp))
        self.assertEqual(r2.games["brawlstars"]["major"], 72)
        self.assertEqual(r2.games["brawlstars"]["version"], "72.10.1")
        self.assertEqual(r2.games["brawlstars"]["sha"], "b" * 40)


class RelayAndProbeIntegrationTests(unittest.TestCase):
    def test_static_relay_and_invalid_packet_rejection(self):
        async def run():
            received_by_bs = []

            async def bs_upstream(reader, writer):
                hdr = await reader.readexactly(sp.HEADER_LEN)
                _mid, plen, _ver = sp.parse_header(hdr)
                body = await reader.readexactly(plen)
                received_by_bs.append(hdr + body)
                writer.write(make_server_hello(b"BS_SESSION_TOKEN_24BYTES"))
                await writer.drain()
                followup = await reader.read(64)
                writer.write(b"ECHO:" + followup)
                await writer.drain()
                writer.close()
                await writer.wait_closed()

            up_srv = await asyncio.start_server(bs_upstream, "127.0.0.1", 0)
            bs_port = up_srv.sockets[0].getsockname()[1]

            router = sp.SupercellRouter([
                {"id": "brawlstars", "name": "BS", "host": "127.0.0.1", "port": bs_port, "major": 70, "protocols": [2]},
                {"id": "clashroyale", "name": "CR", "host": "127.0.0.1", "port": tu.free_port(), "major": 16, "protocols": [3], "vint_error": True},
            ])
            args = sp.parse_args(["--listen-host", "127.0.0.1", "--port", "0", "--state-file", "", "--no-refresh"])
            proxy = sp.SupercellProxyServer(args, router=router)
            await proxy.start()
            proxy_port = proxy.server.sockets[0].getsockname()[1]

            try:
                # 1) Невалидный трафик мгновенно сбрасывается
                r_bad, w_bad = await asyncio.open_connection("127.0.0.1", proxy_port)
                w_bad.write(b"GET / HTTP/1.1\r\n\r\n")
                await w_bad.drain()
                eof = await asyncio.wait_for(r_bad.read(64), timeout=2.0)
                self.assertEqual(eof, b"")
                w_bad.close()
                await w_bad.wait_closed()
                self.assertEqual(proxy.counters["rejected_invalid"], 1)
                self.assertEqual(len(received_by_bs), 0)

                # 2) Валидный ClientHello Brawl Stars маршрутизируется и двунаправленно проксируется
                r_ok, w_ok = await asyncio.open_connection("127.0.0.1", proxy_port)
                hello_pkt = sp.build_client_hello(protocol=2, key_version=60, major=70, field4=1, field5=820)
                w_ok.write(hello_pkt)
                await w_ok.drain()

                sh_hdr = await asyncio.wait_for(r_ok.readexactly(sp.HEADER_LEN), timeout=2.0)
                mid, plen, _ = sp.parse_header(sh_hdr)
                sh_body = await asyncio.wait_for(r_ok.readexactly(plen), timeout=2.0)
                self.assertEqual(mid, sp.MSG_SERVER_HELLO)
                self.assertIn(b"BS_SESSION_TOKEN_24BYTES", sh_body)

                w_ok.write(b"LOGIN_10101_PAYLOAD")
                await w_ok.drain()
                echoed = await asyncio.wait_for(r_ok.readexactly(len(b"ECHO:LOGIN_10101_PAYLOAD")), timeout=2.0)
                self.assertEqual(echoed, b"ECHO:LOGIN_10101_PAYLOAD")
                w_ok.close()
                await w_ok.wait_closed()

                self.assertEqual(proxy.counters["routed_static"], 1)
                self.assertEqual(proxy.by_game["brawlstars"], 1)
            finally:
                await proxy.shutdown()
                up_srv.close()
                await up_srv.wait_closed()

        asyncio.run(run())

    def test_live_probe_learns_new_major_and_preserves_stream(self):
        async def run():
            # Игра №1 отклоняет major=75 с кодом 9 (слишком новая), игра №2 отвечает ServerHello (20100)!
            async def wrong_upstream(reader, writer):
                hdr = await reader.readexactly(sp.HEADER_LEN)
                _mid, plen, _ = sp.parse_header(hdr)
                await reader.readexactly(plen)
                writer.write(make_login_failed(sp.ERR_CLIENT_TOO_NEW, b"\x00" * 16))
                await writer.drain()
                writer.close()
                await writer.wait_closed()

            async def right_upstream(reader, writer):
                hdr = await reader.readexactly(sp.HEADER_LEN)
                _mid, plen, _ = sp.parse_header(hdr)
                await reader.readexactly(plen)
                writer.write(make_server_hello(b"NEW_SEASON_SERVER_HELLO!"))
                await writer.drain()
                nxt = await reader.read(32)
                if nxt:
                    writer.write(b"OK:" + nxt)
                    await writer.drain()
                writer.close()
                await writer.wait_closed()

            s_wrong = await asyncio.start_server(wrong_upstream, "127.0.0.1", 0)
            s_right = await asyncio.start_server(right_upstream, "127.0.0.1", 0)
            p_wrong = s_wrong.sockets[0].getsockname()[1]
            p_right = s_right.sockets[0].getsockname()[1]

            router = sp.SupercellRouter([
                {"id": "clashofclans", "name": "CoC", "host": "127.0.0.1", "port": p_wrong, "major": 18, "protocols": [3]},
                {"id": "brawlstars", "name": "BS", "host": "127.0.0.1", "port": p_right, "major": 70, "protocols": [2]},
            ])
            args = sp.parse_args(["--listen-host", "127.0.0.1", "--port", "0", "--state-file", "", "--no-refresh"])
            proxy = sp.SupercellProxyServer(args, router=router)
            await proxy.start()
            proxy_port = proxy.server.sockets[0].getsockname()[1]

            try:
                # Первый клиент приходит с новым major=75, которого ещё нет в конфиге
                r1, w1 = await asyncio.open_connection("127.0.0.1", proxy_port)
                pkt = sp.build_client_hello(protocol=2, key_version=61, major=75, field4=1, field5=100, content_hash="c" * 40)
                w1.write(pkt)
                await w1.drain()

                sh_hdr = await asyncio.wait_for(r1.readexactly(sp.HEADER_LEN), timeout=2.0)
                mid, plen, _ = sp.parse_header(sh_hdr)
                sh_body = await asyncio.wait_for(r1.readexactly(plen), timeout=2.0)
                self.assertEqual(mid, sp.MSG_SERVER_HELLO)
                self.assertIn(b"NEW_SEASON_SERVER_HELLO!", sh_body)

                w1.write(b"PING")
                await w1.drain()
                pong = await asyncio.wait_for(r1.readexactly(7), timeout=2.0)
                self.assertEqual(pong, b"OK:PING")
                w1.close()
                await w1.wait_closed()

                self.assertEqual(proxy.counters["routed_probed"], 1)
                self.assertEqual(router.games["brawlstars"]["major"], 75)

                # Второй клиент с major=75 идёт уже статически без live-probe!
                r2, w2 = await asyncio.open_connection("127.0.0.1", proxy_port)
                w2.write(pkt)
                await w2.drain()
                sh_hdr2 = await asyncio.wait_for(r2.readexactly(sp.HEADER_LEN), timeout=2.0)
                mid2, plen2, _ = sp.parse_header(sh_hdr2)
                await asyncio.wait_for(r2.readexactly(plen2), timeout=2.0)
                self.assertEqual(mid2, sp.MSG_SERVER_HELLO)
                w2.close()
                await w2.wait_closed()
                self.assertEqual(proxy.counters["routed_static"], 1)
            finally:
                await proxy.shutdown()
                s_wrong.close()
                s_right.close()
                await s_wrong.wait_closed()
                await s_right.wait_closed()

        asyncio.run(run())

    def test_discover_game_signature_binary_search(self):
        async def run():
            live_major = 73
            fp_raw = json.dumps({"files": [], "version": "73.400.2", "sha": "f" * 40}).encode("utf-8")
            fp_zlib = zlib.compress(fp_raw)

            async def fake_supercell(reader, writer):
                try:
                    hdr = await reader.readexactly(sp.HEADER_LEN)
                    hello = sp.parse_client_hello(hdr + await reader.readexactly(sp.parse_header(hdr)[1]))
                    if hello.major < live_major:
                        writer.write(make_login_failed(sp.ERR_CLIENT_TOO_OLD, b"\x00" * 16, msg_ver=12))
                    elif hello.major > live_major:
                        writer.write(make_login_failed(sp.ERR_CLIENT_TOO_NEW, b"\x00" * 16, msg_ver=12))
                    elif hello.field5 >= 1000:
                        writer.write(make_login_failed(sp.ERR_CONTENT_UPDATE, struct.pack("<I", len(fp_raw)) + fp_zlib, msg_ver=12))
                    else:
                        writer.write(make_login_failed(sp.ERR_CLIENT_TOO_OLD, b"\x00" * 16, msg_ver=12))
                    await writer.drain()
                finally:
                    writer.close()
                    await writer.wait_closed()

            srv = await asyncio.start_server(fake_supercell, "127.0.0.1", 0)
            port = srv.sockets[0].getsockname()[1]
            state_path = Path(tu.tmpdir()) / "sig.json"
            try:
                router = sp.SupercellRouter([
                    {"id": "brawlstars", "name": "Brawl Stars", "host": "127.0.0.1", "port": port, "major": 70, "protocols": [2]},
                ])
                args = sp.parse_args(["--state-file", str(state_path), "--no-refresh"])
                proxy = sp.SupercellProxyServer(args, router=router)
                summary = await proxy.refresh_signatures_once()
                self.assertEqual(len(summary), 1)
                self.assertTrue(summary[0]["ok"])
                self.assertEqual(summary[0]["major"], 73)
                self.assertEqual(summary[0]["version"], "73.400.2")
                self.assertEqual(summary[0]["sha"], "f" * 40)
                self.assertEqual(router.games["brawlstars"]["major"], 73)
                self.assertTrue(state_path.is_file())
            finally:
                srv.close()
                await srv.wait_closed()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
