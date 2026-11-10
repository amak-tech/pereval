# -*- coding: utf-8 -*-
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import poolrouting  # noqa: E402
import healthcheck  # noqa: E402

POOLS = poolrouting.normalize_pools({
    "default": {},
    "ai": {"fallback": "default"},
    "media": {"fallback": "default"},
    "exotic": {"fallback": "media"},
})


class RendezvousTests(unittest.TestCase):
    def test_deterministic_and_single_ip_per_service(self):
        cands = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
        a = poolrouting.rendezvous_pick("Anthropic / Claude", cands)
        b = poolrouting.rendezvous_pick("Anthropic / Claude", list(reversed(cands)))
        self.assertEqual(a, b)
        self.assertIn(a, cands)

    def test_minimal_reshuffle_when_node_dies(self):
        cands = ["10.0.0.%d" % i for i in range(1, 6)]
        services = ["svc-%d" % i for i in range(300)]
        before = {s: poolrouting.rendezvous_pick(s, cands) for s in services}
        dead = "10.0.0.3"
        after = {s: poolrouting.rendezvous_pick(s, [c for c in cands if c != dead]) for s in services}
        moved = [s for s in services if before[s] != after[s]]
        # пересаживаются только сервисы, сидевшие на умершей ноде
        self.assertTrue(all(before[s] == dead for s in moved))
        self.assertTrue(all(after[s] != dead for s in services))

    def test_fallback_chain_and_last_resort(self):
        self.assertEqual(poolrouting.pool_chain("exotic", POOLS), ["exotic", "media", "default"])
        healthy = {"default": ["1.1.1.1"], "ai": [], "media": [], "exotic": []}
        self.assertEqual(poolrouting.pick("x", "exotic", POOLS, healthy), "1.1.1.1")
        self.assertEqual(poolrouting.pick("x", "ai", POOLS, {}, last_resort=["9.9.9.9"]), "9.9.9.9")
        self.assertIsNone(poolrouting.pick("x", "ai", POOLS, {}))

    def test_fallback_cycle_is_safe(self):
        pools = poolrouting.normalize_pools({"a": {"fallback": "b"}, "b": {"fallback": "a"}})
        self.assertEqual(poolrouting.pool_chain("a", pools), ["a", "b", "default"])

    def test_workers_by_pool(self):
        workers = [{"ip": "1.1.1.1", "pools": ["ai", "default"]}, {"ip": "2.2.2.2", "pools": ["media"]}]
        bp = poolrouting.workers_by_pool(workers, POOLS, extra_ips=["3.3.3.3"])
        self.assertEqual(bp["ai"], ["1.1.1.1", "3.3.3.3"])
        self.assertEqual(bp["media"], ["2.2.2.2", "3.3.3.3"])
        self.assertEqual(bp["exotic"], ["3.3.3.3"])


class NginxRenderTests(unittest.TestCase):
    def test_empty_pool_falls_back_and_direct_egress_when_all_down(self):
        healthy = {"default": ["1.1.1.1"], "ai": [], "media": ["2.2.2.2"], "exotic": []}
        conf = poolrouting.render_stream_workers(POOLS, healthy, {"claude.ai": "ai", "x.tv": "media"})
        self.assertIn("upstream pereval_stream_pool_default", conf)
        self.assertNotIn("upstream pereval_stream_pool_ai {\n    least_conn;\n}", conf)
        self.assertIn(".claude.ai", conf)
        # ai пуст -> его домены идут в default-upstream через fallback
        line = [ln for ln in conf.splitlines() if ".claude.ai" in ln][0]
        self.assertIn("pereval_stream_pool_ai", line)
        self.assertIn("server 1.1.1.1:443", conf.split("upstream pereval_stream_pool_ai")[1].split("}")[0])
        empty = poolrouting.render_stream_workers(POOLS, {}, {})
        self.assertIn("$ssl_preread_server_name:443", empty)
        self.assertNotIn("upstream pereval_", empty)

    def test_http_render(self):
        healthy = {"default": ["1.1.1.1"]}
        conf = poolrouting.render_http_workers(POOLS, healthy, {"a.com": "default"})
        self.assertIn("keepalive 32;", conf)
        self.assertIn('""                "";', conf)


