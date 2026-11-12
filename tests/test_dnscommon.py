# -*- coding: utf-8 -*-
import asyncio
import struct
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import dnscommon  # noqa: E402
import dnstestutil as tu  # noqa: E402


class WireParseBuildTests(unittest.TestCase):
    def test_parse_question_with_edns(self):
        q = dnscommon.parse_question(tu.make_query("API.Anthropic.COM.", 28, edns=True, do=True, payload=4096))
        self.assertEqual(q.qname, "api.anthropic.com")
        self.assertEqual(q.qtype, 28)
        self.assertEqual(q.qclass, 1)
        self.assertTrue(q.has_edns)
        self.assertEqual(q.edns_payload, 4096)
        self.assertTrue(q.do_bit)

    def test_parse_question_without_edns(self):
        q = dnscommon.parse_question(tu.make_query("claude.ai", 1, edns=False))
        self.assertEqual((q.qname, q.qtype, q.has_edns, q.edns_payload, q.do_bit),
                         ("claude.ai", 1, False, 512, False))

    def test_parse_question_rejects_garbage(self):
        with self.assertRaises(ValueError):
            dnscommon.parse_question(b"\x00" * 11)
        with self.assertRaises(ValueError):
            dnscommon.parse_question(struct.pack("!HHHHHH", 1, 0x8000, 1, 0, 0, 0) + b"\x00\x00\x01\x00\x01")  # QR=1
        with self.assertRaises(ValueError):
            dnscommon.parse_question(struct.pack("!HHHHHH", 1, 0, 0, 0, 0, 0))  # qdcount 0
        with self.assertRaises(ValueError):
            dnscommon.parse_question(struct.pack("!HHHHHH", 1, 0, 1, 0, 0, 0) + b"\x05abc")  # обрезано

    def test_build_response_echoes_opt_and_flags(self):
        query = tu.make_query("claude.ai", 1, qid=0xBEEF, edns=True, do=True, payload=4096)
        resp = dnscommon.build_response(query, [dnscommon.a_record("claude.ai", "203.0.113.30", 60)])
        h = tu.parse_header(resp)
        self.assertEqual(h["id"], 0xBEEF)
        self.assertTrue(h["qr"] and h["rd"] and h["ra"])
        self.assertFalse(h["aa"] or h["tc"])
        self.assertEqual(h["rcode"], 0)
        self.assertEqual((h["qd"], h["an"], h["ns"], h["ar"]), (1, 1, 0, 1))
        ans, _ns, ar = tu.parse_records(resp)
        self.assertEqual(ans[0][:4], ("claude.ai", 1, 1, 60))
        self.assertEqual(tu.a_answers(resp), ["203.0.113.30"])
        # OPT: имя корень, class = 1232, DO сохранён, без опций
        self.assertEqual(ar[0][0], "")
        self.assertEqual(ar[0][1], 41)
        self.assertEqual(ar[0][2], 1232)
        self.assertEqual(ar[0][3] & 0x8000, 0x8000)
        self.assertEqual(ar[0][4], b"")
        # имя ответа сжато указателем на вопрос
        qend = dnscommon.question_end(query)
        self.assertEqual(resp[qend:qend + 2], b"\xC0\x0C")
        # вопрос скопирован байт в байт
        self.assertEqual(resp[12:qend], query[12:qend])

    def test_build_response_without_opt(self):
        query = tu.make_query("claude.ai", 1, edns=False)
        resp = dnscommon.build_response(query, [])
        self.assertEqual(tu.parse_header(resp)["ar"], 0)
        resp2 = dnscommon.build_response(tu.make_query("claude.ai", 1, edns=True), [], copy_opt=False)
        self.assertEqual(tu.parse_header(resp2)["ar"], 0)

    def test_nodata_refused_servfail_truncated(self):
        query = tu.make_query("claude.ai", 28, rd=False)
        nodata = dnscommon.build_nodata(query)
        h = tu.parse_header(nodata)
        self.assertEqual((h["rcode"], h["an"], h["ns"], h["ar"]), (0, 0, 0, 1))
        self.assertFalse(h["rd"])
        self.assertEqual(tu.parse_header(dnscommon.build_refused(query))["rcode"], 5)
        self.assertEqual(tu.parse_header(dnscommon.build_servfail(query))["rcode"], 2)
        tc = dnscommon.build_truncated(query)
        self.assertTrue(tu.parse_header(tc)["tc"])
        self.assertEqual(tu.parse_header(tc)["an"], 0)
        self.assertEqual(dnscommon.response_rcode(dnscommon.build_refused(query)), 5)

    def test_header_only_for_malformed(self):
        bad = struct.pack("!HHHHHH", 0x4242, 0x0100, 1, 0, 0, 0) + b"\x09abc"
        resp = dnscommon.build_header_only(bad, dnscommon.RCODE_FORMERR)
        h = tu.parse_header(resp)
        self.assertEqual((h["id"], h["rcode"], h["qd"], h["qr"], h["rd"]), (0x4242, 1, 0, True, True))
        with self.assertRaises(ValueError):
            dnscommon.build_header_only(b"\x00" * 5, 1)

    def test_encode_read_name_roundtrip_and_compression(self):
        wire = dnscommon.encode_name("a.example.com")
        labels, end = dnscommon.read_name(wire, 0)
        self.assertEqual(dnscommon.labels_to_name(labels), "a.example.com")
        self.assertEqual(end, len(wire))
        # указатель на offset 2 внутри буфера
        buf = b"\x00\x00" + wire + b"\x03www" + b"\xC0\x02"
        labels, end = dnscommon.read_name(buf, 2 + len(wire))
        self.assertEqual(dnscommon.labels_to_name(labels), "www.a.example.com")
        self.assertEqual(end, len(buf))
        with self.assertRaises(ValueError):
            dnscommon.read_name(b"\xC0\x05", 0)  # указатель вперёд
        self.assertEqual(dnscommon.encode_name(""), b"\x00")


