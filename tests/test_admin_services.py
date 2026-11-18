# -*- coding: utf-8 -*-
"""Тесты сервисов только для администратора (pro.admin_services / admin_only: true):
генерация, валидация, Pro DNS и исключение из статистики."""
import asyncio
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import dnstestutil as tu  # noqa: E402
import generate  # noqa: E402
import pro_dns  # noqa: E402
import stats_collector  # noqa: E402


SAMPLE_YAML = """
meta:
  name: Перевал
  origin: https://pereval.top
free:
  domain: free.pereval.top
nodes:
  primary: 153.80.200.170
  pools:
    default: {}
  workers:
    - ip: 151.247.25.123
      name: free-w1
      pools: [default]
dnsmasq_options:
  - port=53
categories:
  - id: ai
    name: ИИ
    pool: default
    services:
      - name: Claude
        slug: claude
        domains:
          - claude.ai
passthrough:
  note: ru
  domains:
    - gosuslugi.ru
pro:
  domain: pro.pereval.top
  dns_ip: 85.209.148.147
  pools:
    default: {}
    ai:
      fallback: default
      strict_allowlist: true
  workers:
    - ip: 141.11.197.239
      name: pro-w1
      pools: [default]
    - ip: 141.11.197.214
      name: pro-w2
      pools: [ai]
  categories:
    - id: work
      name: Работа
      pool: default
      services:
        - name: Notion
          slug: notion
          domains:
            - notion.so
        - name: Secret Work Tool
          slug: secret-work
          admin_only: true
          domains:
            - secretwork.example
    - id: staging_only
      name: Скрытая категория
      pool: default
      services:
        - name: Only Admin In Cat
          slug: only-admin-cat
          admin_only: true
          domains:
            - catadmin.example
  admin_services:
    - name: Staging AI
      slug: staging-ai
      pool: ai
      domains:
        - staging-ai.example
        - cdn-staging-ai.example
"""


class AdminServicesGenerateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pereval-adm-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_yaml(self, text: str) -> Path:
        p = self.tmp / "services.yaml"
        p.write_text(text.strip() + "\n", encoding="utf-8")
        return p

    def test_generate_hides_admin_services_from_site_and_free_but_keeps_in_pro_routing(self):
        ypath = self._write_yaml(SAMPLE_YAML)
        doc = generate.parse(str(ypath))
        errors, _warnings = generate.validate(doc, primary_ip="153.80.200.170")
        self.assertEqual(errors, [])

        # 1. Сайт (services.json): ни сервисов, ни доменов, ни скрытой категории, ни лишних counts
        catalog = json.loads(generate.services_json(doc, "153.80.200.170"))
        cat_ids = [c["id"] for c in catalog["categories"]]
        self.assertEqual(cat_ids, ["ai", "work"])
        all_site_svcs = [s["name"] for c in catalog["categories"] for s in c["services"]]
        self.assertEqual(all_site_svcs, ["Claude", "Notion"])
        all_site_domains = [d for c in catalog["categories"] for s in c["services"] for d in s["domains"]]
        for secret_dom in ("secretwork.example", "catadmin.example", "staging-ai.example", "cdn-staging-ai.example"):
            self.assertNotIn(secret_dom, all_site_domains)
        self.assertEqual(catalog["counts"]["free_categories"], 1)
        self.assertEqual(catalog["counts"]["free_services"], 1)
        self.assertEqual(catalog["counts"]["free_domains"], 1)
        self.assertEqual(catalog["counts"]["pro_categories"], 1)
        self.assertEqual(catalog["counts"]["pro_services"], 1)
        self.assertEqual(catalog["counts"]["pro_domains"], 1)

        # 2. Free конфиги: admin-only доменов нет
        values = generate.build_values(doc, "153.80.200.170", "services.yaml")
        for key in ("body", "sni_entries", "host_entries", "service_map_json"):
            for secret_dom in ("secretwork.example", "catadmin.example", "staging-ai.example"):
                self.assertNotIn(secret_dom, values[key])
        free_pm = json.loads(generate.free_policy_map_json(doc, "153.80.200.170"))
        self.assertNotIn("staging-ai.example", free_pm["domains"])

        # 3. Pro allow-карты и strict_allowlist пула ai: домены присутствуют, чтобы воркер проксировал их админу
        pv = generate.pro_values(doc, values)
        for secret_dom in (".secretwork.example", ".catadmin.example", ".staging-ai.example", ".cdn-staging-ai.example"):
            self.assertIn(secret_dom, pv["sni_entries"])
            self.assertIn(secret_dom, pv["host_entries"])
        strict_maps = dict(generate.strict_pool_maps(doc, doc.pro, doc.all_pro_routing_categories(), "pro-"))
        self.assertIn(".staging-ai.example", strict_maps["pro-nginx-sni-allow.ai.map"])
        self.assertNotIn(".secretwork.example", strict_maps["pro-nginx-sni-allow.ai.map"])

        # 4. pro-policy-map.json: admin_only=True проставлен только у админских сервисов
        pro_pm = json.loads(generate.pro_policy_map_json(doc))
        self.assertFalse(pro_pm["domains"]["claude.ai"].get("admin_only", False))
        self.assertFalse(pro_pm["domains"]["notion.so"].get("admin_only", False))
        self.assertTrue(pro_pm["domains"]["secretwork.example"].get("admin_only"))
        self.assertEqual(pro_pm["domains"]["secretwork.example"]["category_id"], "work")
        self.assertTrue(pro_pm["domains"]["staging-ai.example"].get("admin_only"))
        self.assertEqual(pro_pm["domains"]["staging-ai.example"]["pool"], "ai")
        self.assertEqual(pro_pm["domains"]["staging-ai.example"]["category_id"], "")
        pm_cat_ids = [c["id"] for c in pro_pm["categories"]]
        self.assertEqual(pm_cat_ids, ["ai", "work"])
        work_cat = [c for c in pro_pm["categories"] if c["id"] == "work"][0]
        self.assertEqual(work_cat["service_count"], 1)
        self.assertEqual(work_cat["domain_count"], 1)

        # 5. pro-service-map.json: admin_only=True присутствует для исключения из stats_collector
        pro_smap = json.loads(generate.service_map_json(doc, doc.all_pro_routing_categories()))
        self.assertNotIn("admin_only", pro_smap["notion.so"])
        self.assertTrue(pro_smap["staging-ai.example"].get("admin_only"))
        self.assertTrue(pro_smap["secretwork.example"].get("admin_only"))

    def test_validation_rejects_free_admin_only_and_top_level_admin_services(self):
        # admin_services на верхнем уровне -> ParseError
        bad_top = SAMPLE_YAML + "\nadmin_services:\n  - name: X\n    domains: [x.example]\n"
        with self.assertRaises(generate.ParseError):
            generate.parse(str(self._write_yaml(bad_top)))

        # admin_only: false в pro.admin_services -> ParseError
        bad_false = SAMPLE_YAML + "\n    - name: X\n      admin_only: false\n      domains: [x.example]\n"
        with self.assertRaises(generate.ParseError):
            generate.parse(str(self._write_yaml(bad_false)))

        # admin_only: true во Free categories -> ошибка валидации
        free_admin = SAMPLE_YAML.replace(
            "        slug: claude\n",
            "        slug: claude\n        admin_only: true\n",
        )
        doc = generate.parse(str(self._write_yaml(free_admin)))
        errors, _ = generate.validate(doc, primary_ip="153.80.200.170")
        self.assertTrue(any("admin_only" in e for e in errors), errors)

        # пересечение с passthrough и дубль домена в pro.admin_services ловятся валидатором
        dup_dom = SAMPLE_YAML + "\n    - name: Dup\n      domains: [notion.so, gosuslugi.ru]\n"
        doc2 = generate.parse(str(self._write_yaml(dup_dom)))
        errors2, _ = generate.validate(doc2, primary_ip="153.80.200.170")
        self.assertTrue(any("notion.so указан дважды" in e for e in errors2), errors2)
        self.assertTrue(any("gosuslugi.ru" in e and "passthrough" in e for e in errors2), errors2)