class HealthcheckDnsmasqTests(unittest.TestCase):
    TEMPLATE = (
        "# opts\nlisten-address=0.0.0.0\n\n# --- A [pool: ai] ---\n"
        "address=/a.com/0.0.0.0\naddress=/a.com/0.0.0.1\n"
        "# --- B ---\naddress=/b.com/0.0.0.0\n#address=/dis.com/0.0.0.0\n"
    )
    SMAP = {"a.com": {"service": "A", "pool": "ai"}, "b.com": {"service": "B", "pool": "media"}}

    def test_pooled_render(self):
        healthy = {"default": ["1.1.1.1"], "ai": ["5.5.5.5"], "media": []}
        out = healthcheck.render_dnsmasq_conf_pooled(self.TEMPLATE, POOLS, healthy, self.SMAP, ["9.9.9.9"])
        self.assertEqual(out.count("address=/a.com/"), 1)  # дубликаты схлопнуты
        self.assertIn("address=/a.com/5.5.5.5", out)
        self.assertIn("address=/b.com/1.1.1.1", out)       # media пуст -> default
        self.assertIn("#address=/dis.com/1.1.1.1", out)    # неизвестный домен -> default
        self.assertTrue(out.endswith("\n"))

    def test_last_resort_when_everything_down(self):
        out = healthcheck.render_dnsmasq_conf_pooled(self.TEMPLATE, POOLS, {}, self.SMAP, ["9.9.9.9"])
        self.assertEqual(set(re.findall(r"address=/[^/]+/(\S+)", out)), {"9.9.9.9"})

    def test_single_default_pool_matches_legacy_round_robin_with_one_ip(self):
        pools = poolrouting.normalize_pools({})
        healthy = {"default": ["1.1.1.1"]}
        pooled = healthcheck.render_dnsmasq_conf_pooled(self.TEMPLATE, pools, healthy, {}, ["1.1.1.1"])
        legacy = healthcheck.render_dnsmasq_conf(self.TEMPLATE, ["1.1.1.1"])
        self.assertEqual(pooled, legacy)


class BuildConsistencyTests(unittest.TestCase):
    """Проверки на реальном build/, если он собран."""

    def setUp(self):
        self.build = ROOT / "build"
        if not (self.build / "service-map.json").is_file():
            self.skipTest("build/ не собран")

    def test_service_map_has_pools_and_matches_dnsmasq(self):
        smap = json.loads((self.build / "service-map.json").read_text(encoding="utf-8"))
        self.assertTrue(all("pool" in v and "category_id" in v for v in smap.values()))
        conf = (self.build / "dnsmasq-geoblock.conf").read_text(encoding="utf-8")
        domains = set(re.findall(r"^address=/([^/]+)/", conf, re.M))
        self.assertEqual(domains, set(smap))
        # все домены одного сервиса -> один IP
        by_service = {}
        for d, ip in re.findall(r"^address=/([^/]+)/(\S+)", conf, re.M):
            by_service.setdefault(smap[d]["service"], set()).add(ip)
        self.assertTrue(all(len(v) == 1 for v in by_service.values()), by_service)

    def test_pro_policy_map_superset(self):
        pro = json.loads((self.build / "pro-policy-map.json").read_text(encoding="utf-8"))
        smap = json.loads((self.build / "service-map.json").read_text(encoding="utf-8"))
        self.assertTrue(set(smap) <= set(pro["domains"]))
        self.assertTrue(all(c["tier"] in ("free", "pro") for c in pro["categories"]))


if __name__ == "__main__":
    unittest.main()
