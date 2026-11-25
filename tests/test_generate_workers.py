"""Секрет на Pro-воркер: secret_env в services.yaml / pro-nodes.json и имя переменной по умолчанию."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import generate  # noqa: E402


class WorkerSecretEnvTests(unittest.TestCase):
    def test_default_secret_env_from_name(self):
        self.assertEqual(generate.WorkerNode("1.2.3.4", "pro-worker-ai-1").default_secret_env(), "PRO_WORKER_AI_1_SECRET")
        self.assertEqual(generate.WorkerNode("1.2.3.4", "pro-worker-1").default_secret_env(), "PRO_WORKER_1_SECRET")
        self.assertEqual(generate.WorkerNode("1.2.3.4", "").default_secret_env(idx=3), "WORKER_3_SECRET")
        self.assertEqual(generate.WorkerNode("1.2.3.4", "1st.node").default_secret_env(), "WORKER_1ST_NODE_SECRET")

    def test_as_dict_exposes_secret_env_only_with_ssh(self):
        w = generate.WorkerNode("1.2.3.4", "pro-worker-1")
        self.assertEqual(w.as_dict()["secret_env"], "PRO_WORKER_1_SECRET")
        self.assertNotIn("secret_env", w.as_dict(with_ssh=False))
        w = generate.WorkerNode("1.2.3.4", "pro-worker-1", secret_env="MY_SECRET")
        self.assertEqual(w.as_dict()["secret_env"], "MY_SECRET")

    def test_validate_rejects_bad_secret_env_name(self):
        cluster = generate.Cluster()
        cluster.workers.append(generate.WorkerNode("1.2.3.4", "w1", secret_env="bad-name"))
        errors, warnings = [], []
        generate._validate_cluster(cluster, "pro", set(), errors, warnings)
        self.assertTrue(any("secret_env" in e for e in errors), errors)

    def test_real_services_yaml_pro_workers_have_secret_env(self):
        doc = generate.parse(str(ROOT / "services.yaml"))
        workers = json.loads(generate.pro_nodes_json(doc))["workers"]
        self.assertTrue(workers)
        names = {}
        for w in workers:
            self.assertRegex(w["secret_env"], r"^[A-Z][A-Z0-9_]*_SECRET$", w)
            names[w["name"]] = w["secret_env"]
        self.assertEqual(len(set(names.values())), len(names), "secret_env должны быть уникальны")
        # deploy.yml должен пробрасывать переменную каждого воркера, иначе нода откатится на общий PRO_WORKER_SECRET
        workflow = (ROOT / ".github" / "workflows" / "deploy.yml").read_text(encoding="utf-8")
        for name, var in names.items():
            self.assertIn("%s: ${{ secrets.%s }}" % (var, var), workflow,
                          "deploy.yml не пробрасывает %s для воркера %s" % (var, name))

    def test_service_slugs_and_notes_in_services_json(self):
        doc = generate.parse(str(ROOT / "services.yaml"))
        errors, _ = generate.validate(doc, primary_ip="153.80.200.170")
        self.assertEqual(errors, [])
        payload = json.loads(generate.services_json(doc, "153.80.200.170"))
        slugs = []
        by_slug = {}
        for cat in payload["categories"]:
            for svc in cat["services"]:
                self.assertIn("slug", svc)
                self.assertRegex(svc["slug"], r"^[a-z0-9]+(-[a-z0-9]+)*$")
                self.assertTrue(svc["domains"])
                slugs.append(svc["slug"])
                by_slug[svc["slug"]] = svc
        self.assertEqual(len(slugs), len(set(slugs)), "слаги сервисов должны быть уникальны")

        public_doc_cats = list(doc.categories) + (list(doc.pro.categories) if doc.pro else [])
        expected_public = [
            svc for cat in public_doc_cats for svc in cat.services if not getattr(svc, "admin_only", False)
        ]
        self.assertEqual(len(slugs), len(expected_public))
        for svc in expected_public:
            slug = svc.slug or generate.service_slug(svc.name)
            self.assertIn(slug, by_slug)
            self.assertEqual(by_slug[slug]["domains"], svc.domains)
            if svc.note:
                self.assertEqual(by_slug[slug].get("note"), svc.note)

    def test_validate_rejects_duplicate_service_slug(self):
        c1 = generate.Category("ai", "AI")
        s1 = generate.Service("One", slug="same-slug")
        s1.domains = ["one.example.com"]
        s2 = generate.Service("Two", slug="same-slug")
        s2.domains = ["two.example.com"]
        c1.services = [s1, s2]
        errors, warnings = [], []
        generate._validate_categories([c1], {"default": generate.Pool("default")}, "categories", errors, warnings, {})
        self.assertTrue(any("slug сервиса «same-slug» совпадает" in e for e in errors), errors)

    def test_validate_allows_covered_subdomains_without_warning(self):
        doc = generate.parse(str(ROOT / "services.yaml"))
        errors, warnings = generate.validate(doc, primary_ip="153.80.200.170")
        self.assertEqual(errors, [])
        self.assertFalse(any("уже покрыт" in w for w in warnings), warnings)

    def test_exclude_domains_rendered_in_policy_maps_dnsmasq_nginx_without_polluting_site_passthrough(self):
        doc = generate.parse(str(ROOT / "services.yaml"))
        errors, _ = generate.validate(doc, primary_ip="153.80.200.170")
        self.assertEqual(errors, [])

        # Динамический инвариант по реальному services.yaml:
        # все exclude_domains сервисов входят в passthrough карт DNS, но НЕ в витрину российских сайтов services.json
        pro_excl = set(doc.excluded_domains(doc.all_pro_routing_categories()))
        pro_pm = json.loads(generate.pro_policy_map_json(doc))
        site_cat = json.loads(generate.services_json(doc, "153.80.200.170"))
        self.assertTrue(pro_excl.issubset(set(pro_pm["passthrough"])))
        self.assertTrue(pro_excl.isdisjoint(set(site_cat["passthrough"]["domains"])))

        # Синтетический сервис: проверяем dnsmasq, nginx allow-map, update_hosts и валидацию
        synth = generate.Doc()
        synth.meta["name"] = "Test"
        synth.meta["origin"] = "https://pereval.top"
        synth.free.domain = "free.pereval.top"
        synth.nodes.primary = "153.80.200.170"
        synth.nodes.workers = [generate.WorkerNode("198.51.100.10", "w1", pools=["default"])]
        synth.passthrough.note = "ru"
        synth.passthrough.domains = ["gosuslugi.ru"]
        cat = generate.Category("games", "Games", pool="default", tier="free")
        svc = generate.Service("Console Net", slug="console-net")
        svc.domains = ["console.example"]
        svc.exclude_domains = ["stun.console.example"]
        cat.services = [svc]
        synth.categories = [cat]

        errs, _ = generate.validate(synth, primary_ip="153.80.200.170")
        self.assertEqual(errs, [])
        vals = generate.build_values(synth, "153.80.200.170", "services.yaml")
        self.assertIn(".console.example", vals["sni_entries"])
        self.assertRegex(vals["sni_entries"], r"\.stun\.console\.example\s+127\.0\.0\.1:9;")
        self.assertRegex(vals["host_entries"], r'\.stun\.console\.example\s+"";')
        free_pm = json.loads(generate.free_policy_map_json(synth, "153.80.200.170"))
        self.assertIn("console.example", free_pm["domains"])
        self.assertEqual(free_pm["passthrough"], ["gosuslugi.ru", "stun.console.example"])

        import update_hosts  # noqa: E402
        hosts_block = update_hosts.build_hosts_block(
            ["console.example", "ru.np.stun.console.example"], "198.51.100.10", {"stun.console.example"}
        )
        self.assertIn("www.console.example", hosts_block)
        self.assertNotIn("stun.console.example", hosts_block)

        # Ошибка валидации, если exclude_domains не является поддоменом сервиса или дублирует domains
        svc.exclude_domains = ["unrelated.example"]
        errs_unrel, _ = generate.validate(synth, primary_ip="153.80.200.170")
        self.assertTrue(any("поддоменом одного из доменов сервиса" in e for e in errs_unrel), errs_unrel)

        svc.domains = ["console.example", "stun.console.example"]
        svc.exclude_domains = ["stun.console.example"]
        errs_dup, _ = generate.validate(synth, primary_ip="153.80.200.170")
        self.assertTrue(any("одновременно указан в domains" in e for e in errs_dup), errs_dup)

    def test_pro_regions_parsed_and_exported(self):
        doc = generate.parse(str(ROOT / "services.yaml"))
        errors, _ = generate.validate(doc, primary_ip="153.80.200.170")
        self.assertEqual(errors, [])

        for raw_json in (
            generate.pro_nodes_json(doc),
            generate.pro_policy_map_json(doc),
        ):
            payload = json.loads(raw_json)
            self.assertIn("regions", payload)
            self.assertEqual(payload["regions"]["eu"]["name"], "Европа")
            self.assertNotIn("probe_timeout", payload["regions"]["eu"])
            self.assertEqual(payload["regions"]["us"]["name"], "США")
            self.assertEqual(payload["regions"]["us"]["probe_timeout"], 6.0)
            self.assertEqual(payload["regions"]["us"]["fail_threshold"], 4)
            self.assertEqual(payload["regions"]["us"]["rise_threshold"], 2)
            by_name = {w["name"]: w for w in payload["workers"]}
            for w in doc.pro.workers:
                self.assertEqual(by_name[w.name].get("region"), w.region)
                self.assertEqual(by_name[w.name]["ip"], w.ip)

        self.assertTrue(any(w.region == "eu" for w in doc.pro.workers))
        self.assertTrue(any(w.region == "us" for w in doc.pro.workers))

        site = json.loads(generate.services_json(doc, "153.80.200.170"))
        self.assertIn("regions", site["pro"])
        self.assertEqual(site["pro"]["regions"]["us"]["name"], "США")
        site_workers = {w["name"]: w for w in site["pro"]["workers"]}
        for w in doc.pro.workers:
            self.assertEqual(site_workers[w.name].get("region"), w.region)

    def test_worker_as_dict_region_optional(self):
        w_no = generate.WorkerNode("1.2.3.4", "w1")
        self.assertNotIn("region", w_no.as_dict())
        self.assertNotIn("region", w_no.as_dict(with_ssh=False))
        w_reg = generate.WorkerNode("1.2.3.4", "w1", region="us")
        self.assertEqual(w_reg.as_dict()["region"], "us")
        self.assertEqual(w_reg.as_dict(with_ssh=False)["region"], "us")

    def test_validate_regions_errors(self):
        # Воркер указывает region без объявленной секции regions
        c1 = generate.Cluster()
        c1.workers.append(generate.WorkerNode("198.51.100.1", "w1", region="us"))
        errs, warns = [], []
        generate._validate_cluster(c1, "pro", set(), errs, warns)
        self.assertTrue(any("секция regions не объявлена" in e for e in errs), errs)

        # Воркер ссылается на неизвестный регион
        c2 = generate.Cluster()
        c2.regions["eu"] = generate.Region("eu", "Европа")
        c2.workers.append(generate.WorkerNode("198.51.100.1", "w1", region="jp"))
        errs, warns = [], []
        generate._validate_cluster(c2, "pro", set(), errs, warns)
        self.assertTrue(any("неизвестный регион" in e for e in errs), errs)

        # Невалидный код региона и пустое название
        c3 = generate.Cluster()
        c3.regions["BAD-CODE!"] = generate.Region("BAD-CODE!", "")
        c3.workers.append(generate.WorkerNode("198.51.100.1", "w1"))
        errs, warns = [], []
        generate._validate_cluster(c3, "pro", set(), errs, warns)
        self.assertTrue(any("код региона" in e for e in errs), errs)
        self.assertTrue(any("название (name)" in e for e in errs), errs)

        # Невалидные probe_timeout / fail_threshold / rise_threshold у региона
        c4 = generate.Cluster()
        c4.regions["us"] = generate.Region("us", "США", probe_timeout=0.0, fail_threshold=0, rise_threshold=0)
        c4.workers.append(generate.WorkerNode("198.51.100.1", "w1", region="us"))
        errs, warns = [], []
        generate._validate_cluster(c4, "pro", set(), errs, warns)
        self.assertTrue(any("probe_timeout" in e for e in errs), errs)
        self.assertTrue(any("fail_threshold" in e for e in errs), errs)
        self.assertTrue(any("rise_threshold" in e for e in errs), errs)


if __name__ == "__main__":
    unittest.main()