class TcpFramingTests(unittest.TestCase):
    def test_frame_unframe(self):
        m1, m2 = tu.make_query("a.com", qid=1), tu.make_query("b.com", qid=2)
        buf = dnscommon.frame_tcp(m1) + dnscommon.frame_tcp(m2)
        msgs, rest = dnscommon.unframe_tcp(buf[:-3])
        self.assertEqual(msgs, [m1])
        self.assertEqual(rest, dnscommon.frame_tcp(m2)[:-3])
        msgs, rest = dnscommon.unframe_tcp(rest + buf[-3:])
        self.assertEqual(msgs, [m2])
        self.assertEqual(rest, b"")
        with self.assertRaises(ValueError):
            dnscommon.frame_tcp(b"x" * 70000)

    def test_read_tcp_message(self):
        async def run():
            reader = asyncio.StreamReader()
            q = tu.make_query("a.com")
            reader.feed_data(dnscommon.frame_tcp(q))
            got = await dnscommon.read_tcp_message(reader, 1.0)
            self.assertEqual(got, q)
            reader.feed_eof()
            self.assertIsNone(await dnscommon.read_tcp_message(reader, 1.0))
            bad = asyncio.StreamReader()
            bad.feed_data(b"\x00\x05hello")
            with self.assertRaises(ValueError):
                await dnscommon.read_tcp_message(bad, 1.0)
        asyncio.run(run())


