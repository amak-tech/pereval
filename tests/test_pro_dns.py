# -*- coding: utf-8 -*-
import asyncio
import json
import socket
import ssl
import struct
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import dnscommon  # noqa: E402
import dnstestutil as tu  # noqa: E402
import pro_dns  # noqa: E402

TOK_PROXY = "abcdefghijklmnopqrs2"
TOK_PLAIN = "plainplainplainpla23"
TOK_DENY = "denydenydenydenyden4"
TOK_UNKNOWN = "unknownunknownunkn56"
PRO_DOMAIN = "pro.test"
W1, W2, W3 = "203.0.113.31", "203.0.113.32", "203.0.113.33"

POLICY_MAP = {
    "domain": PRO_DOMAIN,
    "dns_ip": "127.0.0.1",
    "probe_sni": "claude.ai",
    "pools": {"default": {}, "ai": {"fallback": "default"}, "media": {"fallback": "default"}},
    "workers": [
        {"ip": W1, "name": "w1", "pools": ["default", "ai", "media"]},
        {"ip": W2, "name": "w2", "pools": ["ai"]},
        {"ip": W3, "name": "w3", "pools": ["ai"]},
    ],
    "categories": [
        {"id": "ai", "name": "AI", "tier": "free", "pool": "ai"},
        {"id": "media", "name": "Media", "tier": "pro", "pool": "media"},
    ],
    "domains": {
        "claude.ai": {"service": "Anthropic / Claude", "category_id": "ai", "tier": "free", "pool": "ai"},
        "anthropic.com": {"service": "Anthropic / Claude", "category_id": "ai", "tier": "free", "pool": "ai"},
        "chatgpt.com": {"service": "OpenAI", "category_id": "ai", "tier": "free", "pool": "ai"},
        "netflix.com": {"service": "Netflix", "category_id": "media", "tier": "pro", "pool": "media"},
    },
}

POLICY = {
    "version": 7,
    "generated_at": "2026-11-09T12:00:00Z",
    "tokens": {
        TOK_PROXY: {"user_id": "u-proxy", "mode": "proxy", "disabled_categories": ["media"], "qps_limit": 50},
        TOK_PLAIN: {"user_id": "u-plain", "mode": "plain", "disabled_categories": [], "qps_limit": 2},
        TOK_DENY: {"user_id": "u-deny", "mode": "deny", "disabled_categories": []},
        "BAD TOKEN": {"user_id": "x", "mode": "proxy"},
        "shortone": {"user_id": "x", "mode": "proxy"},
    },
    "ips": {"198.51.100.7": {"user_id": "u-ip", "mode": "proxy", "disabled_categories": []},
            "::ffff:198.51.100.8": {"user_id": "u-ip2", "mode": "weird"}},
    "workers": None,
}


def _quiet():
    pro_dns.log = lambda msg: None


def _write_json(path, obj):
    Path(path).write_text(json.dumps(obj), encoding="utf-8")
    return str(path)


def make_server(tmp, extra_argv=None, policy=POLICY, policy_map=POLICY_MAP, upstream_port=5353):
    pm = _write_json(Path(tmp) / "pro-policy-map.json", policy_map)
    pf = _write_json(Path(tmp) / "policy.json", policy)
    argv = ["--no-cp", "--policy-map", pm, "--policy-file", pf, "--policy-cache", "",
            "--health-out", "", "--health-interval", "3600", "--listen-ip", "", "--doh-listen", "",
            "--upstream", "127.0.0.1:%d" % upstream_port, "--pro-domain", PRO_DOMAIN]
    args = pro_dns.parse_args(argv + (extra_argv or []))
    return pro_dns.build_server(args)


class PolicyMapAndTokenTests(unittest.TestCase):
    def setUp(self):
        _quiet()

    def test_suffix_match(self):
        pm = pro_dns.PolicyMap(POLICY_MAP)
        self.assertEqual(pm.match("claude.ai")[0], "claude.ai")
        self.assertEqual(pm.match("API.Anthropic.com.")[0], "anthropic.com")
        self.assertEqual(pm.match("a.b.c.chatgpt.com")[1]["service"], "OpenAI")
        self.assertEqual(pm.match("notclaude.ai"), (None, None))
        self.assertEqual(pm.match("ai"), (None, None))
        self.assertEqual(pm.match(""), (None, None))
        self.assertEqual(pm.match("claude.ai.evil.com"), (None, None))

    def test_token_from_sni(self):
        self.assertEqual(pro_dns.token_from_sni("%s.%s" % (TOK_PROXY, PRO_DOMAIN), PRO_DOMAIN), TOK_PROXY)
        self.assertEqual(pro_dns.token_from_sni("%s.PRO.TEST." % TOK_PROXY.upper(), PRO_DOMAIN), TOK_PROXY)
        self.assertIsNone(pro_dns.token_from_sni(None, PRO_DOMAIN))
        self.assertIsNone(pro_dns.token_from_sni(PRO_DOMAIN, PRO_DOMAIN))
        self.assertIsNone(pro_dns.token_from_sni("%s.other.test" % TOK_PROXY, PRO_DOMAIN))
        self.assertIsNone(pro_dns.token_from_sni("x.%s.%s" % (TOK_PROXY, PRO_DOMAIN), PRO_DOMAIN))
        self.assertIsNone(pro_dns.token_from_sni("short.%s" % PRO_DOMAIN, PRO_DOMAIN))
        self.assertIsNone(pro_dns.token_from_sni("ABCDEFGHIJKLMNOPQRS1.%s" % PRO_DOMAIN, PRO_DOMAIN))  # «1» вне base32

    def test_policy_normalization(self):
        pol = pro_dns.Policy.from_dict(POLICY, source="file")
        self.assertEqual(pol.version, 7)
        self.assertEqual(set(pol.tokens), {TOK_PROXY, TOK_PLAIN, TOK_DENY})
        self.assertEqual(pol.tokens[TOK_PROXY]["disabled_categories"], frozenset({"media"}))
        self.assertEqual(pol.tokens[TOK_DENY]["qps_limit"], pro_dns.DEFAULT_QPS_LIMIT)
        self.assertEqual(set(pol.ips), {"198.51.100.7", "198.51.100.8"})
        self.assertEqual(pol.ips["198.51.100.8"]["mode"], "deny")  # неизвестный режим -> deny
        self.assertIsNone(pol.workers)
        rt = pro_dns.Policy.from_dict(pol.to_dict())
        self.assertEqual(rt.tokens[TOK_PROXY]["disabled_categories"], frozenset({"media"}))
        with self.assertRaises(ValueError):
            pro_dns.Policy.from_dict([])


