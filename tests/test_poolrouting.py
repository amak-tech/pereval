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
import generate  # noqa: E402

POOLS = poolrouting.normalize_pools({
    "default": {},
    "ai": {"fallback": "default", "max_clients": 60},
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

    def test_client_subnet_key(self):
        self.assertEqual(poolrouting.client_subnet_key("203.0.113.42"), "203.0.113.0/24")
        self.assertEqual(poolrouting.client_subnet_key("::ffff:203.0.113.99"), "203.0.113.0/24")
        self.assertEqual(poolrouting.client_subnet_key("2001:db8:abcd:1234::1"), "2001:db8:abcd:1200::/56")
        self.assertEqual(poolrouting.client_subnet_key("not-an-ip"), "not-an-ip")

    def test_pick_for_client_distribution_and_scale_out(self):
        cands = ["10.0.0.1", "10.0.0.2"]
        healthy = {"ai": cands, "default": ["10.0.0.9"]}
        clients = ["198.51.%d.0/24" % i for i in range(1, 201)]
        picked2 = {c: poolrouting.pick_for_client(c, "ai", POOLS, healthy) for c in clients}
        count1 = sum(1 for ip in picked2.values() if ip == "10.0.0.1")
        count2 = sum(1 for ip in picked2.values() if ip == "10.0.0.2")
        self.assertGreater(count1, 70)
        self.assertGreater(count2, 70)

        # При добавлении 3-й ноды не менее 2/3 существующих клиентов остаются на своих прежних нодах
        healthy3 = {"ai": ["10.0.0.1", "10.0.0.2", "10.0.0.3"], "default": ["10.0.0.9"]}
        picked3 = {c: poolrouting.pick_for_client(c, "ai", POOLS, healthy3) for c in clients}
        stayed = sum(1 for c in clients if picked3[c] == picked2[c])
        self.assertGreaterEqual(stayed, int(len(clients) * 0.6))

    def test_weighted_distribution(self):
        cands = ["10.0.0.1", "10.0.0.2"]
        healthy = {"ai": cands}
        weights = {"10.0.0.1": 3, "10.0.0.2": 1}
        clients = ["user-%d" % i for i in range(400)]
        picked = [poolrouting.pick_for_client(c, "ai", POOLS, healthy, weights=weights) for c in clients]
        n1 = picked.count("10.0.0.1")
        n2 = picked.count("10.0.0.2")
        self.assertGreater(n1, n2 * 2)

    def test_quota_tracker_overflow_and_plain_fallback(self):
        pools = poolrouting.normalize_pools({
            "default": {"max_clients": 2},
            "ai": {"fallback": "default", "max_clients": 2},
        })
        healthy = {"ai": ["10.0.0.1", "10.0.0.2"], "default": ["10.0.0.9"]}
        tracker = poolrouting.ClientQuotaTracker(ttl_sec=300.0)

        # Заполняем пул ai (2 ноды по 2 клиента = 4 слота)
        assigned = {}
        for i in range(1, 5):
            ck = "client-%d" % i
            ip = poolrouting.pick_for_client(ck, "ai", pools, healthy, quota_tracker=tracker, now=100.0)
            self.assertIn(ip, ("10.0.0.1", "10.0.0.2"))
            assigned[ck] = ip
        self.assertEqual(tracker.active_count("10.0.0.1", now=100.0), 2)
        self.assertEqual(tracker.active_count("10.0.0.2", now=100.0), 2)

        # Существующие клиенты продолжают получать свою ноду даже при заполненной квоте
        for ck, expected_ip in assigned.items():
            got = poolrouting.pick_for_client(ck, "ai", pools, healthy, quota_tracker=tracker, now=110.0)
            self.assertEqual(got, expected_ip)

        # 5-й и 6-й клиенты переливаются в fallback-пул default (10.0.0.9, лимит 2)
        self.assertEqual(
            poolrouting.pick_for_client("client-5", "ai", pools, healthy, quota_tracker=tracker, now=110.0),
            "10.0.0.9",
        )
        self.assertEqual(
            poolrouting.pick_for_client("client-6", "ai", pools, healthy, quota_tracker=tracker, now=110.0),
            "10.0.0.9",
        )

        # 7-й клиент: все слоты в ai и default исчерпаны -> None (откат в plain DNS)
        self.assertIsNone(
            poolrouting.pick_for_client("client-7", "ai", pools, healthy, quota_tracker=tracker, now=110.0)
        )

        # После истечения окна 300с слоты для первых клиентов (touch на 110.0 -> 410.0) освобождаются
        ip_after_ttl = poolrouting.pick_for_client("client-7", "ai", pools, healthy, quota_tracker=tracker, now=415.0)
        self.assertIn(ip_after_ttl, ("10.0.0.1", "10.0.0.2"))

    def test_resolve_node_max_clients_priority(self):
        pools = poolrouting.normalize_pools({
            "default": {},
            "ai": {"fallback": "default", "max_clients": 60},
        })
        workers = [
            {"ip": "10.0.0.1", "name": "w1", "pools": ["ai"], "max_clients": 25},
            {"ip": "10.0.0.2", "name": "w2", "pools": ["ai"]},
            {"ip": "10.0.0.3", "name": "w3", "pools": ["default"]},
        ]
        # worker override -> 25
        self.assertEqual(poolrouting.resolve_node_max_clients("10.0.0.1", "ai", pools, workers, 150, 200), 25)
        # pool override -> 60
        self.assertEqual(poolrouting.resolve_node_max_clients("10.0.0.2", "ai", pools, workers, 150, 200), 60)
        self.assertEqual(poolrouting.resolve_node_max_clients("10.0.0.2", "", pools, workers, 150, 200), 60)
        # cluster override -> 150
        self.assertEqual(poolrouting.resolve_node_max_clients("10.0.0.3", "default", pools, workers, 150, 200), 150)
        # global default -> 200
        self.assertEqual(poolrouting.resolve_node_max_clients("10.0.0.3", "default", pools, workers, None, 200), 200)

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
        self.assertIn("hash $pereval_client_subnet consistent;", conf)
        self.assertNotIn("least_conn;", conf)
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
        self.assertIn("hash $pereval_client_subnet consistent;", conf)
        self.assertIn("keepalive 32;", conf)
        self.assertIn('""                "";', conf)


class GenerateMaxClientsTests(unittest.TestCase):
    def test_validate_rejects_non_positive_max_clients(self):
        cluster = generate.Cluster()
        cluster.max_clients = 0
        cluster.pools["ai"] = generate.Pool("ai", fallback="default", max_clients=-1)
        cluster.workers.append(generate.WorkerNode("1.2.3.4", "w1", pools=["default", "ai"], max_clients=0))
        errors, warnings = [], []
        generate._validate_cluster(cluster, "nodes", set(), errors, warnings)
        self.assertEqual(len([e for e in errors if "max_clients" in e]), 3, errors)

    def test_services_yaml_exports_max_clients_and_free_policy_map(self):
        doc = generate.parse(str(ROOT / "services.yaml"))
        self.assertIsNotNone(doc.nodes.max_clients)
        self.assertGreater(doc.nodes.max_clients, 0)
        self.assertIsNotNone(doc.pro.max_clients)
        self.assertGreater(doc.pro.max_clients, 0)

        fpm = json.loads(generate.free_policy_map_json(doc, doc.nodes.primary))
        self.assertEqual(fpm["tier"], "free")
        self.assertEqual(fpm["max_clients"], doc.nodes.max_clients)
        self.assertEqual(fpm["pools"]["ai"].get("max_clients"), doc.nodes.pools["ai"].max_clients)
        self.assertIn("gosuslugi.ru", fpm["passthrough"])
        self.assertIn("claude.ai", fpm["domains"])
        # Фоновые домены Google перенесены в disabled
        self.assertNotIn("notifications-pa.clients6.google.com", fpm["domains"])
        self.assertNotIn("people-pa.clients6.google.com", fpm["domains"])


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
