import json
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

import stats_collector  # noqa: E402


class StatsCollectorRoleOutputTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.service_map = self.tmp / "service-map.json"
        self.service_map.write_text(
            json.dumps({"claude.ai": {"service": "Claude", "category": "AI", "pool": "ai"}}),
            encoding="utf-8",
        )
        self.cluster_cfg = self.tmp / "cluster-nodes.json"
        self.cluster_cfg.write_text(
            json.dumps({"primary": "153.80.200.170", "domain": "free.pereval.top", "workers": []}),
            encoding="utf-8",
        )
        self.sni_log = self.tmp / "sni.log"
        self.http_log = self.tmp / "http.log"
        self.http_log.write_text("", encoding="utf-8")
        self.ts = stats_collector.parse_nginx_time("03/Nov/2026:19:55:12 +0000")
        self.sni_log.write_text(
            f'1.2.3.4 [03/Nov/2026:19:55:12 +0000] sni="claude.ai" up=104.18.0.1:443 status=200 sent=1200 recv=300 dur=0.120\n',
            encoding="utf-8",
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_worker_role_writes_only_node_stats_not_stats_json(self):
        out_path = self.tmp / "stats.json"
        node_out = self.tmp / "node-stats.json"
        collector = stats_collector.StatsCollector(
            service_map_path=self.service_map,
            sni_log_path=self.sni_log,
            http_log_path=self.http_log,
            output_path=out_path,
            node_output_path=node_out,
            cluster_config_path=self.cluster_cfg,
            role="worker",
        )
        try:
            collector.bootstrap_logs({}, now=self.ts + 5)
            collector.tick(now=self.ts + 5)
            payload = collector.write_output(now=self.ts + 5)
        finally:
            if collector.sni_tailer:
                collector.sni_tailer.close()
            if collector.http_tailer:
                collector.http_tailer.close()

        self.assertIsNone(payload)
        self.assertTrue(node_out.is_file())
        self.assertFalse(out_path.exists())

    def test_primary_role_writes_both_node_stats_and_stats_json(self):
        out_path = self.tmp / "stats.json"
        node_out = self.tmp / "node-stats.json"
        collector = stats_collector.StatsCollector(
            service_map_path=self.service_map,
            sni_log_path=self.sni_log,
            http_log_path=self.http_log,
            output_path=out_path,
            node_output_path=node_out,
            cluster_config_path=self.cluster_cfg,
            role="primary",
        )
        try:
            collector.bootstrap_logs({}, now=self.ts + 5)
            collector.tick(now=self.ts + 5)
            payload = collector.write_output(now=self.ts + 5)
        finally:
            if collector.sni_tailer:
                collector.sni_tailer.close()
            if collector.http_tailer:
                collector.http_tailer.close()

        self.assertIsNotNone(payload)
        self.assertTrue(node_out.is_file())
        self.assertTrue(out_path.is_file())


if __name__ == "__main__":
    unittest.main()