class DecisionTests(unittest.TestCase):
    def setUp(self):
        _quiet()
        self.tmp = tu.tmpdir()
        self.srv = make_server(self.tmp)

    def q(self, name, qtype=1):
        return dnscommon.parse_question(tu.make_query(name, qtype))

    def test_modes_and_unknown(self):
        srv = self.srv
        unknown = srv.identify_token(TOK_UNKNOWN, "1.1.1.1")
        self.assertFalse(unknown.known)
        self.assertEqual(srv.decide(self.q("claude.ai"), unknown)[0], pro_dns.D_REFUSED)
        self.assertEqual(srv.decide(self.q("claude.ai"), srv.identify_token("not-a-token", "1.1.1.1"))[0], pro_dns.D_REFUSED)
        deny = srv.identify_token(TOK_DENY, "1.1.1.1")
        self.assertEqual(srv.decide(self.q("claude.ai"), deny), (pro_dns.D_REFUSED, "deny"))
        plain = srv.identify_token(TOK_PLAIN, "1.1.1.1")
        self.assertEqual(srv.decide(self.q("claude.ai"), plain, now=1000.0), (pro_dns.D_FORWARD, "plain"))
        self.assertEqual(srv.identify_ip("::ffff:198.51.100.7").user["user_id"], "u-ip")
        self.assertFalse(srv.identify_ip("198.51.100.9").known)
        self.assertFalse(srv.identify_ip("garbage").known)

    def test_proxy_decisions(self):
        srv = self.srv
        ident = srv.identify_token(TOK_PROXY, "1.1.1.1")
        action, ip = srv.decide(self.q("claude.ai"), ident)
        self.assertEqual(action, pro_dns.D_SYNTH_A)
        self.assertIn(ip, (W1, W2, W3))
        # все домены одного сервиса -> один и тот же воркер
        self.assertEqual(srv.decide(self.q("console.anthropic.com"), ident)[1], ip)
        for qt in (dnscommon.QTYPE_AAAA, dnscommon.QTYPE_HTTPS, dnscommon.QTYPE_SVCB):
            self.assertEqual(srv.decide(self.q("claude.ai", qt), ident)[0], pro_dns.D_NODATA)
        self.assertEqual(srv.decide(self.q("claude.ai", dnscommon.QTYPE_TXT), ident), (pro_dns.D_FORWARD, "qtype"))
        self.assertEqual(srv.decide(self.q("example.com"), ident), (pro_dns.D_FORWARD, "nomatch"))
        # media отключена у этого пользователя -> обычный форвард
        self.assertEqual(srv.decide(self.q("www.netflix.com"), ident), (pro_dns.D_FORWARD, "disabled"))
        # у IP-пользователя media включена -> воркер пула media (w1 — единственный)
        ip_ident = srv.identify_ip("198.51.100.7")
        self.assertEqual(srv.decide(self.q("www.netflix.com"), ip_ident), (pro_dns.D_SYNTH_A, W1))
        # класс CH -> форвард
        qch = dnscommon.parse_question(tu.make_query("claude.ai", 1, qclass=3))
        self.assertEqual(srv.decide(qch, ident), (pro_dns.D_FORWARD, "class"))

    def test_rate_limit(self):
        srv = self.srv
        plain = srv.identify_token(TOK_PLAIN, "1.1.1.1")  # qps_limit=2, burst x2 = 4
        t = 5000.0
        results = [srv.decide(self.q("a%d.com" % i), plain, now=t)[0] for i in range(6)]
        self.assertEqual(results[:4], [pro_dns.D_FORWARD] * 4)
        self.assertEqual(results[4:], [pro_dns.D_RATELIMIT] * 2)
        # через полсекунды накапливается 1 токен
        self.assertEqual(srv.decide(self.q("b.com"), plain, now=t + 0.5)[0], pro_dns.D_FORWARD)
        self.assertEqual(srv.decide(self.q("c.com"), plain, now=t + 0.5)[0], pro_dns.D_RATELIMIT)
        # другой пользователь не затронут
        other = srv.identify_token(TOK_PROXY, "1.1.1.1")
        self.assertEqual(srv.decide(self.q("x.com"), other, now=t)[0], pro_dns.D_FORWARD)
        self.assertEqual(srv.limiter.prune(now=t + 10000), 2)

    def test_pool_pick_with_dead_worker_and_fail_open(self):
        srv = self.srv
        ident = srv.identify_token(TOK_PROXY, "1.1.1.1")
        services = ["Anthropic / Claude", "OpenAI"] + ["svc%d" % i for i in range(40)]
        for i, s in enumerate(services[2:]):
            srv.policy_map.domains["svc%d.test" % i] = {"service": s, "category_id": "ai", "tier": "pro", "pool": "ai"}
        before = {s: srv.decide(self.q(d), ident)[1] for d, s in
                  ((d, info["service"]) for d, info in srv.policy_map.domains.items() if info["pool"] == "ai")}
        dead = before["Anthropic / Claude"]
        now = time.time()
        # гистерезис: одна ошибка ещё не DOWN
        srv.health.update(dead, "w", False, 1.0, "boom", now)
        srv.recompute_routing()
        self.assertEqual(srv.decide(self.q("claude.ai"), ident)[1], dead)
        srv.health.update(dead, "w", False, 1.0, "boom", now)
        srv.recompute_routing()
        self.assertNotIn(dead, srv.healthy_by_pool["ai"])
        after = {s: srv.decide(self.q(d), ident)[1] for d, s in
                 ((d, info["service"]) for d, info in srv.policy_map.domains.items() if info["pool"] == "ai")}
        self.assertNotEqual(after["Anthropic / Claude"], dead)
        moved = [s for s in after if after[s] != before[s]]
        self.assertTrue(moved and all(before[s] == dead for s in moved))
        self.assertTrue(all(v != dead for v in after.values()))
        # возврат: один успех — ещё DOWN, два — UP
        srv.health.update(dead, "w", True, 1.0, None, now)
        self.assertFalse(srv.health.is_healthy(dead))
        srv.health.update(dead, "w", True, 1.0, None, now)
        self.assertTrue(srv.health.is_healthy(dead))
        # все мертвы -> fail-open: все снова кандидаты
        for ip in (W1, W2, W3):
            for _ in range(2):
                srv.health.update(ip, "w", False, 1.0, "down", now)
        srv.recompute_routing()
        self.assertTrue(srv.fail_open)
        self.assertEqual(set(srv.healthy_by_pool["ai"]), {W1, W2, W3})
        self.assertEqual(srv.decide(self.q("claude.ai"), ident)[0], pro_dns.D_SYNTH_A)
        snap = srv.health_snapshot()
        self.assertTrue(snap["fail_open"])
        self.assertEqual([w["status"] for w in snap["workers"]], ["down"] * 3)

    def test_policy_workers_override(self):
        srv = self.srv
        pol = pro_dns.Policy.from_dict(dict(POLICY, version=8, workers=[{"ip": "203.0.113.99", "name": "solo", "pools": ["default"]}]))
        srv.apply_policy(pol, persist=False)
        self.assertEqual(srv.all_worker_ips, ["203.0.113.99"])
        ident = srv.identify_token(TOK_PROXY, "1.1.1.1")
        # пул ai пуст -> fallback default -> единственный воркер
        self.assertEqual(srv.decide(self.q("claude.ai"), ident), (pro_dns.D_SYNTH_A, "203.0.113.99"))
        self.assertEqual(srv.metrics()["policy"]["version"], 8)


