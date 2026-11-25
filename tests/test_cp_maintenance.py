"""Tests for CP log/backup/file cleanup scripts (setup-host-maintenance.sh & backup-loop.sh)."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETUP_SH = ROOT / "web" / "deploy" / "setup-host-maintenance.sh"
BACKUP_SH = ROOT / "web" / "deploy" / "backup-loop.sh"
ISSUE_CERT_SH = ROOT / "web" / "deploy" / "issue-cert.sh"
WEB_WORKFLOW = ROOT / ".github" / "workflows" / "web.yml"


def set_age_seconds(path: Path, seconds_ago: int) -> None:
    ts = time.time() - seconds_ago
    os.utime(path, (ts, ts))


class CpHostMaintenanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.pereval_dir = self.base / "opt" / "pereval"
        self.backup_dir = self.base / "var" / "backups" / "pereval"
        self.var_log_dir = self.base / "var" / "log"
        self.journald_d = self.base / "etc" / "systemd" / "journald.conf.d"
        self.docker_dir = self.base / "etc" / "docker"
        self.logrotate_d = self.base / "etc" / "logrotate.d"
        self.systemd_dir = self.base / "etc" / "systemd" / "system"
        self.cleanup_bin = self.base / "usr" / "local" / "sbin" / "pereval-cp-cleanup"
        self.bin_dir = self.base / "fake_bin"
        self.calls_log = self.base / "calls.log"

        for d in (self.pereval_dir, self.backup_dir, self.var_log_dir, self.docker_dir, self.bin_dir):
            d.mkdir(parents=True, exist_ok=True)

        for tool in ("systemctl", "journalctl", "docker", "apt-get", "systemd-tmpfiles", "logrotate"):
            script = self.bin_dir / tool
            script.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s %s\\n' '{tool}' "$*" >> '{self.calls_log}'
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            script.chmod(script.stat().st_mode | stat.S_IXUSR)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def base_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin_dir}:{env.get('PATH', '')}",
                "PEREVAL_DIR": str(self.pereval_dir),
                "BACKUP_DIR": str(self.backup_dir),
                "VAR_LOG_DIR": str(self.var_log_dir),
                "JOURNALD_CONF_D": str(self.journald_d),
                "DOCKER_DAEMON_JSON": str(self.docker_dir / "daemon.json"),
                "LOGROTATE_D": str(self.logrotate_d),
                "CLEANUP_BIN": str(self.cleanup_bin),
                "SYSTEMD_UNIT_DIR": str(self.systemd_dir),
                "SYSTEMCTL_BIN": str(self.bin_dir / "systemctl"),
                "JOURNALCTL_BIN": str(self.bin_dir / "journalctl"),
                "PYTHON_BIN": sys.executable,
            }
        )
        return env

    def calls(self) -> list[str]:
        if not self.calls_log.exists():
            return []
        return self.calls_log.read_text(encoding="utf-8").splitlines()

    def test_shell_syntax_and_workflow_prune(self) -> None:
        for script in (SETUP_SH, ISSUE_CERT_SH):
            res = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, msg=f"{script}: {res.stderr}")
        res_sh = subprocess.run(["sh", "-n", str(BACKUP_SH)], capture_output=True, text=True)
        self.assertEqual(res_sh.returncode, 0, msg=res_sh.stderr)

        wf = WEB_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("setup-host-maintenance.sh", wf)
        self.assertIn("docker image prune -af", wf)

    def test_configures_journald_docker_logrotate_and_is_idempotent(self) -> None:
        daemon_json = self.docker_dir / "daemon.json"
        daemon_json.write_text(json.dumps({"live-restore": True}), encoding="utf-8")

        res1 = subprocess.run(["bash", str(SETUP_SH)], env=self.base_env(), capture_output=True, text=True)
        self.assertEqual(res1.returncode, 0, msg=res1.stderr)

        journal_txt = (self.journald_d / "pereval.conf").read_text(encoding="utf-8")
        self.assertIn("SystemMaxUse=200M", journal_txt)
        self.assertIn("MaxRetentionSec=14day", journal_txt)
        self.assertIn("Compress=yes", journal_txt)

        parsed_daemon = json.loads(daemon_json.read_text(encoding="utf-8"))
        self.assertTrue(parsed_daemon["live-restore"])
        self.assertEqual(parsed_daemon["log-driver"], "json-file")
        self.assertEqual(
            parsed_daemon["log-opts"],
            {"max-size": "10m", "max-file": "5", "compress": "true"},
        )

        logrotate_txt = (self.logrotate_d / "pereval-cp").read_text(encoding="utf-8")
        self.assertIn("rotate 14", logrotate_txt)
        self.assertIn("compress", logrotate_txt)

        self.assertTrue((self.systemd_dir / "pereval-cp-cleanup.service").exists())
        self.assertTrue((self.systemd_dir / "pereval-cp-cleanup.timer").exists())
        self.assertTrue(self.cleanup_bin.exists())

        calls1 = self.calls()
        self.assertTrue(any("systemctl restart systemd-journald" in c for c in calls1))
        self.assertTrue(any("systemctl reload docker" in c for c in calls1))

        # Second run must not restart journald or reload docker when nothing changed
        self.calls_log.unlink()
        res2 = subprocess.run(["bash", str(SETUP_SH)], env=self.base_env(), capture_output=True, text=True)
        self.assertEqual(res2.returncode, 0, msg=res2.stderr)
        calls2 = self.calls()
        self.assertFalse(any("systemctl restart systemd-journald" in c for c in calls2))
        self.assertFalse(any("systemctl reload docker" in c for c in calls2))

    def test_cleanup_removes_expired_logs_backups_temp_and_docker_images(self) -> None:
        (self.pereval_dir / ".env").write_text("BACKUP_KEEP_DAYS=7\nBACKUP_MAX_FILES=3\n", encoding="utf-8")
        subprocess.run(["bash", str(SETUP_SH)], env=self.base_env(), check=True, capture_output=True, text=True)

        # Old rotated log vs fresh rotated log
        old_gz = self.var_log_dir / "syslog.2.gz"
        fresh_gz = self.var_log_dir / "syslog.1.gz"
        old_gz.write_text("old", encoding="utf-8")
        fresh_gz.write_text("fresh", encoding="utf-8")
        set_age_seconds(old_gz, 16 * 86400)
        set_age_seconds(fresh_gz, 2 * 86400)

        # Backups: 1 stale tmp, 1 older than 7 days, and 4 recent (exceeding BACKUP_MAX_FILES=3)
        stale_tmp = self.backup_dir / "pereval-20260101-000000.dump.tmp"
        stale_tmp.write_text("partial", encoding="utf-8")
        set_age_seconds(stale_tmp, 3 * 3600)

        old_dump = self.backup_dir / "pereval-20260101-000000.dump"
        old_dump.write_text("old", encoding="utf-8")
        set_age_seconds(old_dump, 9 * 86400)

        recent_dumps = []
        for idx in range(4):
            p = self.backup_dir / f"pereval-2026112{idx}-000000.dump"
            p.write_text(f"dump-{idx}", encoding="utf-8")
            set_age_seconds(p, (idx + 1) * 3600)
            recent_dumps.append(p)

        # DNS-01 and .env.tmp files
        dns01 = self.pereval_dir / "dns01"
        dns01.mkdir(parents=True, exist_ok=True)
        old_records = dns01 / "records.txt"
        old_records.write_text("_acme-challenge.pereval.top abc\n", encoding="utf-8")
        set_age_seconds(old_records, 4 * 86400)

        stale_env_tmp = self.pereval_dir / ".env.tmp"
        stale_env_tmp.write_text("SECRET=1\n", encoding="utf-8")
        set_age_seconds(stale_env_tmp, 2 * 3600)

        self.calls_log.unlink(missing_ok=True)
        res = subprocess.run(
            ["bash", str(self.cleanup_bin), "--scheduled"],
            env=self.base_env(),
            capture_output=True,
            text=True,
        )
        self.assertEqual(res.returncode, 0, msg=res.stderr)

        self.assertFalse(old_gz.exists())
        self.assertTrue(fresh_gz.exists())
        self.assertFalse(stale_tmp.exists())
        self.assertFalse(old_dump.exists())
        self.assertFalse(old_records.exists())
        self.assertFalse(stale_env_tmp.exists())

        # Out of 4 recent dumps, newest 3 remain and oldest (idx=3) is pruned by BACKUP_MAX_FILES=3
        self.assertTrue(recent_dumps[0].exists())
        self.assertTrue(recent_dumps[1].exists())
        self.assertTrue(recent_dumps[2].exists())
        self.assertFalse(recent_dumps[3].exists())

        calls = self.calls()
        self.assertTrue(any("docker image prune -af --filter until=24h" in c for c in calls))
        self.assertTrue(any("docker container prune -f --filter until=24h" in c for c in calls))


class BackupLoopScriptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.backups = self.base / "backups"
        self.backups.mkdir()
        self.dump_calls = self.base / "pg_dump.calls"
        self.fake_pg_dump = self.base / "fake_pg_dump.sh"
        self.fake_pg_dump.write_text(
            textwrap.dedent(
                f"""\
                #!/bin/sh
                out=""
                while [ "$#" -gt 0 ]; do
                  if [ "$1" = "-f" ]; then
                    out="$2"
                    shift 2
                  else
                    shift
                  fi
                done
                echo "dump" >> '{self.dump_calls}'
                printf 'PGDMP-DATA' > "$out"
                """
            ),
            encoding="utf-8",
        )
        self.fake_pg_dump.chmod(self.fake_pg_dump.stat().st_mode | stat.S_IXUSR)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_once(self, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "BACKUP_DIR": str(self.backups),
                "BACKUP_KEEP_DAYS": "14",
                "BACKUP_MAX_FILES": "3",
                "BACKUP_ONCE": "1",
                "PG_DUMP_BIN": str(self.fake_pg_dump),
            }
        )
        if extra_env:
            env.update(extra_env)
        return subprocess.run(["sh", str(BACKUP_SH)], env=env, capture_output=True, text=True)

    def test_creates_dump_skips_restart_duplicate_and_prunes(self) -> None:
        orphan = self.backups / "pereval-20260101-000000.dump.tmp"
        orphan.write_text("partial", encoding="utf-8")

        expired = self.backups / "pereval-20260102-000000.dump"
        expired.write_text("expired", encoding="utf-8")
        set_age_seconds(expired, 16 * 86400)

        # First run: creates new dump and deletes orphan + expired dump
        res1 = self.run_once()
        self.assertEqual(res1.returncode, 0, msg=res1.stderr)
        self.assertFalse(orphan.exists())
        self.assertFalse(expired.exists())
        dumps = list(self.backups.glob("pereval-*.dump"))
        self.assertEqual(len(dumps), 1)
        self.assertEqual(len(self.dump_calls.read_text(encoding="utf-8").splitlines()), 1)

        # Immediate second run (container restart): skips duplicate pg_dump since fresh dump exists
        res2 = self.run_once()
        self.assertEqual(res2.returncode, 0, msg=res2.stderr)
        self.assertIn("свежий дамп уже есть", res2.stdout)
        self.assertEqual(len(self.dump_calls.read_text(encoding="utf-8").splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
