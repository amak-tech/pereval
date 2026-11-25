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

    def test_check_beacon_decisions_pro_and_free(self):
        pm = dict(POLICY_MAP, check_domain="check.pereval.test", check_ip="198.51.100.53")
        srv = make_server(self.tmp, policy_map=pm)

        # proxy -> A синтезируется на check_ip, AAAA/HTTPS/SVCB -> NODATA, TXT -> forward
        proxy_id = srv.identify_token(TOK_PROXY, "1.1.1.1")
        self.assertEqual(srv.decide(self.q("check.pereval.test"), proxy_id), (pro_dns.D_SYNTH_A, "198.51.100.53"))
        self.assertEqual(srv.decide(self.q("CHECK.PEREVAL.TEST."), proxy_id), (pro_dns.D_SYNTH_A, "198.51.100.53"))
        for qt in (dnscommon.QTYPE_AAAA, dnscommon.QTYPE_HTTPS, dnscommon.QTYPE_SVCB):
            self.assertEqual(srv.decide(self.q("check.pereval.test", qt), proxy_id), (pro_dns.D_NODATA, "check.pereval.test"))
        self.assertEqual(
            srv.decide(self.q("check.pereval.test", dnscommon.QTYPE_TXT), proxy_id),
            (pro_dns.D_FORWARD, "qtype"),
        )
        # поддомен маячка не перехватывается
        self.assertEqual(srv.decide(self.q("sub.check.pereval.test"), proxy_id), (pro_dns.D_FORWARD, "nomatch"))

        # plain -> форвард в публичный DNS (клиент попадёт на CP -> tier: none)
        plain_id = srv.identify_token(TOK_PLAIN, "1.1.1.1")
        self.assertEqual(srv.decide(self.q("check.pereval.test"), plain_id, now=2000.0), (pro_dns.D_FORWARD, "plain"))

        # deny / unknown -> REFUSED
        deny_id = srv.identify_token(TOK_DENY, "1.1.1.1")
        self.assertEqual(srv.decide(self.q("check.pereval.test"), deny_id), (pro_dns.D_REFUSED, "deny"))
        unk_id = srv.identify_token(TOK_UNKNOWN, "1.1.1.1")
        self.assertEqual(srv.decide(self.q("check.pereval.test"), unk_id), (pro_dns.D_REFUSED, "unknown"))

        # --tier free: любой клиент получает check_ip для A и NODATA для AAAA
        pm_free = dict(POLICY_MAP, tier="free", check_domain="check.pereval.test", check_ip="153.80.200.170")
        srv_free = make_server(self.tmp, extra_argv=["--tier", "free"], policy_map=pm_free)
        free_id = srv_free.identify_ip("198.51.100.42")
        self.assertEqual(srv_free.decide(self.q("check.pereval.test"), free_id), (pro_dns.D_SYNTH_A, "153.80.200.170"))
        self.assertEqual(
            srv_free.decide(self.q("check.pereval.test", dnscommon.QTYPE_AAAA), free_id),
            (pro_dns.D_NODATA, "check.pereval.test"),
        )

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