class ResolveWithUpstreamTests(unittest.TestCase):
    def setUp(self):
        _quiet()
        self.tmp = tu.tmpdir()

    def test_resolve_paths(self):
        async def run():
            up = await tu.FakeUpstream().start()
            srv = make_server(self.tmp, upstream_port=up.port)
            await srv.upstream.start()
            try:
                ident = srv.identify_token(TOK_PROXY, "1.2.3.4")
                r = await srv.resolve(tu.make_query("claude.ai", 1, qid=0x1001, do=True), ident, "doh")
                self.assertEqual(tu.parse_header(r)["id"], 0x1001)
                self.assertEqual(len(tu.a_answers(r)), 1)
                self.assertIn(tu.a_answers(r)[0], (W1, W2, W3))
                ans, _ns, ar = tu.parse_records(r)
                self.assertEqual(ans[0][3], 60)        # --answer-ttl
                self.assertEqual(ar[0][1], 41)         # OPT echoed
                self.assertEqual(up.udp_queries, 0)    # до upstream не дошло
                r = await srv.resolve(tu.make_query("claude.ai", 28), ident, "doh")
                self.assertEqual((tu.parse_header(r)["rcode"], tu.parse_header(r)["an"]), (0, 0))
                r = await srv.resolve(tu.make_query("example.com", 1), ident, "udp", tcp_fallback=False)
                self.assertEqual(tu.a_answers(r), [tu.UPSTREAM_A])
                self.assertEqual(up.udp_queries, 1)
                r = await srv.resolve(tu.make_query("big.example.com", 1), ident, "tcp", tcp_fallback=True)
                self.assertFalse(tu.parse_header(r)["tc"])
                self.assertEqual(up.tcp_queries, 1)
                r = await srv.resolve(tu.make_query("claude.ai"), srv.identify_token(TOK_UNKNOWN, "1.2.3.4"), "dot")
                self.assertEqual(tu.parse_header(r)["rcode"], 5)
                r = await srv.resolve(struct.pack("!HHHHHH", 7, 0, 1, 0, 0, 0) + b"\x09ab", ident, "udp")
                self.assertEqual((tu.parse_header(r)["rcode"], tu.parse_header(r)["qd"]), (1, 0))
                self.assertIsNone(await srv.resolve(b"\x00" * 5, ident, "udp"))
                m = srv.metrics()
                self.assertEqual(m["by_decision"]["synth_a"], 1)
                self.assertEqual(m["by_decision"]["nodata"], 1)
                self.assertEqual(m["by_decision"]["forward"], 2)
                self.assertEqual(m["by_decision"]["refused"], 1)
                self.assertEqual(m["by_decision"]["formerr"], 1)
                self.assertEqual(m["by_decision"]["drop"], 1)
                self.assertEqual(dict(m["by_transport"]), {"udp": 3, "tcp": 1, "dot": 1, "doh": 2})
                self.assertEqual(m["active_tokens_5m"], 1)
                # upstream недоступен -> SERVFAIL, не исключение
                await up.stop()
                srv.upstream.timeout = 0.2
                r = await srv.resolve(tu.make_query("example.org", 1), ident, "udp")
                self.assertEqual(tu.parse_header(r)["rcode"], 2)
            finally:
                srv.upstream.close()
        asyncio.run(run())