class MiscTests(unittest.TestCase):
    def test_base64url(self):
        q = tu.make_query("claude.ai")
        enc = dnscommon.encode_base64url_dns(q)
        self.assertNotIn("=", enc)
        self.assertEqual(dnscommon.decode_base64url_dns(enc), q)
        with self.assertRaises(ValueError):
            dnscommon.decode_base64url_dns("")
        with self.assertRaises(ValueError):
            dnscommon.decode_base64url_dns("AAAA")  # 3 байта — короче заголовка

    def test_extract_min_ttl(self):
        q = tu.make_query("claude.ai")
        resp = dnscommon.build_response(q, [dnscommon.a_record("claude.ai", "1.2.3.4", 45),
                                            dnscommon.a_record("claude.ai", "1.2.3.5", 7)])
        self.assertEqual(dnscommon.extract_min_ttl(resp), 7)
        self.assertEqual(dnscommon.extract_min_ttl(dnscommon.build_refused(q)), 10)
        self.assertEqual(dnscommon.extract_min_ttl(dnscommon.build_nodata(q)), 60)
        self.assertEqual(dnscommon.extract_min_ttl(b"short"), 60)

    def test_hash_ip(self):
        h1 = dnscommon.hash_ip("1.2.3.4", "seed", day=100)
        self.assertEqual(len(h1), 16)
        int(h1, 16)
        self.assertEqual(h1, dnscommon.hash_ip("1.2.3.4", "seed", day=100))
        self.assertNotEqual(h1, dnscommon.hash_ip("1.2.3.4", "seed", day=101))
        self.assertNotEqual(h1, dnscommon.hash_ip("1.2.3.4", "other", day=100))
        self.assertNotEqual(h1, dnscommon.hash_ip("1.2.3.5", "seed", day=100))
        self.assertEqual(len(dnscommon.hash_ip("1.2.3.4", "seed")), 16)

    def test_normalize_ip(self):
        self.assertEqual(dnscommon.normalize_ip("::ffff:1.2.3.4"), "1.2.3.4")
        self.assertEqual(dnscommon.normalize_ip(" 10.0.0.1 "), "10.0.0.1")
        self.assertEqual(dnscommon.normalize_ip("fe80::1%eth0"), "fe80::1")
        self.assertIsNone(dnscommon.normalize_ip("claude.ai"))


class UdpPoolTests(unittest.TestCase):
    def test_query_restores_id_and_tc_fallback(self):
        async def run():
            up = await tu.FakeUpstream().start()
            pool = dnscommon.UdpDnsPool("127.0.0.1", up.port, pool_size=2, timeout=2.0)
            await pool.start()
            try:
                q = tu.make_query("example.com", qid=0x7777)
                r = await pool.query(q)
                self.assertEqual(tu.parse_header(r)["id"], 0x7777)
                self.assertEqual(tu.a_answers(r), [tu.UPSTREAM_A])
                # второй запрос с тем же ID идёт через другой сокет/другой txid — всё равно ок
                r2 = await pool.query(q)
                self.assertEqual(tu.parse_header(r2)["id"], 0x7777)
                self.assertEqual(up.udp_queries, 2)
                # TC по UDP -> повтор по TCP
                big = tu.make_query("big.example.com", qid=0x0101)
                full = await pool.query(big, tcp_fallback=True)
                self.assertFalse(tu.parse_header(full)["tc"])
                self.assertEqual(tu.a_answers(full), [tu.UPSTREAM_A])
                self.assertEqual(up.tcp_queries, 1)
                trunc = await pool.query(big, tcp_fallback=False)
                self.assertTrue(tu.parse_header(trunc)["tc"])
                self.assertEqual(tu.parse_header(trunc)["id"], 0x0101)
                self.assertEqual(up.tcp_queries, 1)
                with self.assertRaises(ValueError):
                    await pool.query(b"short")
            finally:
                pool.close()
                await up.stop()
        asyncio.run(run())

    def test_multi_upstream_failover_and_integrated_cache(self):
        self.assertEqual(
            dnscommon.parse_upstreams("1.1.1.1:53, 8.8.8.8:5353, [2606:4700:4700::1111]:53"),
            [("1.1.1.1", 53), ("8.8.8.8", 5353), ("2606:4700:4700::1111", 53)],
        )

        async def run():
            up1 = await tu.FakeUpstream().start()
            up2 = await tu.FakeUpstream().start()
            up2.answer_ip = "198.51.100.77"
            dead_port = tu.free_port()
            cache = dnscommon.DnsCache(max_entries=100)
            spec = "127.0.0.1:%d,127.0.0.1:%d" % (dead_port, up2.port)
            pool = dnscommon.UdpDnsPool(spec, pool_size=2, timeout=0.25, cache=cache)
            await pool.start()
            try:
                q1 = tu.make_query("cached.example.com", qid=0x1111)
                r1 = await pool.query(q1)
                self.assertEqual(tu.parse_header(r1)["id"], 0x1111)
                self.assertEqual(tu.a_answers(r1), ["198.51.100.77"])
                self.assertEqual(up2.udp_queries, 1)

                # Повторный запрос с другим qid должен прийти из кеша без обращения к апстриму
                q2 = tu.make_query("cached.example.com", qid=0x2222)
                r2 = await pool.query(q2)
                self.assertEqual(tu.parse_header(r2)["id"], 0x2222)
                self.assertEqual(tu.a_answers(r2), ["198.51.100.77"])
                self.assertEqual(up2.udp_queries, 1)
                self.assertEqual(cache.hits, 1)
            finally:
                pool.close()
                await up1.stop()
                await up2.stop()
        asyncio.run(run())


