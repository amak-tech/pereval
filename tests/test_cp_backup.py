"""Tests for Control Plane S3 backup, rotation, restore, and timer maintenance."""

from __future__ import annotations

import datetime as dt
import http.server
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import threading
import unittest
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CP_BACKUP_PY = ROOT / "web" / "deploy" / "cp_backup.py"
SETUP_SH = ROOT / "web" / "deploy" / "setup-host-maintenance.sh"
WEB_WORKFLOW = ROOT / ".github" / "workflows" / "web.yml"
RESTORE_WORKFLOW = ROOT / ".github" / "workflows" / "cp-restore.yml"

sys.path.insert(0, str(CP_BACKUP_PY.parent))
import cp_backup  # noqa: E402


class MockS3State:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.requests: list[tuple[str, str, str]] = []


class MockS3Handler(http.server.BaseHTTPRequestHandler):
    state: MockS3State

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        auth = self.headers.get("Authorization", "")
        self.state.requests.append(("GET", parsed.path, auth))
        qs = urllib.parse.parse_qs(parsed.query)

        if qs.get("list-type") == ["2"]:
            prefix = qs.get("prefix", [""])[0]
            parts = parsed.path.lstrip("/").split("/", 1)
            bucket = parts[0] if parts else ""
            root = ET.Element("ListBucketResult")
            ET.SubElement(root, "Name").text = bucket
            ET.SubElement(root, "IsTruncated").text = "false"
            for key in sorted(self.state.objects.keys()):
                if prefix and not key.startswith(prefix):
                    continue
                c = ET.SubElement(root, "Contents")
                ET.SubElement(c, "Key").text = key
                ET.SubElement(c, "LastModified").text = "2026-11-26T00:00:00.000Z"
                ET.SubElement(c, "Size").text = str(len(self.state.objects[key]))
            body = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            self.send_response(200)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # GetObject: /<bucket>/<key>
        parts = parsed.path.lstrip("/").split("/", 1)
        key = parts[1] if len(parts) > 1 else ""
        if key not in self.state.objects:
            self.send_response(404)
            self.end_headers()
            return
        data = self.state.objects[key]
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        auth = self.headers.get("Authorization", "")
        self.state.requests.append(("PUT", parsed.path, auth))
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        parts = parsed.path.lstrip("/").split("/", 1)
        key = parts[1] if len(parts) > 1 else ""
        self.state.objects[key] = body
        self.send_response(200)
        self.end_headers()

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        auth = self.headers.get("Authorization", "")
        self.state.requests.append(("DELETE", parsed.path, auth))
        parts = parsed.path.lstrip("/").split("/", 1)
        key = parts[1] if len(parts) > 1 else ""
        self.state.objects.pop(key, None)
        self.send_response(204)
        self.end_headers()


class CpBackupTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.pereval_dir = self.base / "opt" / "pereval"
        self.backup_dir = self.base / "var" / "backups" / "pereval"
        self.le_dir = self.base / "letsencrypt"
        self.pereval_dir.mkdir(parents=True, exist_ok=True)
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        self.le_dir.mkdir(parents=True, exist_ok=True)

        self.s3_state = MockS3State()

        class BoundHandler(MockS3Handler):
            state = self.s3_state

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), BoundHandler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def _write_sample_env(self, with_s3: bool = True) -> Path:
        env_path = self.pereval_dir / ".env"
        lines = [
            "POSTGRES_PASSWORD=SecretPass123",
            "BACKUP_KEEP_COUNT=7",
            f"LETSENCRYPT_DIR={self.le_dir}",
            "CP_BACKUP_PG_DUMP_CMD=printf 'PGDMP-TEST-DATA'",
        ]
        if with_s3:
            lines += [
                f"S3_ENDPOINT=http://127.0.0.1:{self.port}",
                "S3_BUCKET=pereval-backups",
                "S3_REGION=us-east-1",
                "S3_ACCESS_KEY_ID=test-access",
                "S3_SECRET_ACCESS_KEY=test-secret",
                "S3_PREFIX=cp-backups",
                "S3_PATH_STYLE=true",
            ]
        env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        (self.pereval_dir / ".image.env").write_text("APP_IMAGE=ghcr.io/amak-tech/pereval-web:abc123\n", encoding="utf-8")
        return env_path

    def test_py_compile(self) -> None:
        res = subprocess.run([sys.executable, "-m", "py_compile", str(CP_BACKUP_PY)], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, msg=res.stderr)

    def test_backup_archive_contents_and_log_exclusion(self) -> None:
        self._write_sample_env(with_s3=True)

        # Files that MUST be excluded
        (self.pereval_dir / "deploy.log").write_text("secret log", encoding="utf-8")
        (self.pereval_dir / ".env.tmp.123").write_text("tmp", encoding="utf-8")
        (self.pereval_dir / "compose.yaml").write_text("services: {}", encoding="utf-8")
        dns01 = self.pereval_dir / "dns01"
        dns01.mkdir(parents=True, exist_ok=True)
        (dns01 / "issue.log").write_text("certbot log", encoding="utf-8")
        (dns01 / "records.txt").write_text("_acme txt", encoding="utf-8")

        le_live = self.le_dir / "live" / "pereval.top"
        le_live.mkdir(parents=True, exist_ok=True)
        (le_live / "fullchain.pem").write_text("CERT-PEM", encoding="utf-8")
        (le_live / "privkey.pem").write_text("KEY-PEM", encoding="utf-8")
        le_log = self.le_dir / "log"
        le_log.mkdir(parents=True, exist_ok=True)
        (le_log / "letsencrypt.log").write_text("le log", encoding="utf-8")

        rc = cp_backup.main([
            "--pereval-dir", str(self.pereval_dir),
            "--backup-dir", str(self.backup_dir),
            "backup",
        ])
        self.assertEqual(rc, 0)

        archives = list(self.backup_dir.glob("pereval-cp-*.tar.gz"))
        self.assertEqual(len(archives), 1)
        with tarfile.open(archives[0], "r:gz") as tf:
            names = [m.name.lstrip("./") for m in tf.getmembers()]

        self.assertIn("db.dump", names)
        self.assertIn("opt-pereval/.env", names)
        self.assertIn("opt-pereval/.image.env", names)
        self.assertIn("letsencrypt/live/pereval.top/fullchain.pem", names)
        self.assertIn("letsencrypt/live/pereval.top/privkey.pem", names)

        for forbidden in names:
            self.assertFalse(forbidden.endswith(".log"), msg=f"log leaked: {forbidden}")
            self.assertNotIn("dns01/", forbidden)
            self.assertNotIn(".tmp", forbidden)
            self.assertNotIn("letsencrypt/log", forbidden)
            self.assertNotIn("compose.yaml", forbidden)

        # Verify uploaded to mock S3 with SigV4 header
        self.assertEqual(len(self.s3_state.objects), 1)
        put_reqs = [r for r in self.s3_state.requests if r[0] == "PUT"]
        self.assertEqual(len(put_reqs), 1)
        self.assertTrue(put_reqs[0][2].startswith("AWS4-HMAC-SHA256 "))

    def test_rotation_keeps_7_locally_and_in_s3(self) -> None:
        self._write_sample_env(with_s3=True)
        (self.le_dir / "renewal.conf").write_text("ok", encoding="utf-8")

        # Seed 8 older local and S3 backups
        base_dt = dt.datetime(2026, 11, 10, 0, 0, 0, tzinfo=dt.timezone.utc)
        for i in range(8):
            ts = (base_dt + dt.timedelta(days=i)).strftime("%Y%m%d-%H%M%S")
            name = f"pereval-cp-{ts}.tar.gz"
            (self.backup_dir / name).write_bytes(b"old-archive")
            self.s3_state.objects[f"cp-backups/{name}"] = b"old-s3-archive"

        rc = cp_backup.main([
            "--pereval-dir", str(self.pereval_dir),
            "--backup-dir", str(self.backup_dir),
            "backup",
        ])
        self.assertEqual(rc, 0)

        local_remaining = sorted(p.name for p in self.backup_dir.glob("pereval-cp-*.tar.gz"))
        self.assertEqual(len(local_remaining), 7)
        self.assertNotIn("pereval-cp-20261110-000000.tar.gz", local_remaining)
        self.assertNotIn("pereval-cp-20261111-000000.tar.gz", local_remaining)

        s3_remaining = sorted(self.s3_state.objects.keys())
        self.assertEqual(len(s3_remaining), 7)
        self.assertNotIn("cp-backups/pereval-cp-20261110-000000.tar.gz", s3_remaining)
        self.assertNotIn("cp-backups/pereval-cp-20261111-000000.tar.gz", s3_remaining)

    def test_backup_without_s3_credentials_succeeds_locally(self) -> None:
        self._write_sample_env(with_s3=False)
        rc = cp_backup.main([
            "--pereval-dir", str(self.pereval_dir),
            "--backup-dir", str(self.backup_dir),
            "backup",
        ])
        self.assertEqual(rc, 0)
        self.assertEqual(len(list(self.backup_dir.glob("pereval-cp-*.tar.gz"))), 1)
        self.assertEqual(len(self.s3_state.objects), 0)

    def test_restore_latest_and_specific_and_empty_bucket_error(self) -> None:
        env_path = self._write_sample_env(with_s3=True)

        # Empty bucket must fail cleanly
        with self.assertRaises(RuntimeError):
            cp_backup.cmd_restore(
                pereval_dir=self.pereval_dir,
                backup_dir=self.backup_dir,
                env_file=env_path,
                backup_name="latest",
                skip_compose=True,
            )

        # Create a real backup in S3
        (self.le_dir / "cert.pem").write_text("ORIGINAL-CERT", encoding="utf-8")
        cp_backup.main([
            "--pereval-dir", str(self.pereval_dir),
            "--backup-dir", str(self.backup_dir),
            "backup",
        ])
        backup_name = next(iter(self.s3_state.objects.keys())).split("/")[-1]

        # Wipe local state before restore
        (self.le_dir / "cert.pem").write_text("CORRUPTED", encoding="utf-8")
        (self.pereval_dir / ".image.env").unlink()
        restored_db_out = self.base / "restored_db.bin"

        old_restore_cmd = os.environ.get("CP_BACKUP_PG_RESTORE_CMD")
        os.environ["CP_BACKUP_PG_RESTORE_CMD"] = f"cat > '{restored_db_out}'"
        try:
            rc = cp_backup.main([
                "--pereval-dir", str(self.pereval_dir),
                "--backup-dir", str(self.backup_dir),
                "restore",
                "--backup", backup_name,
                "--skip-compose",
            ])
        finally:
            if old_restore_cmd is None:
                os.environ.pop("CP_BACKUP_PG_RESTORE_CMD", None)
            else:
                os.environ["CP_BACKUP_PG_RESTORE_CMD"] = old_restore_cmd

        self.assertEqual(rc, 0)
        self.assertEqual((self.le_dir / "cert.pem").read_text(encoding="utf-8"), "ORIGINAL-CERT")
        self.assertTrue((self.pereval_dir / ".image.env").is_file())
        self.assertEqual(restored_db_out.read_bytes(), b"PGDMP-TEST-DATA")