class ActivityTrackerTests(unittest.TestCase):
    def setUp(self):
        _quiet()

    def _ident(self, token=TOK_PROXY, ip="1.2.3.4", mode="proxy", user_id="u1"):
        user = {"user_id": user_id, "mode": mode, "disabled_categories": frozenset(), "qps_limit": 50}
        return pro_dns.Identity("token" if token else "ip", token or ip, user, ip)

    def test_acl_activity_alerts_payload(self):
        tr = pro_dns.ActivityTracker("seed", max_ips_per_day=2)
        t0 = 1_700_000_000.0
        tr.record(self._ident(), t0)
        tr.record(self._ident(), t0 + 1)
        self.assertEqual(len(tr.pending_acl), 1)
        self.assertEqual(list(tr.pending_acl.values())[0], {"ip": "1.2.3.4", "token": TOK_PROXY, "user_id": "u1"})
        ent = list(tr.activity.values())[0]
        self.assertEqual(ent, [2, int(t0), int(t0 + 1)])
        # plain-режим: активность есть, ACL — нет
        tr.record(self._ident(token=TOK_PLAIN, ip="9.9.9.9", mode="plain", user_id="u2"), t0)
        self.assertEqual(len(tr.pending_acl), 1)
        # третий IP у TOK_PROXY -> алерт too_many_ips (порог 2)
        tr.record(self._ident(ip="1.2.3.5"), t0)
        self.assertEqual(tr.pending_alerts, {})
        tr.record(self._ident(ip="1.2.3.6"), t0)
        self.assertEqual(tr.pending_alerts[TOK_PROXY]["count"], 3)
        self.assertEqual(tr.pending_alerts[TOK_PROXY]["type"], "too_many_ips")

        payload = tr.build_payload("pro-dns", {"policy_version": 7, "qps": 1.0, "workers": []}, now=t0 + 2)
        self.assertEqual(payload["node"], "pro-dns")
        self.assertEqual(payload["ts"], int(t0 + 2))
        self.assertEqual(sorted(a["ip"] for a in payload["acl"]), ["1.2.3.4", "1.2.3.5", "1.2.3.6"])
        self.assertEqual(len(payload["activity"]), 4)
        for a in payload["activity"]:
            self.assertEqual(len(a["ip_hash"]), 16)
            self.assertNotIn("ip", a)
            self.assertIn(a["token"], (TOK_PROXY, TOK_PLAIN))
        self.assertEqual(payload["alerts"][0]["user_id"], "u1")
        self.assertEqual(payload["health"]["policy_version"], 7)
        self.assertFalse(tr.has_pending())
        # повторный запрос с известного IP в течение 10 минут ACL не порождает
        tr.record(self._ident(), t0 + 100)
        self.assertEqual(len(tr.pending_acl), 0)
        tr.record(self._ident(), t0 + 100 + pro_dns.ACL_REPORT_INTERVAL)
        self.assertEqual(len(tr.pending_acl), 1)
        # requeue после неудачного POST
        tr.requeue(payload)
        self.assertEqual(len(tr.pending_acl), 3)
        self.assertEqual(len(tr.pending_alerts), 1)
        self.assertTrue(tr.has_pending())
        # ротация суток сбрасывает учёт IP
        tr.record(self._ident(ip="1.2.3.7"), t0 + 86400 * 2)
        self.assertEqual(len(tr.token_ips[TOK_PROXY]), 1)

    def test_unknown_identity_not_recorded(self):
        tr = pro_dns.ActivityTracker("seed")
        tr.record(pro_dns.Identity("none", None, None, "1.2.3.4"), 1.0)
        self.assertFalse(tr.has_pending())