class AdminServicesDnsAndStatsTests(unittest.TestCase):
    def setUp(self):
        pro_dns.log = lambda msg: None
        self.tmp = Path(tu.tmpdir())

    def test_pro_dns_allows_admin_services_only_for_admins_and_skips_activity_stats(self):
        ypath = self.tmp / "services.yaml"
        ypath.write_text(SAMPLE_YAML.strip() + "\n", encoding="utf-8")
        doc = generate.parse(str(ypath))
        pm_path = self.tmp / "pro-policy-map.json"
        pm_path.write_text(generate.pro_policy_map_json(doc), encoding="utf-8")

        tok_user = "useruseruseruseruse2"
        tok_admin = "adminadminadminadmi3"
        tok_admin_plain = "adminplainadminplai4"
        policy_data = {
            "version": 1,
            "generated_at": "2026-11-18T12:00:00Z",
            "tokens": {
                tok_user: {"user_id": "u-reg", "mode": "proxy", "disabled_categories": []},
                tok_admin: {"user_id": "u-adm", "mode": "proxy", "disabled_categories": [], "is_admin": True},
                tok_admin_plain: {"user_id": "u-adm2", "mode": "plain", "disabled_categories": [], "is_admin": True},
            },
            "ips": {
                "198.51.100.10": {"user_id": "u-reg", "mode": "proxy", "disabled_categories": []},
                "198.51.100.20": {"user_id": "u-adm", "mode": "proxy", "disabled_categories": [], "is_admin": True},
            },
            "workers": None,
        }
        pf_path = self.tmp / "policy.json"
        pf_path.write_text(json.dumps(policy_data), encoding="utf-8")

        # Проверка round-trip кеша политики (is_admin сохраняется)
        pol = pro_dns.Policy.from_dict(policy_data)
        pol_rt = pro_dns.Policy.from_dict(pol.to_dict())
        self.assertTrue(pol_rt.tokens[tok_admin]["is_admin"])
        self.assertFalse(pol_rt.tokens[tok_user]["is_admin"])

        async def run():
            up = await tu.FakeUpstream().start()
            args = pro_dns.parse_args([
                "--no-cp", "--policy-map", str(pm_path), "--policy-file", str(pf_path),
                "--policy-cache", "", "--health-out", "", "--health-interval", "3600",
                "--listen-ip", "", "--doh-listen", "", "--upstream", "127.0.0.1:%d" % up.port,
                "--pro-domain", "pro.pereval.top",
            ])
            srv = pro_dns.build_server(args)
            await srv.upstream.start()
            try:
                reg_ident = srv.identify_token(tok_user, "198.51.100.55")
                adm_ident = srv.identify_token(tok_admin, "198.51.100.66")
                adm_ip_ident = srv.identify_ip("198.51.100.20")
                reg_ip_ident = srv.identify_ip("198.51.100.10")
                adm_plain_ident = srv.identify_token(tok_admin_plain, "198.51.100.77")

                # Обычный подписчик: Notion проксируется, но staging-ai.example и secretwork.example уходят в upstream
                r_notion = await srv.resolve(tu.make_query("notion.so", 1), reg_ident, "doh")
                self.assertEqual(tu.a_answers(r_notion), ["141.11.197.239"])

                r_secret_user = await srv.resolve(tu.make_query("api.staging-ai.example", 1), reg_ident, "doh")
                self.assertEqual(tu.a_answers(r_secret_user), [tu.UPSTREAM_A])
                r_secret_aaaa_user = await srv.resolve(tu.make_query("api.staging-ai.example", 28), reg_ident, "doh")
                # Для обычного пользователя AAAA не режется в NODATA, а форвардится в upstream
                self.assertEqual(up.udp_queries, 2)
                self.assertEqual(tu.parse_header(r_secret_aaaa_user)["rcode"], 0)

                r_secret_ip_user = await srv.resolve(tu.make_query("secretwork.example", 1), reg_ip_ident, "udp")
                self.assertEqual(tu.a_answers(r_secret_ip_user), [tu.UPSTREAM_A])

                # Админ (по токену и по IP): оба admin-only сервиса проксируются в свои пулы!
                r_adm_ai = await srv.resolve(tu.make_query("api.staging-ai.example", 1), adm_ident, "doh")
                self.assertEqual(tu.a_answers(r_adm_ai), ["141.11.197.214"])  # воркер пула ai
                r_adm_aaaa = await srv.resolve(tu.make_query("api.staging-ai.example", 28), adm_ident, "doh")
                self.assertEqual((tu.parse_header(r_adm_aaaa)["rcode"], tu.parse_header(r_adm_aaaa)["an"]), (0, 0))

                r_adm_work = await srv.resolve(tu.make_query("sub.secretwork.example", 1), adm_ip_ident, "udp")
                self.assertEqual(tu.a_answers(r_adm_work), ["141.11.197.239"])  # воркер пула default

                # Админ в режиме plain (истёкшая подписка): не проксируется
                r_adm_plain = await srv.resolve(tu.make_query("staging-ai.example", 1), adm_plain_ident, "doh")
                self.assertEqual(tu.a_answers(r_adm_plain), [tu.UPSTREAM_A])

                # Проверка ACL vs статистика активности:
                # Админ ходил ТОЛЬКО на admin_only домены -> его IP попал в pending_acl (для nftables),
                # но в статистике activity (token_activity.queries) его обращений НЕТ!
                payload = srv.tracker.build_payload("pro-dns", {})
                acl_ips = {a["ip"] for a in payload["acl"]}
                self.assertIn("198.51.100.66", acl_ips)
                self.assertIn("198.51.100.20", acl_ips)
                act_users = {a["user_id"]: a["queries"] for a in payload["activity"]}
                self.assertNotIn("u-adm", act_users)
                # У обычного пользователя учтён только 1 запрос к notion.so (запросы к admin_only не посчитаны)
                self.assertEqual(act_users.get("u-reg"), 1)
            finally:
                srv.upstream.close()
                await up.stop()

        asyncio.run(run())

    def test_stats_collector_ignores_admin_only_domains_and_subdomains(self):
        ypath = self.tmp / "services.yaml"
        ypath.write_text(SAMPLE_YAML.strip() + "\n", encoding="utf-8")
        doc = generate.parse(str(ypath))
        smap_path = self.tmp / "pro-service-map.json"
        smap_path.write_text(generate.service_map_json(doc, doc.all_pro_routing_categories()), encoding="utf-8")

        sni_log = self.tmp / "sni.log"
        http_log = self.tmp / "http.log"
        out_path = self.tmp / "stats.json"
        node_out = self.tmp / "node-stats.json"

        # 03/Nov/2026:19:55:12 +0000 -> фиксируем now рядом с этим временем
        log_time = "03/Nov/2026:19:55:12 +0000"
        ts = stats_collector.parse_nginx_time(log_time)

        sni_log.write_text(
            "\n".join([
                # Трафик админа к тестируемым сервисам (точный домен и поддомены) — должен быть проигнорирован
                f'198.51.100.66 [{log_time}] sni="staging-ai.example" up=93.184.216.34:443 status=200 sent=5000 recv=15000 dur=1.20',
                f'198.51.100.66 [{log_time}] sni="api.v2.staging-ai.example" up=93.184.216.34:443 status=200 sent=8000 recv=20000 dur=0.50',
                f'198.51.100.66 [{log_time}] sni="app.secretwork.example" up=93.184.216.34:443 status=200 sent=1000 recv=2000 dur=0.10',
                # Обычный сервис — должен учитываться
                f'198.51.100.55 [{log_time}] sni="www.notion.so" up=104.18.1.2:443 status=200 sent=1200 recv=3400 dur=0.80',
            ]) + "\n",
            encoding="utf-8",
        )
        http_log.write_text(
            "\n".join([
                f'198.51.100.66 [{log_time}] "GET /test HTTP/1.1" host="cdn-staging-ai.example" -> 93.184.216.34:80 200 4096',
                f'198.51.100.55 [{log_time}] "GET / HTTP/1.1" host="notion.so" -> 104.18.1.2:80 200 512',
            ]) + "\n",
            encoding="utf-8",
        )

        collector = stats_collector.StatsCollector(
            service_map_path=smap_path,
            sni_log_path=sni_log,
            http_log_path=http_log,
            output_path=out_path,
            node_output_path=node_out,
            proc_tcp_path=self.tmp / "no-tcp",
            proc_tcp6_path=self.tmp / "no-tcp6",
            self_domain="pro.pereval.top",
            role="worker",
        )
        try:
            collector.bootstrap_logs({}, now=ts + 5)
            collector.tick(now=ts + 5)
            payload = collector.write_output(now=ts + 5)
        finally:
            if collector.sni_tailer:
                collector.sni_tailer.close()
            if collector.http_tailer:
                collector.http_tailer.close()
        node_snap = json.loads(node_out.read_text(encoding="utf-8"))

        # Учтены только 2 запроса от обычного пользователя к Notion; админский IP и тестовые сервисы не попали никуда
        self.assertEqual(payload["live"]["requests_24h"], 2)
        self.assertEqual(payload["live"]["unique_users_24h"], 1)
        self.assertEqual(payload["live"]["online_users_5m"], 1)
        self.assertEqual(node_snap["online_users_5m"], 1)
        top_names_24h = [r["service"] for r in payload["top_services_24h"]]
        top_names_1h = [r["service"] for r in payload["top_services_1h"]]
        self.assertEqual(top_names_24h, ["Notion"])
        self.assertEqual(top_names_1h, ["Notion"])


if __name__ == "__main__":
    unittest.main()
