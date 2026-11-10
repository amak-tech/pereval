# -*- coding: utf-8 -*-
import asyncio
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import dnstestutil as tu  # noqa: E402
import pro_node_agent as agent  # noqa: E402

agent.log = lambda msg: None  # в тестах лог агента не нужен


class PureFunctionTests(unittest.TestCase):
    def test_parse_ip_list(self):
        self.assertEqual(agent.parse_ip_list("203.0.113.10, 203.0.113.20 153.80.200.170,203.0.113.10"),
                         ["203.0.113.10", "203.0.113.20", "153.80.200.170"])
        self.assertEqual(agent.parse_ip_list(["1.1.1.1", "2001:db8::1", "junk", ""]), ["1.1.1.1"])
        self.assertEqual(agent.parse_ip_list(None), [])

    def test_render_table_script(self):
        script = agent.render_table_script("203.0.113.10,203.0.113.20")
        lines = [ln.strip() for ln in script.splitlines() if ln.strip()]
        self.assertEqual(lines[0], "table inet pereval_pro {")
        self.assertIn("set pro_clients {", lines)
        self.assertIn("type ipv4_addr", lines)
        self.assertIn("type filter hook input priority -10; policy accept;", lines)
        chain_rules = [ln for ln in lines if ln.startswith(("iif", "tcp", "udp"))]
        self.assertEqual(chain_rules, [
            "iif lo accept",
            "tcp dport { 80, 443 } ip saddr @pro_clients accept",
            "tcp dport { 80, 443 } ip saddr { 203.0.113.10, 203.0.113.20 } accept",
            "tcp dport { 80, 443 } drop",
            "udp dport 443 reject",
        ])
        # без доверенных IP строки с пустым набором быть не должно
        no_trusted = agent.render_table_script("")
        self.assertNotIn("ip saddr {", no_trusted)
        self.assertIn("ip saddr @pro_clients accept", no_trusted)

    def test_render_chain_rewrite_script(self):
        script = agent.render_chain_rewrite_script(["1.1.1.1"])
        lines = script.strip().splitlines()
        self.assertEqual(lines[0], "flush chain inet pereval_pro input")
        self.assertTrue(all(ln.startswith("add rule inet pereval_pro input ") for ln in lines[1:]))
        self.assertEqual(len(lines), 1 + 5)

    def test_parse_set_elements(self):
        nft_json = json.dumps({"nftables": [
            {"metainfo": {"version": "1.0.6", "json_schema_version": 1}},
            {"set": {"family": "inet", "name": "pro_clients", "table": "pereval_pro", "type": "ipv4_addr",
                     "elem": ["1.2.3.4", {"elem": {"val": "5.6.7.8", "expires": 100}},
                              {"prefix": {"addr": "9.9.9.9", "len": 32}},
                              {"prefix": {"addr": "10.0.0.0", "len": 8}},
                              {"range": ["7.7.7.7", "7.7.7.7"]}]}},
        ]})
        self.assertEqual(agent.parse_set_elements(nft_json), {"1.2.3.4", "5.6.7.8", "9.9.9.9", "10.0.0.0/8", "7.7.7.7"})
        self.assertEqual(agent.parse_set_elements(""), set())
        # пустой набор без elem
        self.assertEqual(agent.parse_set_elements(json.dumps({"nftables": [{"set": {"name": "pro_clients"}}]})), set())

    def test_parse_iso8601(self):
        self.assertEqual(agent.parse_iso8601("1970-01-01T00:00:10Z"), 10.0)
        self.assertEqual(agent.parse_iso8601("1970-01-01T01:00:10+01:00"), 10.0)
        self.assertEqual(agent.parse_iso8601("1970-01-01T00:00:10.1234567Z"), 10.123456)
        self.assertEqual(agent.parse_iso8601("1970-01-01T00:00:10"), 10.0)  # без зоны = UTC
        self.assertEqual(agent.parse_iso8601(25), 25.0)
        self.assertIsNone(agent.parse_iso8601("yesterday"))
        self.assertIsNone(agent.parse_iso8601(None))

    def test_desired_set_and_diff(self):
        acl = {
            "version": 55,
            "static": ["1.2.3.4", "2001:db8::1", "bad", "1.2.3.4"],
            "dynamic": [
                {"ip": "5.6.7.8", "expires_at": "2100-01-01T00:00:00Z"},
                {"ip": "9.9.9.9", "expires_at": "2000-01-01T00:00:00Z"},   # истёк
                {"ip": "8.8.4.4", "expires_at": None},                    # бессрочно
                "7.7.7.7",
            ],
        }
        desired = agent.desired_set(acl, now=1.7e9)
        self.assertEqual(desired, {"1.2.3.4", "5.6.7.8", "8.8.4.4", "7.7.7.7"})
        current = {"1.2.3.4", "9.9.9.9", "10.0.0.1"}
        to_add, to_del = agent.compute_diff(current, desired)
        self.assertEqual(to_add, ["5.6.7.8", "7.7.7.7", "8.8.4.4"])
        self.assertEqual(to_del, ["9.9.9.9", "10.0.0.1"])
        self.assertEqual(agent.desired_set(None), set())

    def test_render_update_script(self):
        script = agent.render_update_script(["5.6.7.8", "7.7.7.7"], ["9.9.9.9"])
        self.assertEqual(script, "delete element inet pereval_pro pro_clients { 9.9.9.9 }\n"
                                 "add element inet pereval_pro pro_clients { 5.6.7.8, 7.7.7.7 }\n")
        self.assertEqual(agent.render_update_script([], []), "")
        many = ["10.0.%d.%d" % (i // 256, i % 256) for i in range(1200)]
        chunked = agent.render_update_script(many, [], chunk=500)
        self.assertEqual(chunked.count("add element"), 3)
        self.assertEqual(sum(ln.count(",") + 1 for ln in chunked.strip().splitlines()), 1200)

    def test_render_extra_maps(self):
        sni, host = agent.render_extra_maps(["Example.COM.", "corp.example.org", "bad_domain", "nodots", "example.com"])
        self.assertIn(".example.com", sni)
        self.assertIn(".corp.example.org", sni)
        self.assertNotIn("bad_domain", sni)
        self.assertNotIn("nodots", sni)
        self.assertEqual(sni.count("$ssl_preread_server_name:443;"), 2)
        self.assertEqual(host.count("$host;"), 2)
        empty_sni, empty_host = agent.render_extra_maps([])
        self.assertNotIn(";", empty_sni)
        self.assertTrue(empty_sni.startswith("#") and empty_host.startswith("#"))


def _args(extra=None):
    d = tu.tmpdir()
    argv = ["--dry-run", "--no-cp", "--trusted-ips", "203.0.113.10,203.0.113.20",
            "--extra-sni-map", str(Path(d) / "extra-sni.map"), "--extra-host-map", str(Path(d) / "extra-host.map")]
    return agent.parse_args(argv + (extra or []))


class AgentDryRunTests(unittest.TestCase):
    def test_ensure_table_idempotent_and_sync_acl_diff(self):
        a = agent.Agent(_args())
        with redirect_stdout(io.StringIO()) as out:
            self.assertTrue(a.ensure_table())
            self.assertFalse(a.ensure_table())
            self.assertFalse(a.ensure_table(rewrite_chain=True))
        printed = out.getvalue()
        self.assertIn("nft -f -", printed)
        self.assertIn("table inet pereval_pro {", printed)
        self.assertIn("flush chain inet pereval_pro input", printed)
        self.assertEqual(len(a.nft.executed), 2)  # создание + переписывание цепочки

        a.nft.sim_set = {"1.1.1.1", "2.2.2.2"}
        acl = {"version": 1, "static": ["1.1.1.1", "3.3.3.3"], "dynamic": [{"ip": "4.4.4.4", "expires_at": "2100-01-01T00:00:00Z"}]}
        with redirect_stdout(io.StringIO()) as out:
            added, removed, total = a.sync_acl(acl)
        self.assertEqual((added, removed, total), (2, 1, 3))
        argv, script = a.nft.executed[-1]
        self.assertEqual(argv, ["nft", "-f", "-"])
        self.assertEqual(script, "delete element inet pereval_pro pro_clients { 2.2.2.2 }\n"
                                 "add element inet pereval_pro pro_clients { 3.3.3.3, 4.4.4.4 }\n")
        self.assertEqual(a.nft.sim_set, {"1.1.1.1", "3.3.3.3", "4.4.4.4"})
        # повторная синхронизация без изменений — транзакции нет
        n = len(a.nft.executed)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(a.sync_acl(acl), (0, 0, 3))
        self.assertEqual(len(a.nft.executed), n)

    def test_run_no_cp_once(self):
        a = agent.Agent(_args())
        with redirect_stdout(io.StringIO()):
            rc = asyncio.run(a.run())
        self.assertEqual(rc, 0)
        self.assertTrue(a.nft.sim_table)

    def test_apply_extra_domains_dry_run(self):
        a = agent.Agent(_args())
        with redirect_stdout(io.StringIO()) as out:
            self.assertTrue(a.apply_extra_domains(["x.example.com"]))
        self.assertIn("would write", out.getvalue())


class AgentWithFakeControlPlaneTests(unittest.TestCase):
    def test_acl_long_poll_applies_static_and_dynamic(self):
        seen = []

        async def cp_handler(reader, writer):
            head = await reader.readuntil(b"\r\n\r\n")
            text = head.decode("latin-1")
            req_line = text.split("\r\n")[0]
            seen.append(req_line)
            if "Authorization: Bearer s3cret" not in text:
                body = b'{"error":"unauthorized"}'
                writer.write(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
            elif "/api/internal/v1/node/acl?version=0" in req_line:
                body = json.dumps({"version": 55, "static": ["1.2.3.4"],
                                   "dynamic": [{"ip": "5.6.7.8", "expires_at": "2100-01-01T00:00:00Z"},
                                               {"ip": "9.9.9.9", "expires_at": "2000-01-01T00:00:00Z"}]}).encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
            elif "/api/internal/v1/node/acl" in req_line:
                await asyncio.sleep(0.05)
                writer.write(b"HTTP/1.1 304 Not Modified\r\n\r\n")
            elif "/api/internal/v1/node/config" in req_line:
                body = json.dumps({"version": 1, "extra_domains": [], "tenant": None}).encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
            else:
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()

        async def run():
            cp = await asyncio.start_server(cp_handler, "127.0.0.1", 0)
            port = cp.sockets[0].getsockname()[1]
            args = _args(["--cp-origin", "http://127.0.0.1:%d" % port, "--node-secret", "s3cret", "--cp-wait", "1"])
            args.no_cp = False
            a = agent.Agent(args)
            a.stop_event = asyncio.Event()
            with redirect_stdout(io.StringIO()):
                a.ensure_table()
                task = asyncio.ensure_future(a.acl_loop())
                for _ in range(100):
                    await asyncio.sleep(0.02)
                    if any("add element" in (s or "") for _argv, s in a.nft.executed) and len(seen) >= 2:
                        break
                a.stop_event.set()
                await asyncio.wait_for(task, timeout=3.0)
            cp.close()
            await cp.wait_closed()
            scripts = [s for _argv, s in a.nft.executed if s and "add element" in s]
            self.assertEqual(len(scripts), 1)
            self.assertEqual(scripts[0], "add element inet pereval_pro pro_clients { 1.2.3.4, 5.6.7.8 }\n")
            self.assertEqual(a.acl_version, 55)
            self.assertTrue(any("version=55" in s for s in seen), seen)  # после 200 опрашиваем новую версию
        asyncio.run(run())

    def test_cp_unreachable_keeps_set(self):
        async def run():
            # порт, на котором никто не слушает
            port = tu.free_port()
            args = _args(["--cp-origin", "http://127.0.0.1:%d" % port, "--node-secret", "x", "--cp-wait", "1"])
            args.no_cp = False
            a = agent.Agent(args)
            a.stop_event = asyncio.Event()
            a.nft.sim_table = True
            a.nft.sim_set = {"1.1.1.1"}
            a.last_cp_ok = 0  # «давно»
            with redirect_stdout(io.StringIO()):
                task = asyncio.ensure_future(a.acl_loop())
                await asyncio.sleep(0.3)
                a.stop_event.set()
                await asyncio.wait_for(task, timeout=3.0)
            # никаких транзакций над набором: он остался как был
            self.assertFalse(any(s and ("delete element" in s or "flush set" in s) for _argv, s in a.nft.executed))
            self.assertEqual(a.nft.sim_set, {"1.1.1.1"})
            self.assertGreater(a.last_warn, 0)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