class ControlPlaneTests(unittest.TestCase):
    """Long-poll политики и POST активности против фейкового CP на asyncio.start_server."""

    def setUp(self):
        _quiet()
        self.tmp = tu.tmpdir()

    def test_policy_long_poll_and_activity_post(self):
        requests = []
        posts = []
        state = {"policy_calls": 0}

        async def cp(reader, writer):
            head = await reader.readuntil(b"\r\n\r\n")
            text = head.decode("latin-1")
            lines = text.split("\r\n")
            req_line = lines[0]
            hdrs = dict((k.strip().lower(), v.strip()) for k, v in (ln.split(":", 1) for ln in lines[1:] if ":" in ln))
            body = b""
            if "content-length" in hdrs:
                body = await reader.readexactly(int(hdrs["content-length"]))
            requests.append((req_line, hdrs.get("authorization")))
            if hdrs.get("authorization") != "Bearer node-secret":
                writer.write(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
            elif req_line.startswith("GET /api/internal/v1/policy"):
                state["policy_calls"] += 1
                if state["policy_calls"] == 1:
                    writer.write(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
                elif "version=7" in req_line:
                    payload = json.dumps(dict(POLICY, version=124)).encode()
                    # chunked, как может отдать Node
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n")
                    writer.write(b"%x\r\n" % len(payload) + payload + b"\r\n0\r\n\r\n")
                else:
                    await asyncio.sleep(0.05)
                    writer.write(b"HTTP/1.1 304 Not Modified\r\n\r\n")
            elif req_line.startswith("POST /api/internal/v1/dns/activity"):
                posts.append(json.loads(body.decode("utf-8")))
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}")
            else:
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()

        async def run():
            cp_srv = await asyncio.start_server(cp, "127.0.0.1", 0)
            port = cp_srv.sockets[0].getsockname()[1]
            cache = Path(self.tmp) / "policy-cache.json"
            srv = make_server(self.tmp, ["--cp-origin", "http://127.0.0.1:%d" % port, "--node-secret", "node-secret",
                                         "--cp-wait", "1", "--cp-timeout", "2", "--policy-cache", str(cache)])
            srv.args.no_cp = False
            srv.cp = pro_dns.ControlPlane(srv.args.cp_origin, srv.args.node_secret, timeout=2.0)
            srv.stop_event = asyncio.Event()
            srv.tracker.attach_loop()
            self.assertEqual(srv.policy.version, 7)
            task = asyncio.ensure_future(srv.policy_loop())
            try:
                for _ in range(200):
                    await asyncio.sleep(0.02)
                    if srv.policy.version == 124 and state["policy_calls"] >= 3:
                        break
                self.assertEqual(srv.policy.version, 124)
                self.assertEqual(srv.policy.source, "cp")
                self.assertTrue(cache.is_file())
                cached = json.loads(cache.read_text(encoding="utf-8"))
                self.assertEqual(cached["version"], 124)
                self.assertIn(TOK_PROXY, cached["tokens"])
                self.assertTrue(any("version=124" in r[0] for r in requests))  # после 200 ждём новую версию
                self.assertTrue(all(a == "Bearer node-secret" for _r, a in requests))
                self.assertGreaterEqual(srv.counters["policy_errors"], 1)  # первый ответ был 500

                # активность: запрос от proxy-пользователя с нового IP -> немедленный ACL
                ident = srv.identify_token(TOK_PROXY, "198.51.100.77")
                srv.tracker.record(ident, time.time())
                self.assertTrue(srv.tracker.acl_event.is_set())
                await srv.flush_activity()
                self.assertEqual(len(posts), 1)
                p = posts[0]
                self.assertEqual(p["node"], "pro-dns")
                self.assertEqual(p["acl"], [{"ip": "198.51.100.77", "token": TOK_PROXY, "user_id": "u-proxy"}])
                self.assertEqual(p["activity"][0]["queries"], 1)
                self.assertEqual(len(p["activity"][0]["ip_hash"]), 16)
                self.assertEqual(p["health"]["policy_version"], 124)
                self.assertEqual([w["ip"] for w in p["health"]["workers"]], [W1, W2, W3])
                self.assertEqual(srv.counters["activity_posts"], 1)
                self.assertFalse(srv.tracker.has_pending())

                # повторная загрузка кеша при старте
                srv2 = make_server(self.tmp, ["--policy-cache", str(cache)])
                self.assertEqual(srv2.policy.version, 7)  # --policy-file имеет приоритет
                args3 = pro_dns.parse_args(["--no-cp", "--policy-map", str(Path(self.tmp) / "pro-policy-map.json"),
                                            "--policy-cache", str(cache), "--health-out", "", "--doh-listen", "", "--listen-ip", ""])
                srv3 = pro_dns.build_server(args3)
                self.assertEqual((srv3.policy.version, srv3.policy.source), (124, "cache"))
            finally:
                srv.stop_event.set()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await asyncio.sleep(0.1)  # дать обработчикам фейкового CP закрыть сокеты
                cp_srv.close()
                await cp_srv.wait_closed()
        asyncio.run(run())

    def test_activity_post_failure_requeues(self):
        async def run():
            port = tu.free_port()
            srv = make_server(self.tmp, ["--cp-origin", "http://127.0.0.1:%d" % port, "--node-secret", "x", "--cp-timeout", "0.5"])
            srv.cp = pro_dns.ControlPlane(srv.args.cp_origin, "x", timeout=0.5)
            srv.tracker.attach_loop()
            srv.tracker.record(srv.identify_token(TOK_PROXY, "198.51.100.1"), time.time())
            await srv.flush_activity()
            self.assertEqual(srv.counters["activity_post_errors"], 1)
            self.assertEqual(len(srv.tracker.pending_acl), 1)
            self.assertTrue(srv.tracker.acl_event.is_set())
        asyncio.run(run())


class LiveServerTests(unittest.TestCase):
    """Реальные слушатели UDP/TCP/DoT/DoH на 127.0.0.1 в фоновом цикле asyncio;
    клиенты — блокирующие сокеты из основного потока."""

    @classmethod
    def setUpClass(cls):
        _quiet()
        cls.tmp = tu.tmpdir()
        cls.has_openssl = tu.openssl_available()
        if cls.has_openssl:
            cls.cert, cls.key = tu.gen_self_signed(cls.tmp, PRO_DOMAIN)
        cls.dns_port = tu.free_port(socket.SOCK_DGRAM)
        cls.dot_port = tu.free_port()
        cls.doh_port = tu.free_port()
        cls.loop = asyncio.new_event_loop()
        cls.thread = threading.Thread(target=cls.loop.run_forever, daemon=True)
        cls.thread.start()

        async def boot():
            up = await tu.FakeUpstream().start()
            extra = ["--listen-ip", "127.0.0.1", "--port", str(cls.dns_port), "--dot-port", str(cls.dot_port),
                     "--doh-listen", "127.0.0.1:%d" % cls.doh_port, "--tcp-idle-timeout", "2"]
            if cls.has_openssl:
                extra += ["--cert", cls.cert, "--key", cls.key]
            else:
                extra += ["--cert", "/nonexistent/c.pem", "--key", "/nonexistent/k.pem"]
            srv = make_server(cls.tmp, extra, upstream_port=up.port)
            # пробы воркеров не должны ходить в сеть: подменяем
            async def ok_probe(*_a, **_k):
                return True, 1.0, None
            pro_dns.healthcheck.probe_tls_sni = ok_probe
            pro_dns.healthcheck.probe_http_healthz = ok_probe
            await srv.start()
            return up, srv

        cls.up, cls.srv = asyncio.run_coroutine_threadsafe(boot(), cls.loop).result(timeout=10)

    @classmethod
    def tearDownClass(cls):
        async def down():
            await cls.srv.shutdown()
            await cls.up.stop()
        asyncio.run_coroutine_threadsafe(down(), cls.loop).result(timeout=10)
        cls.loop.call_soon_threadsafe(cls.loop.stop)
        cls.thread.join(timeout=5)
        cls.loop.close()

    def _in_loop(self, fn, *a):
        fut = asyncio.run_coroutine_threadsafe(_call(fn, *a), self.loop)
        return fut.result(timeout=5)

    def _set_ips(self, ips):
        pol = pro_dns.Policy.from_dict(dict(POLICY, version=self.srv.policy.version + 1, ips=ips))
        self._in_loop(self.srv.apply_policy, pol, False)

    def _udp(self, wire):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(3.0)
        try:
            s.sendto(wire, ("127.0.0.1", self.dns_port))
            return s.recv(4096)
        finally:
            s.close()

    def _tls_client(self, server_hostname, session=None, ctx=None):
        if ctx is None:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection(("127.0.0.1", self.dot_port), timeout=3.0)
        kwargs = {"server_hostname": server_hostname} if server_hostname else {}
        if session is not None:
            kwargs["session"] = session
        return ctx.wrap_socket(raw, **kwargs)

    @staticmethod
    def _recv_frame(sock):
        hdr = b""
        while len(hdr) < 2:
            chunk = sock.recv(2 - len(hdr))
            if not chunk:
                return None
            hdr += chunk
        (ln,) = struct.unpack("!H", hdr)
        body = b""
        while len(body) < ln:
            chunk = sock.recv(ln - len(body))
            if not chunk:
                return None
            body += chunk
        return body

    def test_udp_identity_by_source_ip(self):
        self._set_ips({})
        r = self._udp(tu.make_query("claude.ai", 1, qid=0x0A01))
        self.assertEqual((tu.parse_header(r)["id"], tu.parse_header(r)["rcode"]), (0x0A01, 5))
        self._set_ips({"127.0.0.1": {"user_id": "u-local", "mode": "proxy", "disabled_categories": []}})
        r = self._udp(tu.make_query("claude.ai", 1, qid=0x0A02))
        self.assertEqual(tu.parse_header(r)["rcode"], 0)
        self.assertIn(tu.a_answers(r)[0], (W1, W2, W3))
        r = self._udp(tu.make_query("example.com", 1))
        self.assertEqual(tu.a_answers(r), [tu.UPSTREAM_A])
        # TC от upstream по UDP пробрасывается клиенту как есть (без TCP-fallback)
        r = self._udp(tu.make_query("big.example.com", 1))
        self.assertTrue(tu.parse_header(r)["tc"])
        # мусор короче заголовка молча игнорируется; битый вопрос -> FORMERR
        r = self._udp(struct.pack("!HHHHHH", 9, 0, 1, 0, 0, 0) + b"\x09ab")
        self.assertEqual(tu.parse_header(r)["rcode"], 1)

    def test_tcp_pipelining_out_of_order(self):
        self._set_ips({"127.0.0.1": {"user_id": "u-local", "mode": "proxy", "disabled_categories": []}})
        s = socket.create_connection(("127.0.0.1", self.dns_port), timeout=3.0)
        try:
            queries = [tu.make_query("claude.ai", 1, qid=1), tu.make_query("big.example.com", 1, qid=2),
                       tu.make_query("example.com", 1, qid=3)]
            s.sendall(b"".join(dnscommon.frame_tcp(q) for q in queries))
            got = {}
            for _ in range(3):
                r = self._recv_frame(s)
                self.assertIsNotNone(r)
                got[tu.parse_header(r)["id"]] = r
            self.assertEqual(set(got), {1, 2, 3})
            self.assertIn(tu.a_answers(got[1])[0], (W1, W2, W3))
            self.assertFalse(tu.parse_header(got[2])["tc"])  # TC -> fallback по TCP к upstream
            self.assertEqual(tu.a_answers(got[2]), [tu.UPSTREAM_A])
            # соединение живо для следующего запроса
            s.sendall(dnscommon.frame_tcp(tu.make_query("claude.ai", 28, qid=4)))
            r = self._recv_frame(s)
            self.assertEqual((tu.parse_header(r)["id"], tu.parse_header(r)["an"]), (4, 0))
        finally:
            s.close()

    def test_tcp_unknown_client_refused_and_closed(self):
        self._set_ips({})
        s = socket.create_connection(("127.0.0.1", self.dns_port), timeout=3.0)
        try:
            s.sendall(dnscommon.frame_tcp(tu.make_query("claude.ai", 1, qid=77)))
            r = self._recv_frame(s)
            self.assertEqual(tu.parse_header(r)["rcode"], 5)
            self.assertEqual(s.recv(10), b"")  # сервер закрыл соединение
        finally:
            s.close()

    def test_dot_token_from_sni_and_session_resumption(self):
        if not self.has_openssl:
            self.skipTest("openssl CLI недоступен — сертификат для DoT не сгенерировать")
        sni = "%s.%s" % (TOK_PROXY, PRO_DOMAIN)
        # Общий клиентский контекст: сессия возобновляется только в рамках одного SSLContext
        client_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client_ctx.check_hostname = False
        client_ctx.verify_mode = ssl.CERT_NONE
        c1 = self._tls_client(sni, ctx=client_ctx)
        try:
            c1.sendall(dnscommon.frame_tcp(tu.make_query("claude.ai", 1, qid=11)))
            r = self._recv_frame(c1)
            self.assertEqual(tu.parse_header(r)["id"], 11)
            self.assertIn(tu.a_answers(r)[0], (W1, W2, W3))
            # NODATA для HTTPS-записи
            c1.sendall(dnscommon.frame_tcp(tu.make_query("claude.ai", 65, qid=12)))
            r = self._recv_frame(c1)
            self.assertEqual((tu.parse_header(r)["rcode"], tu.parse_header(r)["an"]), (0, 0))
            session = c1.session
        finally:
            c1.close()
        before = self.srv.counters["dot"]
        try:
            c2 = self._tls_client(sni, session=session, ctx=client_ctx)
        except (ssl.SSLError, ValueError) as exc:
            self.skipTest("TLS session resumption недоступно в этой сборке Python: %s" % exc)
        try:
            if not c2.session_reused:
                self.skipTest("сервер не возобновил TLS-сессию в этой сборке OpenSSL/LibreSSL")
            c2.sendall(dnscommon.frame_tcp(tu.make_query("anthropic.com", 1, qid=13)))
            r = self._recv_frame(c2)
            self.assertEqual(tu.parse_header(r)["id"], 13)
            self.assertIn(tu.a_answers(r)[0], (W1, W2, W3))  # токен виден и на возобновлённой сессии
        finally:
            c2.close()
        self.assertEqual(self.srv.counters["dot"], before + 1)
        self.assertEqual(self.srv.counters["dot_no_token"], 0)

    def test_dot_without_sni_fails_closed(self):
        if not self.has_openssl:
            self.skipTest("openssl CLI недоступен")
        c = self._tls_client(None)
        try:
            c.sendall(dnscommon.frame_tcp(tu.make_query("claude.ai", 1, qid=21)))
            r = self._recv_frame(c)
            if r is not None:
                self.assertEqual(tu.parse_header(r)["rcode"], 5)
                self.assertEqual(c.recv(10), b"")
        except (ConnectionError, ssl.SSLError):
            pass  # соединение закрыто — тоже fail closed
        finally:
            c.close()
        self.assertGreaterEqual(self.srv.counters["dot_no_token"], 1)
        # чужой домен в SNI и неизвестный токен — тоже REFUSED
        for sni in ("%s.evil.test" % TOK_PROXY, "%s.%s" % (TOK_UNKNOWN, PRO_DOMAIN), PRO_DOMAIN):
            c = self._tls_client(sni)
            try:
                c.sendall(dnscommon.frame_tcp(tu.make_query("claude.ai", 1, qid=22)))
                r = self._recv_frame(c)
                self.assertIsNotNone(r)
                self.assertEqual(tu.parse_header(r)["rcode"], 5)
            finally:
                c.close()

    def test_dot_deny_and_plain_modes(self):
        if not self.has_openssl:
            self.skipTest("openssl CLI недоступен")
        c = self._tls_client("%s.%s" % (TOK_DENY, PRO_DOMAIN))
        try:
            c.sendall(dnscommon.frame_tcp(tu.make_query("example.com", 1, qid=31)))
            self.assertEqual(tu.parse_header(self._recv_frame(c))["rcode"], 5)
        finally:
            c.close()
        c = self._tls_client("%s.%s" % (TOK_PLAIN, PRO_DOMAIN))
        try:
            c.sendall(dnscommon.frame_tcp(tu.make_query("claude.ai", 1, qid=32)))
            r = self._recv_frame(c)
            self.assertEqual(tu.a_answers(r), [tu.UPSTREAM_A])  # plain: без подмены
        finally:
            c.close()

    def test_tls_reload_without_restart(self):
        if not self.has_openssl:
            self.skipTest("openssl CLI недоступен")
        sni = "%s.%s" % (TOK_PROXY, PRO_DOMAIN)
        c = self._tls_client(sni)
        old_cert = c.getpeercert(binary_form=True)
        c.close()
        new_cert, new_key = tu.gen_self_signed(self.tmp, "renewed-" + PRO_DOMAIN)
        self.srv.args.cert, self.srv.args.key = new_cert, new_key
        self._in_loop(self.srv.reload_tls)
        c = self._tls_client(sni)
        try:
            self.assertNotEqual(c.getpeercert(binary_form=True), old_cert)
            c.sendall(dnscommon.frame_tcp(tu.make_query("claude.ai", 1, qid=41)))
            self.assertIn(tu.a_answers(self._recv_frame(c))[0], (W1, W2, W3))
        finally:
            c.close()
        # битый путь к сертификату — остаёмся на предыдущем
        self.srv.args.cert = "/nonexistent.pem"
        self._in_loop(self.srv.reload_tls)
        c = self._tls_client(sni)
        c.close()
        self.srv.args.cert, self.srv.args.key = self.cert, self.key
        self._in_loop(self.srv.reload_tls)

    def _http(self, method, path, headers=None, body=None):
        s = socket.create_connection(("127.0.0.1", self.doh_port), timeout=3.0)
        try:
            hdrs = {"Host": PRO_DOMAIN, "Connection": "close"}
            hdrs.update(headers or {})
            if body:
                hdrs["Content-Length"] = str(len(body))
            req = "%s %s HTTP/1.1\r\n" % (method, path) + "".join("%s: %s\r\n" % kv for kv in hdrs.items()) + "\r\n"
            s.sendall(req.encode("latin-1") + (body or b""))
            raw = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                raw += chunk
        finally:
            s.close()
        head, _sep, rbody = raw.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        status = int(lines[0].split(" ")[1])
        rh = dict((k.strip().lower(), v.strip()) for k, v in (ln.split(":", 1) for ln in lines[1:] if ":" in ln))
        return status, rh, rbody

    def test_doh_requires_token(self):
        q = tu.make_query("claude.ai", 1, qid=51)
        path = "/dns-query?dns=" + dnscommon.encode_base64url_dns(q)
        status, _h, _b = self._http("GET", path)
        self.assertEqual(status, 403)
        status, _h, _b = self._http("GET", path, {"X-Pereval-Token": TOK_UNKNOWN})
        self.assertEqual(status, 403)
        status, _h, _b = self._http("GET", path, {"X-Pereval-Token": "BAD"})
        self.assertEqual(status, 403)
        status, h, b = self._http("GET", path, {"X-Pereval-Token": TOK_PROXY, "X-Real-IP": "198.51.100.200"})
        self.assertEqual(status, 200)
        self.assertEqual(h["content-type"], dnscommon.DNS_MEDIA_TYPE)
        self.assertEqual(h["cache-control"], "max-age=60")
        self.assertEqual(tu.parse_header(b)["id"], 51)
        self.assertIn(tu.a_answers(b)[0], (W1, W2, W3))
        # ACL для X-Real-IP поставлен в очередь (CP нет — просто проверяем учёт)
        self.assertIn((TOK_PROXY, "198.51.100.200"), self.srv.tracker.known_ips)
        status, _h, b = self._http("POST", "/dns-query", {"X-Pereval-Token": TOK_DENY, "Content-Type": dnscommon.DNS_MEDIA_TYPE}, q)
        self.assertEqual(status, 200)
        self.assertEqual(tu.parse_header(b)["rcode"], 5)  # deny -> REFUSED внутри HTTP 200
        status, _h, b = self._http("GET", "/healthz")
        self.assertEqual((status, b), (200, b"ok\n"))
        status, h, b = self._http("GET", "/metrics.json")
        self.assertEqual(status, 200)
        m = json.loads(b.decode("utf-8"))
        for key in ("uptime_s", "qps_1m", "queries_total", "by_transport", "by_mode", "by_decision",
                    "active_tokens_5m", "policy", "workers", "activity"):
            self.assertIn(key, m)
        self.assertGreaterEqual(m["doh_forbidden"], 3)
        self.assertEqual(m["workers"]["total"], 3)
        status, _h, _b = self._http("GET", "/nope")
        self.assertEqual(status, 404)


async def _call(fn, *a):
    return fn(*a)


if __name__ == "__main__":
    unittest.main()
