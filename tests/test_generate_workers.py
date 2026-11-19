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


if __name__ == "__main__":
    unittest.main()