class DnsCacheTests(unittest.TestCase):
    def test_ttl_lru_and_txid_rewrite(self):
        cache = dnscommon.DnsCache(max_entries=2, min_ttl=5, max_ttl=300, negative_ttl=20)
        q1 = tu.make_query("one.example", qid=0x0001)
        r1 = dnscommon.build_response(q1, [dnscommon.a_record("one.example", "1.1.1.1", 60)])
        self.assertTrue(cache.put(q1, r1, now=100.0))

        # Попадание в кеш с подменой transaction ID
        q1_again = tu.make_query("one.example", qid=0xABCD)
        hit = cache.get(q1_again, now=130.0)
        self.assertIsNotNone(hit)
        self.assertEqual(tu.parse_header(hit)["id"], 0xABCD)
        self.assertEqual(tu.a_answers(hit), ["1.1.1.1"])

        # Истечение TTL
        self.assertIsNone(cache.get(q1_again, now=161.0))

        # Кеширование NXDOMAIN и вытеснение по LRU
        cache.put(q1, r1, now=200.0)
        q2 = tu.make_query("nx.example", qid=0x0002)
        r2 = dnscommon.build_response(q2, [], rcode=dnscommon.RCODE_NXDOMAIN)
        self.assertTrue(cache.put(q2, r2, now=200.0))
        # Обратимся к q1, чтобы сделать q2 самым старым (LRU)
        self.assertIsNotNone(cache.get(q1, now=201.0))

        q3 = tu.make_query("three.example", qid=0x0003)
        r3 = dnscommon.build_response(q3, [dnscommon.a_record("three.example", "3.3.3.3", 60)])
        self.assertTrue(cache.put(q3, r3, now=202.0))
        self.assertEqual(len(cache), 2)
        self.assertIsNotNone(cache.get(q1, now=203.0))
        self.assertIsNone(cache.get(q2, now=203.0))
        self.assertIsNotNone(cache.get(q3, now=203.0))

        # Не кешируем TC=1 и REFUSED/SERVFAIL
        self.assertFalse(cache.put(q1, dnscommon.build_truncated(q1), now=200.0))
        self.assertFalse(cache.put(q1, dnscommon.build_refused(q1), now=200.0))
        self.assertFalse(cache.put(q1, dnscommon.build_servfail(q1), now=200.0))
        self.assertEqual(cache.prune(now=500.0), 2)
        self.assertEqual(len(cache), 0)