class FreeTierAndQuotaTests(unittest.TestCase):
    """Тесты режима --tier free (Do53/DoT/DoH без токенов, привязка по /24, passthrough, DnsCache)
    и квотирования max_clients с переливом и откатом в plain DNS."""

    def setUp(self):
        _quiet()
        self.tmp = tu.tmpdir()

    def test_pro_sticky_users_and_quota_shedding(self):
        pm = dict(
            POLICY_MAP,
            max_clients=2,
            pools={"default": {"max_clients": 1}, "ai": {"fallback": "default", "max_clients": 1}},
            workers=[
                {"ip": W1, "name": "w1", "pools": ["ai"]},
                {"ip": W2, "name": "w2", "pools": ["ai"]},
                {"ip": W3, "name": "w3", "pools": ["default"]},
            ],
            passthrough=["gosuslugi.ru"],
        )
        ips = {
            "198.51.100.%d" % i: {"user_id": "user-%d" % i, "mode": "proxy", "disabled_categories": []}
            for i in range(1, 10)
        }
        pol = dict(POLICY, ips=ips)
        srv = make_server(self.tmp, policy=pol, policy_map=pm)
        q_claude = dnscommon.parse_question(tu.make_query("claude.ai", 1))
        q_chatgpt = dnscommon.parse_question(tu.make_query("chatgpt.com", 1))
        q_pass = dnscommon.parse_question(tu.make_query("lk.gosuslugi.ru", 1))

        u1 = srv.identify_ip("198.51.100.1")
        u2 = srv.identify_ip("198.51.100.2")
        u3 = srv.identify_ip("198.51.100.3")
        u4 = srv.identify_ip("198.51.100.4")

        # Passthrough всегда уходит в D_FORWARD
        self.assertEqual(srv.decide(q_pass, u1, now=100.0), (pro_dns.D_FORWARD, "passthrough"))

        # u1 и u2 занимают оба слота пула ai (W1 и W2, по 1 слоту на ноду)
        act1, ip1 = srv.decide(q_claude, u1, now=100.0)
        act2, ip2 = srv.decide(q_claude, u2, now=100.0)
        self.assertEqual((act1, act2), (pro_dns.D_SYNTH_A, pro_dns.D_SYNTH_A))
        self.assertEqual({ip1, ip2}, {W1, W2})
        # Все сервисы одного пула для u1 идут через тот же воркер
        self.assertEqual(srv.decide(q_chatgpt, u1, now=101.0), (pro_dns.D_SYNTH_A, ip1))

        # u3 переливается в fallback-пул default (W3, лимит 1)
        self.assertEqual(srv.decide(q_claude, u3, now=102.0), (pro_dns.D_SYNTH_A, W3))

        # u4: все слоты в ai и default заняты -> откат в plain DNS (D_FORWARD, over_quota)
        self.assertEqual(srv.decide(q_claude, u4, now=103.0), (pro_dns.D_FORWARD, "over_quota"))
        # При этом u1 и u2 продолжают обслуживаться своими нодами
        self.assertEqual(srv.decide(q_claude, u1, now=104.0), (pro_dns.D_SYNTH_A, ip1))
        self.assertEqual(srv.decide(q_claude, u2, now=104.0), (pro_dns.D_SYNTH_A, ip2))

    def test_free_tier_do53_dot_doh_and_cache(self):
        async def run():
            up = await tu.FakeUpstream().start()
            pm = {
                "tier": "free",
                "domain": "free.pereval.top",
                "free_domains": ["free.pereval.top", "pereval.portbuddy.tech"],
                "dns_ip": "127.0.0.1",
                "primary": "127.0.0.1",
                "probe_sni": "claude.ai",
                "max_clients": 60,
                "pools": {"default": {}, "ai": {"fallback": "default", "max_clients": 60}},
                "workers": [
                    {"ip": W1, "name": "free-ai-1", "pools": ["ai", "default"]},
                    {"ip": W2, "name": "free-ai-2", "pools": ["ai", "default"]},
                ],
                "categories": [{"id": "ai", "name": "AI", "tier": "free", "pool": "ai"}],
                "passthrough": ["gosuslugi.ru"],
                "domains": {
                    "claude.ai": {"service": "Anthropic / Claude", "category_id": "ai", "tier": "free", "pool": "ai"},
                    "chatgpt.com": {"service": "OpenAI", "category_id": "ai", "tier": "free", "pool": "ai"},
                },
            }
            pm_path = _write_json(Path(self.tmp) / "free-policy-map.json", pm)
            doh_port = tu.free_port()
            argv = [
                "--tier", "free",
                "--policy-map", pm_path,
                "--policy-cache", "",
                "--health-out", "",
                "--health-interval", "3600",
                "--listen-ip", "",
                "--doh-listen", "127.0.0.1:%d" % doh_port,
                "--upstream", "127.0.0.1:%d" % up.port,
            ]
            args = pro_dns.parse_args(argv)
            srv = pro_dns.build_server(args)
            await srv.start()
            try:
                # 1. Распределение разных IP /32 внутри одной подсети /24 в режиме Free
                ips_picked = {}
                for host_i in range(1, 31):
                    client_ip = "198.51.100.%d" % host_i
                    ident = srv.identify_ip(client_ip)
                    self.assertTrue(ident.known)
                    self.assertEqual(ident.key, "%s/32" % client_ip)
                    r = await srv.resolve(tu.make_query("claude.ai", 1), ident, "udp")
                    ans = tu.a_answers(r)[0]
                    ips_picked[client_ip] = ans
                    # Другой сервис того же пула для того же клиента даёт тот же IP ноды
                    r_gpt = await srv.resolve(tu.make_query("chatgpt.com", 1), ident, "udp")
                    self.assertEqual(tu.a_answers(r_gpt)[0], ans)
                self.assertEqual(set(ips_picked.values()), {W1, W2})

                # IPv4-mapped IPv6 нормализуется к /32, IPv6 — к /64
                self.assertEqual(srv.identify_ip("::ffff:198.51.100.5").key, "198.51.100.5/32")
                self.assertEqual(srv.identify_ip("2001:db8:abcd:1234::1").key, "2001:db8:abcd:1234::/64")
                self.assertEqual(srv.identify_ip("2001:db8:abcd:1234::2").key, "2001:db8:abcd:1234::/64")
                self.assertEqual(srv.identify_ip("2001:db8:abcd:1235::1").key, "2001:db8:abcd:1235::/64")

                # 2. DoH без токена с X-Real-IP + NODATA на AAAA + passthrough + DnsCache
                q_a = tu.make_query("claude.ai", 1, qid=0x301)
                r = await dnscommon.http_request(
                    "http://127.0.0.1:%d/dns-query?dns=%s" % (doh_port, dnscommon.encode_base64url_dns(q_a)),
                    headers={"X-Real-IP": "203.0.113.15"},
                )
                self.assertEqual(r.status, 200)
                self.assertIn(tu.a_answers(r.body)[0], (W1, W2))

                q_aaaa = tu.make_query("claude.ai", 28, qid=0x302)
                r_aaaa = await dnscommon.http_request(
                    "http://127.0.0.1:%d/dns-query?dns=%s" % (doh_port, dnscommon.encode_base64url_dns(q_aaaa)),
                    headers={"X-Real-IP": "203.0.113.15"},
                )
                self.assertEqual((tu.parse_header(r_aaaa.body)["rcode"], tu.parse_header(r_aaaa.body)["an"]), (0, 0))

                # Passthrough и внешние домены кешируются во встроенном DnsCache
                self.assertEqual(up.udp_queries, 0)
                q_ext = tu.make_query("ya.ru", 1, qid=0x303)
                r_ext1 = await srv.resolve(q_ext, srv.identify_ip("203.0.113.15"), "udp")
                self.assertEqual(tu.a_answers(r_ext1), [tu.UPSTREAM_A])
                self.assertEqual(up.udp_queries, 1)

                q_ext2 = tu.make_query("ya.ru", 1, qid=0x304)
                r_ext2 = await srv.resolve(q_ext2, srv.identify_ip("203.0.113.99"), "udp")
                self.assertEqual(tu.parse_header(r_ext2)["id"], 0x304)
                self.assertEqual(tu.a_answers(r_ext2), [tu.UPSTREAM_A])
                # Второй запрос отдан из DnsCache без обращения к апстриму
                self.assertEqual(up.udp_queries, 1)
                self.assertEqual(srv.cache.hits, 1)

                # 3. Автоматический failover при падении одного воркера и восстановление
                w1_client = next(ip for ip, w in ips_picked.items() if w == W1)
                srv.health.update(W1, W1, False, 0.0, "down", 1.0)
                srv.health.update(W1, W1, False, 0.0, "down", 2.0)
                srv.recompute_routing()
                self.assertFalse(srv.fail_open)
                r_failover = await srv.resolve(tu.make_query("claude.ai", 1), srv.identify_ip(w1_client), "udp")
                self.assertEqual(tu.a_answers(r_failover), [W2])

                # После восстановления W1 клиент снова получает W1
                srv.health.update(W1, W1, True, 5.0, "ok", 3.0)
                srv.health.update(W1, W1, True, 5.0, "ok", 4.0)
                srv.recompute_routing()
                r_recovered = await srv.resolve(tu.make_query("claude.ai", 1), srv.identify_ip(w1_client), "udp")
                self.assertEqual(tu.a_answers(r_recovered), [W1])

                # 4. При падении всех воркеров (fail_open) во Free выдаётся IP primary
                for w_ip in (W1, W2):
                    srv.health.update(w_ip, w_ip, False, 0.0, "down", 5.0)
                    srv.health.update(w_ip, w_ip, False, 0.0, "down", 6.0)
                srv.recompute_routing()
                self.assertTrue(srv.fail_open)
                r_fo = await srv.resolve(tu.make_query("claude.ai", 1), srv.identify_ip("198.51.99.1"), "udp")
                self.assertEqual(tu.a_answers(r_fo), ["127.0.0.1"])
            finally:
                await srv.shutdown()
                await up.stop()
        asyncio.run(run())

    def test_excluded_subdomain_bypasses_parent_service_proxy_and_reload_clears_cache(self):
        async def run():
            up = await tu.FakeUpstream().start()
            pm = dict(
                POLICY_MAP,
                passthrough=["gosuslugi.ru", "stun.console.example"],
                domains=dict(
                    POLICY_MAP["domains"],
                    **{"console.example": {"service": "Console", "category_id": "work", "tier": "pro", "pool": "default"}},
                ),
            )
            pm_path = _write_json(Path(self.tmp) / "pro-pm.json", pm)
            pf_path = _write_json(Path(self.tmp) / "pol.json", POLICY)
            args = pro_dns.parse_args([
                "--no-cp", "--policy-map", pm_path, "--policy-file", pf_path,
                "--policy-cache", "", "--health-out", "", "--health-interval", "3600",
                "--listen-ip", "", "--doh-listen", "", "--upstream", "127.0.0.1:%d" % up.port,
            ])
            srv = pro_dns.build_server(args)
            await srv.upstream.start()
            try:
                ident = srv.identify_ip("198.51.100.7")
                # Обычные поддомены родителя проксируются через воркер, AAAA режется в NODATA
                r_api = await srv.resolve(tu.make_query("api.console.example", 1), ident, "udp")
                self.assertEqual(tu.a_answers(r_api), [W1])
                r_api_aaaa = await srv.resolve(tu.make_query("api.console.example", 28), ident, "udp")
                self.assertEqual((tu.parse_header(r_api_aaaa)["rcode"], tu.parse_header(r_api_aaaa)["an"]), (0, 0))

                # Исключённый STUN-поддомен родителя форвардится напрямую в upstream (включая поддомены 4-го уровня)
                r_stun = await srv.resolve(tu.make_query("ru.np.stun.console.example", 1), ident, "udp")
                self.assertEqual(tu.a_answers(r_stun), [tu.UPSTREAM_A])
                self.assertGreaterEqual(len(srv.cache), 1)

                # При reload_policy_map кэш ответов очищается и подхватывается новый список исключений
                srv.reload_policy_map()
                self.assertEqual(len(srv.cache), 0)
            finally:
                srv.upstream.close()
                await up.stop()
        asyncio.run(run())

    def test_free_tier_rate_limit_is_per_ip_not_per_subnet(self):
        pm = dict(
            POLICY_MAP,
            tier="free",
            domain="free.test",
            primary="127.0.0.1",
            workers=[
                {"ip": W1, "name": "w1", "pools": ["default", "ai"]},
                {"ip": W2, "name": "w2", "pools": ["default", "ai"]},
            ],
        )
        pm_path = _write_json(Path(self.tmp) / "free-rl-pm.json", pm)
        args = pro_dns.parse_args([
            "--tier", "free", "--policy-map", pm_path, "--policy-cache", "",
            "--health-out", "", "--health-interval", "3600", "--listen-ip", "",
            "--doh-listen", "", "--default-qps", "2",
        ])
        srv = pro_dns.build_server(args)
        t = 1_700_000_000.0
        q = dnscommon.parse_question(tu.make_query("claude.ai", 1))
        c1 = srv.identify_ip("198.51.100.10")
        c2 = srv.identify_ip("198.51.100.11")
        # Клиенты в одной /24 имеют независимые /32 ключи и независимый rate-limit
        self.assertEqual(c1.key, "198.51.100.10/32")
        self.assertEqual(c2.key, "198.51.100.11/32")

        # qps_limit=2, burst x2 = 4: исчерпываем бакет для .10
        r1 = [srv.decide(q, c1, now=t) for _ in range(5)]
        self.assertEqual([a for a, _ in r1[:4]], [pro_dns.D_SYNTH_A] * 4)
        self.assertEqual(r1[4][0], pro_dns.D_RATELIMIT)

        # Клиент .11 из той же /24 не затронут и получает здоровый воркер пула
        act2, ip2 = srv.decide(q, c2, now=t)
        self.assertEqual(act2, pro_dns.D_SYNTH_A)
        self.assertIn(ip2, (W1, W2))

    def test_pro_new_ip_waits_for_acl_sync_before_synth_a(self):
        async def run():
            posts = []
            fail_posts = {"flag": False}

            async def handle_cp(reader, writer):
                try:
                    raw = b""
                    while b"\r\n\r\n" not in raw:
                        chunk = await asyncio.wait_for(reader.read(4096), timeout=2.0)
                        if not chunk:
                            return
                        raw += chunk
                    head, rest = raw.split(b"\r\n\r\n", 1)
                    lines = head.decode("latin1").split("\r\n")
                    method, path, _ = lines[0].split(" ", 2)
                    clen = 0
                    for ln in lines[1:]:
                        if ln.lower().startswith("content-length:"):
                            clen = int(ln.split(":", 1)[1].strip())
                    while len(rest) < clen:
                        rest += await asyncio.wait_for(reader.read(4096), timeout=2.0)
                    if path.startswith("/api/internal/v1/policy"):
                        body = json.dumps(POLICY).encode("utf-8")
                        writer.write(b"HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        await writer.drain()
                    elif path == "/api/internal/v1/dns/activity":
                        posts.append(json.loads(rest[:clen].decode("utf-8")))
                        if fail_posts["flag"]:
                            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        else:
                            await asyncio.sleep(0.05)
                            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                        await writer.drain()
                finally:
                    writer.close()

            cp_port = tu.free_port()
            cp_srv = await asyncio.start_server(handle_cp, "127.0.0.1", cp_port)
            up = await tu.FakeUpstream().start()
            pm_path = _write_json(Path(self.tmp) / "acl-sync-pm.json", POLICY_MAP)
            pf_path = _write_json(Path(self.tmp) / "acl-sync-pol.json", POLICY)
            args = pro_dns.parse_args([
                "--tier", "pro",
                "--policy-map", pm_path,
                "--policy-cache", pf_path,
                "--cp-origin", "http://127.0.0.1:%d" % cp_port,
                "--node-secret", "sec",
                "--health-out", "",
                "--health-interval", "3600",
                "--listen-ip", "",
                "--doh-listen", "",
                "--upstream", "127.0.0.1:%d" % up.port,
                "--acl-sync-timeout", "0.4",
                "--acl-sync-grace", "0.01",
            ])
            srv = pro_dns.build_server(args)
            await srv.start()
            try:
                # 1. Первый запрос с нового IP ждёт подтверждения ACL в CP до выдачи A-записи
                ident1 = srv.identify_token(TOK_PROXY, "198.51.100.77")
                resp1 = await srv.resolve(tu.make_query("claude.ai", 1), ident1, "doh")
                self.assertIn(tu.a_answers(resp1)[0], (W1, W2, W3))
                self.assertEqual(srv.counters["acl_sync_waits"], 1)
                self.assertEqual(srv.counters["acl_sync_timeouts"], 0)
                self.assertTrue(any(
                    any(e["ip"] == "198.51.100.77" for e in p.get("acl", []))
                    for p in posts
                ))

                # 2. Повторный запрос с уже подтверждённого IP проходит без ожидания
                resp2 = await srv.resolve(tu.make_query("chatgpt.com", 1), ident1, "doh")
                self.assertIn(tu.a_answers(resp2)[0], (W1, W2, W3))
                self.assertEqual(srv.counters["acl_sync_waits"], 1)

                # 3. При ошибке CP (502) новый IP не зависает, а отдаёт A-запись по таймауту
                fail_posts["flag"] = True
                srv.args.acl_sync_timeout = 0.1
                ident2 = srv.identify_token(TOK_PROXY, "198.51.100.88")
                resp3 = await srv.resolve(tu.make_query("claude.ai", 1), ident2, "doh")
                self.assertIn(tu.a_answers(resp3)[0], (W1, W2, W3))
                self.assertEqual(srv.counters["acl_sync_waits"], 2)
                self.assertEqual(srv.counters["acl_sync_timeouts"], 1)
            finally:
                await srv.shutdown()
                await up.stop()
                cp_srv.close()
                await cp_srv.wait_closed()
        asyncio.run(run())


async def _call(fn, *a):
    return fn(*a)


class ProRegionRoutingTests(unittest.TestCase):
    def setUp(self):
        _quiet()

    def test_region_routing_fallback_and_quota(self):
        import tempfile
        w_def_eu = "203.0.113.41"
        w_ai_eu = "203.0.113.42"
        w_ai_us = "203.0.113.43"
        pm = {
            "domain": PRO_DOMAIN,
            "dns_ip": "127.0.0.1",
            "probe_sni": "claude.ai",
            "pools": {
                "default": {"max_clients": 5},
                "ai": {"fallback": "default", "max_clients": 1},
            },
            "regions": {"eu": {"name": "Европа"}, "us": {"name": "США"}},
            "workers": [
                {"ip": w_def_eu, "name": "pro-worker-default-1", "region": "eu", "pools": ["default"]},
                {"ip": w_ai_eu, "name": "pro-worker-ai-1", "region": "eu", "pools": ["ai"]},
                {"ip": w_ai_us, "name": "pro-worker-ai-us-1", "region": "us", "pools": ["ai"]},
            ],
            "categories": [
                {"id": "ai", "name": "AI", "tier": "free", "pool": "ai"},
                {"id": "work", "name": "Work", "tier": "pro", "pool": "default"},
            ],
            "domains": {
                "claude.ai": {"service": "Anthropic / Claude", "category_id": "ai", "tier": "free", "pool": "ai"},
                "notion.so": {"service": "Notion", "category_id": "work", "tier": "pro", "pool": "default"},
            },
        }
        tok_us1 = "ususeroneususerone22"
        tok_us2 = "ususertwoususertwo23"
        tok_eu = "euusereuusereuuser24"
        tok_auto = "autouserautouserau25"
        pol = {
            "version": 12,
            "generated_at": "2026-11-23T12:00:00Z",
            "tokens": {
                tok_us1: {"user_id": "u-us-1", "mode": "proxy", "disabled_categories": [], "preferred_region": "us"},
                tok_us2: {"user_id": "u-us-2", "mode": "proxy", "disabled_categories": [], "preferred_region": "us"},
                tok_eu: {"user_id": "u-eu-1", "mode": "proxy", "disabled_categories": [], "preferred_region": "eu"},
                tok_auto: {"user_id": "u-auto", "mode": "proxy", "disabled_categories": []},
            },
            "ips": {},
            "workers": None,
        }
        # Round-trip Policy.from_dict -> to_dict сохраняет preferred_region
        parsed = pro_dns.Policy.from_dict(pol, source="file")
        dumped = parsed.to_dict()
        self.assertEqual(dumped["tokens"][tok_us1]["preferred_region"], "us")
        self.assertNotIn("preferred_region", dumped["tokens"][tok_auto])

        with tempfile.TemporaryDirectory() as tmp:
            srv = make_server(tmp, policy=pol, policy_map=pm)
            t = 1_700_000_000.0
            q_ai = dnscommon.parse_question(tu.make_query("claude.ai", 1))
            q_def = dnscommon.parse_question(tu.make_query("notion.so", 1))

            id_us1 = srv.identify_token(tok_us1, "198.51.100.1")
            id_us2 = srv.identify_token(tok_us2, "198.51.100.2")
            id_eu = srv.identify_token(tok_eu, "198.51.100.3")
            id_auto = srv.identify_token(tok_auto, "198.51.100.4")

            # US-пользователь: ai -> w_ai_us, default -> w_def_eu
            self.assertEqual(srv.decide(q_ai, id_us1, now=t), (pro_dns.D_SYNTH_A, w_ai_us))
            self.assertEqual(srv.decide(q_def, id_us1, now=t), (pro_dns.D_SYNTH_A, w_def_eu))

            # Второй US-пользователь: w_ai_us достиг max_clients=1 -> fallback на w_ai_eu (тот же пул)
            self.assertEqual(srv.decide(q_ai, id_us2, now=t), (pro_dns.D_SYNTH_A, w_ai_eu))

            # EU-пользователь: w_ai_eu тоже заполнен -> fallback на w_def_eu
            self.assertEqual(srv.decide(q_ai, id_eu, now=t), (pro_dns.D_SYNTH_A, w_def_eu))
            self.assertEqual(srv.decide(q_def, id_eu, now=t), (pro_dns.D_SYNTH_A, w_def_eu))

            # Сбросим квоту (окно > 300с) и проверим падение US-ноды
            t2 = t + 400.0
            self.assertEqual(srv.decide(q_ai, id_auto, now=t2)[0], pro_dns.D_SYNTH_A)
            self.assertIn(srv.decide(q_ai, id_auto, now=t2)[1], (w_ai_eu, w_ai_us))

            # Помечаем w_ai_us нездоровой
            t3 = t2 + 400.0
            srv.health.states[w_ai_us] = {"healthy": False, "fails": 3, "passes": 0}
            srv.recompute_routing()
            self.assertEqual(srv.decide(q_ai, id_us1, now=t3), (pro_dns.D_SYNTH_A, w_ai_eu))

            # Помечаем и w_ai_eu нездоровой -> откат на default/eu
            srv.health.states[w_ai_eu] = {"healthy": False, "fails": 3, "passes": 0}
            srv.recompute_routing()
            self.assertEqual(srv.decide(q_ai, id_us1, now=t3), (pro_dns.D_SYNTH_A, w_def_eu))

    def test_region_probe_timeout_and_hysteresis(self):
        import tempfile

        w_eu = "10.30.0.1"
        w_us = "10.30.0.2"
        pm = dict(POLICY_MAP)
        pm["regions"] = {
            "eu": {"name": "Европа"},
            "us": {"name": "США", "probe_timeout": 6.0, "fail_threshold": 4, "rise_threshold": 3},
        }
        pm["workers"] = [
            {"ip": w_eu, "name": "ai-eu", "weight": 1, "pools": ["ai", "default"], "region": "eu"},
            {"ip": w_us, "name": "ai-us", "weight": 1, "pools": ["ai"], "region": "us"},
        ]

        # Проверяем также helper в healthcheck.py
        self.assertEqual(
            pro_dns.healthcheck.worker_probe_params(pm["workers"][0], pm["regions"], 3.0, 2, 2),
            (3.0, 2, 2),
        )
        self.assertEqual(
            pro_dns.healthcheck.worker_probe_params(pm["workers"][1], pm["regions"], 3.0, 2, 2),
            (6.0, 4, 3),
        )

        with tempfile.TemporaryDirectory() as tmp:
            srv = make_server(tmp, ["--probe-timeout", "3.0", "--fail-threshold", "2", "--rise-threshold", "2"],
                              policy=POLICY, policy_map=pm)
            seen_timeouts = {}
            probe_ok_flag = {"ok": False}

            async def fake_tls(ip, _port, _sni, timeout, **_kw):
                seen_timeouts.setdefault(ip, []).append(("tls", timeout))
                return (True, 10.0, None) if probe_ok_flag["ok"] else (False, 10.0, "TimeoutError")

            async def fake_http(ip, _port, _host, timeout):
                seen_timeouts.setdefault(ip, []).append(("http", timeout))
                return (True, 10.0, None) if probe_ok_flag["ok"] else (False, 10.0, "TimeoutError")

            orig_tls = pro_dns.healthcheck.probe_tls_sni
            orig_http = pro_dns.healthcheck.probe_http_healthz
            pro_dns.healthcheck.probe_tls_sni = fake_tls
            pro_dns.healthcheck.probe_http_healthz = fake_http
            try:
                async def run():
                    # 1-я ошибка: оба UP
                    await srv.health_cycle()
                    self.assertTrue(srv.health.is_healthy(w_eu))
                    self.assertTrue(srv.health.is_healthy(w_us))
                    self.assertEqual(seen_timeouts[w_eu], [("tls", 3.0), ("http", 3.0)])
                    self.assertEqual(seen_timeouts[w_us], [("tls", 6.0), ("http", 6.0)])

                    # 2-я ошибка: eu -> DOWN (fail_threshold=2), us -> всё ещё UP (fail_threshold=4)
                    await srv.health_cycle()
                    self.assertFalse(srv.health.is_healthy(w_eu))
                    self.assertTrue(srv.health.is_healthy(w_us))

                    # 3-я ошибка: us -> всё ещё UP
                    await srv.health_cycle()
                    self.assertTrue(srv.health.is_healthy(w_us))

                    # 4-я ошибка: us -> DOWN
                    await srv.health_cycle()
                    self.assertFalse(srv.health.is_healthy(w_us))

                    # Восстановление: eu -> UP за 2 успеха, us -> UP за 3 успеха
                    probe_ok_flag["ok"] = True
                    await srv.health_cycle()
                    self.assertFalse(srv.health.is_healthy(w_eu))
                    self.assertFalse(srv.health.is_healthy(w_us))

                    await srv.health_cycle()
                    self.assertTrue(srv.health.is_healthy(w_eu))
                    self.assertFalse(srv.health.is_healthy(w_us))

                    await srv.health_cycle()
                    self.assertTrue(srv.health.is_healthy(w_us))

                    snap = srv.health_snapshot()
                    by_ip = {w["ip"]: w for w in snap["workers"]}
                    self.assertEqual(by_ip[w_us]["region"], "us")

                asyncio.run(run())
            finally:
                pro_dns.healthcheck.probe_tls_sni = orig_tls
                pro_dns.healthcheck.probe_http_healthz = orig_http


class ShutdownTests(unittest.TestCase):
    def setUp(self):
        _quiet()

    def test_shutdown_fast_with_open_keepalive_and_tcp_connections(self):
        import tempfile

        async def run():
            up = await tu.FakeUpstream().start()
            with tempfile.TemporaryDirectory() as tmp:
                dns_port = tu.free_port()
                doh_port = tu.free_port()
                pm_path = _write_json(Path(tmp) / "shutdown-pm.json", POLICY_MAP)
                args = pro_dns.parse_args([
                    "--tier", "free",
                    "--no-cp",
                    "--policy-map", pm_path,
                    "--health-out", "",
                    "--listen-ip", "127.0.0.1",
                    "--port", str(dns_port),
                    "--dot-port", "0",
                    "--doh-listen", "127.0.0.1:%d" % doh_port,
                    "--upstream", "127.0.0.1:%d" % up.port,
                    "--tcp-idle-timeout", "20.0",
                    "--health-interval", "60",
                ])
                srv = pro_dns.build_server(args)
                await srv.start()
                doh_r = doh_w = tcp_r = tcp_w = None
                try:
                    # 1. Открытое keep-alive HTTP/1.1 соединение (как пул nginx -> DoH)
                    doh_r, doh_w = await asyncio.open_connection("127.0.0.1", doh_port)
                    doh_w.write(b"GET /healthz HTTP/1.1\r\nHost: free.test\r\nConnection: keep-alive\r\n\r\n")
                    await doh_w.drain()
                    head = await asyncio.wait_for(doh_r.readuntil(b"\r\n\r\n"), timeout=2.0)
                    self.assertIn(b"200 OK", head)
                    body = await asyncio.wait_for(doh_r.readexactly(3), timeout=2.0)
                    self.assertEqual(body, b"ok\n")

                    # 2. Открытое TCP DNS-соединение, остающееся в простое (idle_timeout=20s)
                    tcp_r, tcp_w = await asyncio.open_connection("127.0.0.1", dns_port)
                    tcp_w.write(dnscommon.frame_tcp(tu.make_query("claude.ai", 1, qid=77)))
                    await tcp_w.drain()
                    resp = await dnscommon.read_tcp_message(tcp_r, timeout=2.0)
                    self.assertIsNotNone(resp)
                    self.assertIn(tu.a_answers(resp)[0], (W1, W2, W3))

                    # Даём обработчикам вернуться в idle-ожидание следующего запроса
                    await asyncio.sleep(0.05)

                    # Shutdown обязан завершиться быстро, не дожидаясь 20–30с таймаутов
                    t0 = time.monotonic()
                    await asyncio.wait_for(srv.shutdown(), timeout=2.0)
                    elapsed = time.monotonic() - t0
                    self.assertLess(elapsed, 1.0)
                finally:
                    for w in (doh_w, tcp_w):
                        if w is not None:
                            try:
                                w.close()
                            except Exception:
                                pass
                    await up.stop()

        asyncio.run(run())


class NginxFailoverSyncTests(unittest.TestCase):
    def setUp(self):
        _quiet()
        self.tmp = tu.tmpdir()

    def _free_pm(self):
        return {
            "tier": "free",
            "domain": "free.pereval.top",
            "free_domains": ["free.pereval.top"],
            "dns_ip": "153.80.200.170",
            "primary": "153.80.200.170",
            "probe_sni": "claude.ai",
            "pools": {"default": {}, "ai": {"fallback": "default"}},
            "workers": [
                {"ip": W1, "name": "free-ai-1", "pools": ["ai", "default"], "weight": 2},
                {"ip": W2, "name": "free-ai-2", "pools": ["ai"]},
            ],
            "categories": [{"id": "ai", "name": "AI", "tier": "free", "pool": "ai"}],
            "passthrough": [],
            "domains": {
                "claude.ai": {"service": "Anthropic / Claude", "category_id": "ai", "tier": "free", "pool": "ai"},
                "example.org": {"service": "Example", "category_id": "default", "tier": "free", "pool": "default"},
            },
        }

    def test_sync_nginx_workers_failover_failopen_and_idempotency(self):
        pm_path = _write_json(Path(self.tmp) / "free-pm.json", self._free_pm())
        stream_out = Path(self.tmp) / "nginx-workers-stream.conf"
        http_out = Path(self.tmp) / "nginx-workers-http.conf"
        health_out = Path(self.tmp) / "cluster-health.json"

        args = pro_dns.parse_args([
            "--tier", "free",
            "--policy-map", pm_path,
            "--policy-cache", "",
            "--health-out", str(health_out),
            "--nginx-stream-out", str(stream_out),
            "--nginx-http-out", str(http_out),
            "--health-interval", "3600",
            "--listen-ip", "",
            "--doh-listen", "",
        ])
        srv = pro_dns.build_server(args)
        reload_calls = []
        srv._reload_nginx = lambda: (reload_calls.append(1) or True)

        worker_status = {W1: True, W2: True}

        async def fake_tls(ip, port, sni, timeout, fallback_sni=None):
            ok = worker_status[ip]
            return (ok, 5.0, None if ok else "TimeoutError")

        async def fake_http(ip, port, host, timeout):
            ok = worker_status[ip]
            return (ok, 5.0, None if ok else "TimeoutError")

        orig_tls = pro_dns.healthcheck.probe_tls_sni
        orig_http = pro_dns.healthcheck.probe_http_healthz
        pro_dns.healthcheck.probe_tls_sni = fake_tls
        pro_dns.healthcheck.probe_http_healthz = fake_http
        try:
            async def run():
                # 1. Первый цикл: оба воркера UP -> файлы созданы, reload вызван 1 раз
                await srv.health_cycle()
                self.assertEqual(len(reload_calls), 1)
                s_txt = stream_out.read_text(encoding="utf-8")
                h_txt = http_out.read_text(encoding="utf-8")
                self.assertIn(W1, s_txt)
                self.assertIn(W2, s_txt)
                self.assertIn("weight=2", s_txt)
                self.assertIn(W1, h_txt)
                self.assertIn(W2, h_txt)
                self.assertNotIn("153.80.200.170", s_txt)
                self.assertTrue(health_out.is_file())

                # 2. Повторный цикл без изменений -> reload НЕ вызывается
                await srv.health_cycle()
                self.assertEqual(len(reload_calls), 1)

                # 3. Падение W2 (гистерезис 2/2) -> W2 убран из конфигов, reload = 2
                worker_status[W2] = False
                await srv.health_cycle()
                self.assertEqual(len(reload_calls), 1)  # 1-я ошибка ещё не DOWN
                await srv.health_cycle()
                self.assertEqual(len(reload_calls), 2)
                s_txt = stream_out.read_text(encoding="utf-8")
                h_txt = http_out.read_text(encoding="utf-8")
                self.assertIn(W1, s_txt)
                self.assertNotIn(W2, s_txt)
                self.assertIn(W1, h_txt)
                self.assertNotIn(W2, h_txt)

                # 4. Падение всех воркеров (fail-open) -> прямой выход на origin, без primary в upstream
                worker_status[W1] = False
                await srv.health_cycle()
                await srv.health_cycle()
                self.assertTrue(srv.fail_open)
                self.assertEqual(len(reload_calls), 3)
                s_txt = stream_out.read_text(encoding="utf-8")
                h_txt = http_out.read_text(encoding="utf-8")
                self.assertIn("$ssl_preread_server_name:443", s_txt)
                self.assertIn("$host", h_txt)
                self.assertNotIn(W1, s_txt)
                self.assertNotIn(W2, s_txt)
                self.assertNotIn("153.80.200.170", s_txt)

                # 5. Восстановление W1 и W2 (гистерезис 2/2) -> оба возвращаются, reload = 4
                worker_status[W1] = True
                worker_status[W2] = True
                await srv.health_cycle()
                self.assertEqual(len(reload_calls), 3)
                await srv.health_cycle()
                self.assertFalse(srv.fail_open)
                self.assertEqual(len(reload_calls), 4)
                s_txt = stream_out.read_text(encoding="utf-8")
                self.assertIn(W1, s_txt)
                self.assertIn(W2, s_txt)

            asyncio.run(run())
        finally:
            pro_dns.healthcheck.probe_tls_sni = orig_tls
            pro_dns.healthcheck.probe_http_healthz = orig_http

    def test_sync_nginx_workers_rolls_back_on_nginx_test_failure(self):
        pm_path = _write_json(Path(self.tmp) / "free-pm-rb.json", self._free_pm())
        stream_out = Path(self.tmp) / "nginx-workers-stream.conf"
        http_out = Path(self.tmp) / "nginx-workers-http.conf"
        stream_out.write_text("# prev stream\n", encoding="utf-8")
        http_out.write_text("# prev http\n", encoding="utf-8")

        args = pro_dns.parse_args([
            "--tier", "free",
            "--policy-map", pm_path,
            "--policy-cache", "",
            "--health-out", "",
            "--nginx-stream-out", str(stream_out),
            "--nginx-http-out", str(http_out),
            "--listen-ip", "",
            "--doh-listen", "",
        ])
        srv = pro_dns.build_server(args)
        srv._reload_nginx = lambda: False

        updated = srv.sync_nginx_workers_sync(reload_nginx=True)
        self.assertFalse(updated)
        self.assertEqual(stream_out.read_text(encoding="utf-8"), "# prev stream\n")
        self.assertEqual(http_out.read_text(encoding="utf-8"), "# prev http\n")

    def test_pro_mode_does_not_touch_nginx_configs_when_unset(self):
        srv = make_server(self.tmp)
        self.assertFalse(srv.sync_nginx_workers_sync())


if __name__ == "__main__":
    unittest.main()