class CpTimerAndWorkflowTest(unittest.TestCase):
    def test_setup_host_maintenance_enables_stopped_backup_timer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            pereval_dir = base / "opt" / "pereval"
            backup_dir = base / "var" / "backups" / "pereval"
            var_log_dir = base / "var" / "log"
            journald_d = base / "etc" / "systemd" / "journald.conf.d"
            docker_dir = base / "etc" / "docker"
            logrotate_d = base / "etc" / "logrotate.d"
            systemd_dir = base / "etc" / "systemd" / "system"
            cleanup_bin = base / "usr" / "local" / "sbin" / "pereval-cp-cleanup"
            backup_bin = base / "usr" / "local" / "sbin" / "pereval-cp-backup"
            bin_dir = base / "fake_bin"
            calls_log = base / "calls.log"

            for d in (pereval_dir, backup_dir, var_log_dir, docker_dir, bin_dir):
                d.mkdir(parents=True, exist_ok=True)

            systemctl = bin_dir / "systemctl"
            systemctl.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf 'systemctl %s\\n' "$*" >> '{calls_log}'
                    if [ "$1" = "is-active" ] && [ "$2" = "pereval-cp-backup.timer" ]; then
                      exit 3
                    fi
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            systemctl.chmod(systemctl.stat().st_mode | stat.S_IXUSR)

            for tool in ("journalctl", "docker", "apt-get", "systemd-tmpfiles", "logrotate"):
                p = bin_dir / tool
                p.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                p.chmod(p.stat().st_mode | stat.S_IXUSR)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{bin_dir}:{env.get('PATH', '')}",
                    "PEREVAL_DIR": str(pereval_dir),
                    "BACKUP_DIR": str(backup_dir),
                    "VAR_LOG_DIR": str(var_log_dir),
                    "JOURNALD_CONF_D": str(journald_d),
                    "DOCKER_DAEMON_JSON": str(docker_dir / "daemon.json"),
                    "LOGROTATE_D": str(logrotate_d),
                    "CLEANUP_BIN": str(cleanup_bin),
                    "BACKUP_BIN": str(backup_bin),
                    "SYSTEMD_UNIT_DIR": str(systemd_dir),
                    "SYSTEMCTL_BIN": str(systemctl),
                    "JOURNALCTL_BIN": str(bin_dir / "journalctl"),
                    "PYTHON_BIN": sys.executable,
                    "PEREVAL_FORCE_SYSTEMCTL": "1",
                }
            )
            res = subprocess.run(["bash", str(SETUP_SH)], env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, msg=res.stderr)

            self.assertTrue((systemd_dir / "pereval-cp-backup.service").exists())
            self.assertTrue((systemd_dir / "pereval-cp-backup.timer").exists())
            self.assertTrue(backup_bin.exists())

            calls = calls_log.read_text(encoding="utf-8").splitlines()
            self.assertIn("systemctl is-enabled pereval-cp-backup.timer", calls)
            self.assertIn("systemctl is-active pereval-cp-backup.timer", calls)
            self.assertIn("systemctl enable --now pereval-cp-backup.timer", calls)

    def test_workflows_contain_s3_sync_timer_check_and_restore_inputs(self) -> None:
        web_wf = WEB_WORKFLOW.read_text(encoding="utf-8")
        for key in (
            "SYNC_S3_ENDPOINT",
            "SYNC_S3_BUCKET",
            "SYNC_S3_REGION",
            "SYNC_S3_ACCESS_KEY_ID",
            "SYNC_S3_SECRET_ACCESS_KEY",
            "SYNC_S3_PREFIX",
            "SYNC_S3_PATH_STYLE",
            "pereval-cp-backup.timer",
        ):
            self.assertIn(key, web_wf)

        restore_wf = RESTORE_WORKFLOW.read_text(encoding="utf-8")
        for key in ("workflow_dispatch", "confirm_restore", "backup_name", "cp_backup.py", "healthz"):
            self.assertIn(key, restore_wf)

        try:
            import yaml  # type: ignore
        except ImportError:
            yaml = None
        if yaml is not None:
            yaml.safe_load(web_wf)
            yaml.safe_load(restore_wf)


if __name__ == "__main__":
    unittest.main()