class HttpTests(unittest.TestCase):
    def test_doh_server_and_http_client(self):
        async def run():
            up = await tu.FakeUpstream().start()
            pool = dnscommon.UdpDnsPool("127.0.0.1", up.port, pool_size=1)
            await pool.start()
            doh = dnscommon.DohHttpServer(dns_pool=pool)
            srv = await asyncio.start_server(doh.handle_client, "127.0.0.1", 0, limit=dnscommon.MAX_HTTP_HEADER_BYTES * 2)
            port = srv.sockets[0].getsockname()[1]
            base = "http://127.0.0.1:%d" % port
            try:
                q = tu.make_query("example.com", qid=0x1111)
                r = await dnscommon.http_request(base + "/dns-query?dns=" + dnscommon.encode_base64url_dns(q))
                self.assertEqual(r.status, 200)
                self.assertEqual(r.headers["content-type"], dnscommon.DNS_MEDIA_TYPE)
                self.assertEqual(r.headers["cache-control"], "max-age=300")
                self.assertEqual(tu.a_answers(r.body), [tu.UPSTREAM_A])
                r = await dnscommon.http_request(base + "/dns-query", "POST", {"Content-Type": dnscommon.DNS_MEDIA_TYPE}, q)
                self.assertEqual(r.status, 200)
                self.assertEqual(tu.parse_header(r.body)["id"], 0x1111)
                r = await dnscommon.http_request(base + "/dns-query", "POST", {"Content-Type": "text/plain"}, q)
                self.assertEqual(r.status, 415)
                r = await dnscommon.http_request(base + "/dns-query")
                self.assertEqual(r.status, 400)
                r = await dnscommon.http_request(base + "/dns-query?dns=!!!")
                self.assertEqual(r.status, 400)
                r = await dnscommon.http_request(base + "/healthz")
                self.assertEqual((r.status, r.body), (200, b"ok\n"))
                r = await dnscommon.http_request(base + "/nope")
                self.assertEqual(r.status, 404)
                r = await dnscommon.http_request(base + "/dns-query", "PUT", body=q)
                self.assertEqual(r.status, 405)
                r = await dnscommon.http_request(base + "/dns-query", "HEAD")
                self.assertEqual(r.status, 400)
                self.assertEqual(r.body, b"")
            finally:
                srv.close()
                await srv.wait_closed()
                pool.close()
                await up.stop()
        asyncio.run(run())

    def test_keep_alive_pipeline_and_subclass_hooks(self):
        """Два запроса в одном соединении + authorize()/handle_other() у наследника."""
        class Guarded(dnscommon.DohHttpServer):
            async def authorize(self, req):
                if req.headers.get("x-token") != "ok":
                    return 403, b"no\n"
                return None

            async def resolve(self, wire_query, req):
                return dnscommon.build_refused(wire_query)

            async def handle_other(self, writer, req):
                if req.path == "/metrics.json":
                    await self.send_json(writer, 200, {"peer": bool(req.peer)}, keep_alive=req.keep_alive)
                    return req.keep_alive
                return await super().handle_other(writer, req)

        async def run():
            doh = Guarded()
            srv = await asyncio.start_server(doh.handle_client, "127.0.0.1", 0)
            port = srv.sockets[0].getsockname()[1]
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                q = tu.make_query("x.com")
                enc = dnscommon.encode_base64url_dns(q)
                writer.write(("GET /dns-query?dns=%s HTTP/1.1\r\nHost: x\r\n\r\n" % enc).encode())
                writer.write(("GET /dns-query?dns=%s HTTP/1.1\r\nHost: x\r\nX-Token: ok\r\n\r\n" % enc).encode())
                writer.write(b"GET /metrics.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                await writer.drain()
                raw = await asyncio.wait_for(reader.read(), timeout=3.0)
                writer.close()
                text = raw.decode("latin-1")
                self.assertEqual(text.count("HTTP/1.1 "), 3)
                self.assertIn("HTTP/1.1 403 Forbidden", text)
                self.assertIn("HTTP/1.1 200 OK\r\nContent-Type: application/dns-message", text)
                self.assertIn('"peer": true', text)
                self.assertIn("Connection: close", text)
            finally:
                srv.close()
                await srv.wait_closed()
        asyncio.run(run())

    def test_http_request_chunked_and_304(self):
        async def handler(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n"
                         b"5\r\n{\"a\":\r\n3\r\n 1}\r\n0\r\n\r\n")
            await writer.drain()
            writer.close()

        async def handler304(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 304 Not Modified\r\nX-Policy: 5\r\n\r\n")
            await writer.drain()
            writer.close()

        async def run():
            s1 = await asyncio.start_server(handler, "127.0.0.1", 0)
            s2 = await asyncio.start_server(handler304, "127.0.0.1", 0)
            try:
                r = await dnscommon.http_request("http://127.0.0.1:%d/x?y=1" % s1.sockets[0].getsockname()[1])
                self.assertEqual((r.status, r.body), (200, b'{"a": 1}'))
                r = await dnscommon.http_request("http://127.0.0.1:%d/" % s2.sockets[0].getsockname()[1])
                self.assertEqual((r.status, r.headers.get("x-policy"), r.body), (304, "5", b""))
                with self.assertRaises(ValueError):
                    await dnscommon.http_request("ftp://127.0.0.1/")
            finally:
                for s in (s1, s2):
                    s.close()
                    await s.wait_closed()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
