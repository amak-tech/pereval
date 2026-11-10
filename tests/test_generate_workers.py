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


if __name__ == "__main__":
    unittest.main()
