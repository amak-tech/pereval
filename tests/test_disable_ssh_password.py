"""Tests for src/disable-ssh-password.sh."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "src" / "disable-ssh-password.sh"
DEPLOY_SH = ROOT / "deploy.sh"

FAKE_SSHD_PY = textwrap.dedent(
    """\
    #!{python}
    import glob
    import os
    import re
    import sys
    from pathlib import Path

    args = sys.argv[1:]
    cfg_path = None
    mode = None
    i = 0
    while i < len(args):
        if args[i] == "-f" and i + 1 < len(args):
            cfg_path = args[i + 1]
            i += 2
        elif args[i] in ("-t", "-T"):
            mode = args[i]
            i += 1
        elif args[i] == "-C" and i + 1 < len(args):
            i += 2
        else:
            i += 1

    if not cfg_path or not mode:
        sys.exit(2)

    legacy = os.environ.get("FAKE_SSHD_LEGACY", "0") == "1"
    fail_test = os.environ.get("FAKE_SSHD_FAIL_T", "0") == "1"

    effective = {{}}

    def parse_file(path: Path):
        in_match = False
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^([A-Za-z0-9_]+)(?:\\s+|=)(.+)$", line)
            if not m:
                sys.stderr.write(f"Bad configuration option: {{line}}\\n")
                sys.exit(255)
            key = m.group(1).lower()
            val = m.group(2).strip()
            if key == "match":
                in_match = True
                continue
            if in_match:
                continue
            if key == "include":
                for pattern in val.split():
                    for inc in sorted(glob.glob(pattern)):
                        parse_file(Path(inc))
                continue
            if key == "kbdinteractiveauthentication" and legacy:
                sys.stderr.write("Unsupported option KbdInteractiveAuthentication\\n")
                sys.exit(255)
            if key == "challengeresponseauthentication" and not legacy:
                key = "kbdinteractiveauthentication"
            # OpenSSH first-match-wins semantics
            if key not in effective:
                effective[key] = val.lower()

    parse_file(Path(cfg_path))

    if mode == "-t":
        if fail_test:
            sys.stderr.write("Simulated sshd -t failure\\n")
            sys.exit(255)
        sys.exit(0)

    # Defaults matching OpenSSH
    effective.setdefault("passwordauthentication", "yes")
    effective.setdefault("pubkeyauthentication", "yes")
    effective.setdefault("permitemptypasswords", "no")
    if legacy:
        effective.setdefault("challengeresponseauthentication", "no")
    else:
        effective.setdefault("kbdinteractiveauthentication", "no")

    for k, v in sorted(effective.items()):
        print(f"{{k}} {{v}}")
    """
)


class DisableSshPasswordTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.ssh_dir = self.base / "ssh"
        self.conf_d = self.ssh_dir / "sshd_config.d"
        self.conf_d.mkdir(parents=True)
        self.sshd_config = self.ssh_dir / "sshd_config"
        self.dropin = self.conf_d / "00-pereval-no-password.conf"
        self.reload_log = self.base / "reloads.log"

        self.fake_sshd = self.base / "fake_sshd"
        self.fake_sshd.write_text(
            FAKE_SSHD_PY.format(python=sys.executable), encoding="utf-8"
        )
        self.fake_sshd.chmod(self.fake_sshd.stat().st_mode | stat.S_IXUSR)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_script(
        self, extra_env: dict[str, str] | None = None, reload_cmd: str | None = None
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "SSHD_BIN": str(self.fake_sshd),
                "SSHD_CONFIG": str(self.sshd_config),
                "SSHD_CONFIG_D": str(self.conf_d),
                "DROPIN_FILE": str(self.dropin),
                "RELOAD_CMD": reload_cmd
                if reload_cmd is not None
                else f"echo reload >> '{self.reload_log}'",
            }
        )
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            ["bash", str(SCRIPT)],
            env=env,
            capture_output=True,
            text=True,
        )

    def reload_count(self) -> int:
        if not self.reload_log.exists():
            return 0
        return len(self.reload_log.read_text(encoding="utf-8").splitlines())

    def test_bash_syntax(self) -> None:
        for path in (SCRIPT, DEPLOY_SH):
            res = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, msg=f"{path}: {res.stderr}")

    def test_noop_when_already_disabled(self) -> None:
        self.sshd_config.write_text(
            f"Include {self.conf_d}/*.conf\n"
            "PasswordAuthentication no\n"
            "KbdInteractiveAuthentication no\n",
            encoding="utf-8",
        )
        before = self.sshd_config.read_text(encoding="utf-8")
        res = self.run_script()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertIn("уже отключена", res.stdout)
        self.assertEqual(self.reload_count(), 0)
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.sshd_config.read_text(encoding="utf-8"), before)

    def test_cloud_init_dropin_overridden_and_idempotent(self) -> None:
        self.sshd_config.write_text(
            f"Include {self.conf_d}/*.conf\n"
            "UsePAM yes\n",
            encoding="utf-8",
        )
        (self.conf_d / "50-cloud-init.conf").write_text(
            "PasswordAuthentication yes\n", encoding="utf-8"
        )
        orig_main = self.sshd_config.read_text(encoding="utf-8")

        res = self.run_script()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertIn("отключена", res.stdout)
        self.assertEqual(self.reload_count(), 1)
        self.assertTrue(self.dropin.exists())
        self.assertIn("PasswordAuthentication no", self.dropin.read_text(encoding="utf-8"))
        self.assertIn("KbdInteractiveAuthentication no", self.dropin.read_text(encoding="utf-8"))
        # Main sshd_config should stay untouched when drop-in suffices.
        self.assertEqual(self.sshd_config.read_text(encoding="utf-8"), orig_main)

        # Second run must be a no-op with no extra reload.
        res2 = self.run_script()
        self.assertEqual(res2.returncode, 0, msg=res2.stderr)
        self.assertIn("уже отключена", res2.stdout)
        self.assertEqual(self.reload_count(), 1)

    def test_directive_before_include_in_main_config(self) -> None:
        self.sshd_config.write_text(
            "PasswordAuthentication yes\n"
            f"Include {self.conf_d}/*.conf\n",
            encoding="utf-8",
        )
        res = self.run_script()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertEqual(self.reload_count(), 1)
        main_txt = self.sshd_config.read_text(encoding="utf-8")
        self.assertIn("PasswordAuthentication no", main_txt)
        self.assertIn("# [pereval-disabled] PasswordAuthentication yes", main_txt)

        res2 = self.run_script()
        self.assertEqual(res2.returncode, 0, msg=res2.stderr)
        self.assertIn("уже отключена", res2.stdout)
        self.assertEqual(self.reload_count(), 1)

    def test_no_include_and_match_block_preserved(self) -> None:
        self.sshd_config.write_text(
            "Port 22\n"
            "PasswordAuthentication=yes\n"
            "Match User deploy\n"
            "    AllowTcpForwarding no\n",
            encoding="utf-8",
        )
        res = self.run_script()
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertEqual(self.reload_count(), 1)
        main_txt = self.sshd_config.read_text(encoding="utf-8")
        self.assertLess(main_txt.index("PasswordAuthentication no"), main_txt.index("Match User deploy"))
        self.assertIn("AllowTcpForwarding no", main_txt)

    def test_legacy_openssh_uses_challenge_response(self) -> None:
        self.sshd_config.write_text(
            f"Include {self.conf_d}/*.conf\n"
            "UsePAM yes\n",
            encoding="utf-8",
        )
        (self.conf_d / "50-cloud-init.conf").write_text(
            "PasswordAuthentication yes\n"
            "ChallengeResponseAuthentication yes\n",
            encoding="utf-8",
        )
        res = self.run_script(extra_env={"FAKE_SSHD_LEGACY": "1"})
        self.assertEqual(res.returncode, 0, msg=res.stderr)
        self.assertEqual(self.reload_count(), 1)
        dropin_txt = self.dropin.read_text(encoding="utf-8")
        self.assertIn("ChallengeResponseAuthentication no", dropin_txt)
        self.assertNotIn("KbdInteractiveAuthentication", dropin_txt)

    def test_refuses_when_pubkey_disabled(self) -> None:
        self.sshd_config.write_text(
            "PubkeyAuthentication no\n"
            "PasswordAuthentication yes\n",
            encoding="utf-8",
        )
        orig = self.sshd_config.read_text(encoding="utf-8")
        res = self.run_script()
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("PubkeyAuthentication", res.stderr)
        self.assertEqual(self.reload_count(), 0)
        self.assertEqual(self.sshd_config.read_text(encoding="utf-8"), orig)

    def test_rollback_on_reload_failure(self) -> None:
        self.sshd_config.write_text(
            f"Include {self.conf_d}/*.conf\n",
            encoding="utf-8",
        )
        (self.conf_d / "50-cloud-init.conf").write_text(
            "PasswordAuthentication yes\n", encoding="utf-8"
        )
        orig = self.sshd_config.read_text(encoding="utf-8")
        res = self.run_script(reload_cmd="exit 1")
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.sshd_config.read_text(encoding="utf-8"), orig)


if __name__ == "__main__":
    unittest.main()
