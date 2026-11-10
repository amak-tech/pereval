# -*- coding: utf-8 -*-
import json
import os
import stat
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import dnstestutil as tu  # noqa: E402
import cert_sync  # noqa: E402

cert_sync.log = lambda msg: None


class NameMatchTests(unittest.TestCase):
    def test_exact_and_wildcard(self):
        names = ["pereval.top", "*.pereval.top", "*.pro.pereval.top", "pereval.portbuddy.tech"]
        self.assertTrue(cert_sync.name_matches("pereval.top", names))
        self.assertTrue(cert_sync.name_matches("free.pereval.top", names))
        self.assertTrue(cert_sync.name_matches("PRO.pereval.top.", names))
        self.assertTrue(cert_sync.name_matches("abcdefghij2345672345.pro.pereval.top", names))
        self.assertTrue(cert_sync.name_matches("pereval.portbuddy.tech", names))
        # wildcard покрывает ровно один уровень
        self.assertFalse(cert_sync.name_matches("a.b.pereval.top", names))
        self.assertFalse(cert_sync.name_matches("other.example", names))
        self.assertFalse(cert_sync.name_matches("pereval.top", []))


@unittest.skipUnless(tu.openssl_available(), "нужен openssl для генерации тестового сертификата")
class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tu.tmpdir())
        cert, key = tu.gen_self_signed(self.tmp / "src", cn="pereval.test",
                                       san=["pereval.test", "*.pereval.test", "*.pro.pereval.test"], days=30)
        (self.tmp / "src").mkdir(exist_ok=True)
        self.fullchain = Path(cert).read_bytes()
        self.privkey = Path(key).read_bytes()
        self.sha = cert_sync.sha256_hex(self.fullchain)
        self.out = self.tmp / "ssl"
        self.marker = self.tmp / "reloaded"

    def payload(self, **over):
        p = {"sha256": self.sha, "not_after": "2099-01-01T00:00:00Z",
             "names": ["pereval.test", "*.pereval.test", "*.pro.pereval.test"],
             "fullchain": self.fullchain.decode(), "privkey": self.privkey.decode()}
        p.update(over)
        return p

    def args(self, *extra):
        return cert_sync.parse_args([
            "--cp-origin", "https://cp.test", "--node-secret", "s3cret",
            "--out-dir", str(self.out), "--expect", "free.pereval.test",
            "--reload", "touch %s" % self.marker, *extra,
        ])

    def test_installs_and_reloads(self):
        with mock.patch.object(cert_sync, "fetch", return_value=(200, self.payload())) as f:
            self.assertEqual(cert_sync.sync(self.args()), 0)
        self.assertEqual(f.call_args[0][2], None)  # первой синхронизации нечего слать в If-None-Match
        self.assertEqual((self.out / "fullchain.pem").read_bytes(), self.fullchain)
        self.assertEqual((self.out / "privkey.pem").read_bytes(), self.privkey)
        self.assertEqual(stat.S_IMODE(os.stat(self.out / "privkey.pem").st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(os.stat(self.out / "fullchain.pem").st_mode), 0o644)
        self.assertTrue(self.marker.exists())
        state = json.loads((self.out / ".cert-sync.json").read_text())
        self.assertEqual(state["sha256"], self.sha)
        self.assertIn("*.pro.pereval.test", state["names"])

    def test_not_modified_skips_reload(self):
        with mock.patch.object(cert_sync, "fetch", return_value=(200, self.payload())):
            cert_sync.sync(self.args())
        self.marker.unlink()
        with mock.patch.object(cert_sync, "fetch", return_value=(304, None)) as f:
            self.assertEqual(cert_sync.sync(self.args()), 0)
        self.assertEqual(f.call_args[0][2], self.sha)  # шлём sha установленного сертификата
        self.assertFalse(self.marker.exists())

    def test_same_sha_in_200_is_noop(self):
        with mock.patch.object(cert_sync, "fetch", return_value=(200, self.payload())):
            cert_sync.sync(self.args())
        self.marker.unlink()
        with mock.patch.object(cert_sync, "fetch", return_value=(200, self.payload())):
            self.assertEqual(cert_sync.sync(self.args()), 0)
        self.assertFalse(self.marker.exists())

    def test_404_keeps_existing_files(self):
        self.out.mkdir()
        (self.out / "fullchain.pem").write_bytes(b"old")
        with mock.patch.object(cert_sync, "fetch", return_value=(404, None)):
            self.assertEqual(cert_sync.sync(self.args()), 0)
        self.assertEqual((self.out / "fullchain.pem").read_bytes(), b"old")
        self.assertFalse(self.marker.exists())

    def test_mismatched_key_rejected(self):
        _, other_key = tu.gen_self_signed(self.tmp / "other", cn="other.test")
        bad = self.payload(privkey=Path(other_key).read_text())
        with mock.patch.object(cert_sync, "fetch", return_value=(200, bad)):
            self.assertEqual(cert_sync.main(["--cp-origin", "https://cp.test", "--node-secret", "x",
                                             "--out-dir", str(self.out)]), 1)
        self.assertFalse((self.out / "fullchain.pem").exists())

    def test_sha_mismatch_rejected(self):
        with mock.patch.object(cert_sync, "fetch", return_value=(200, self.payload(sha256="00" * 32))):
            with self.assertRaises(RuntimeError):
                cert_sync.sync(self.args())
        self.assertFalse((self.out / "fullchain.pem").exists())

    def test_missing_expected_name_rejected(self):
        with mock.patch.object(cert_sync, "fetch", return_value=(200, self.payload())):
            with self.assertRaises(ValueError):
                cert_sync.sync(self.args("--expect", "a.b.pereval.test"))
        self.assertFalse((self.out / "fullchain.pem").exists())

    def test_replaces_symlink(self):
        self.out.mkdir()
        target = self.tmp / "le-fullchain.pem"
        target.write_bytes(b"legacy")
        os.symlink(target, self.out / "fullchain.pem")
        with mock.patch.object(cert_sync, "fetch", return_value=(200, self.payload())):
            self.assertEqual(cert_sync.sync(self.args()), 0)
        self.assertFalse((self.out / "fullchain.pem").is_symlink())
        self.assertEqual(target.read_bytes(), b"legacy")

    def test_failed_reload_returns_1(self):
        args = self.args("--reload", "false")
        with mock.patch.object(cert_sync, "fetch", return_value=(200, self.payload())):
            self.assertEqual(cert_sync.sync(args), 1)
        self.assertTrue((self.out / "fullchain.pem").exists())

    def test_main_requires_credentials(self):
        with mock.patch.dict(os.environ, {"CP_ORIGIN": "", "NODE_SECRET": ""}):
            self.assertEqual(cert_sync.main(["--out-dir", str(self.out)]), 2)


class FetchTests(unittest.TestCase):
    def _resp(self, status, body):
        import io
        r = mock.MagicMock()
        r.status = status
        r.read.return_value = body
        r.__enter__.return_value = r
        return r

    def test_etag_header_and_json(self):
        with mock.patch.object(cert_sync.urllib.request, "urlopen", return_value=self._resp(200, b'{"a":1}')) as uo:
            status, data = cert_sync.fetch("https://cp.test/", "sec", "abc", 5.0)
        self.assertEqual((status, data), (200, {"a": 1}))
        req = uo.call_args[0][0]
        self.assertEqual(req.full_url, "https://cp.test/api/internal/v1/node/cert")
        self.assertEqual(req.get_header("Authorization"), "Bearer sec")
        self.assertEqual(req.get_header("If-none-match"), '"abc"')

    def test_http_304_and_404(self):
        import urllib.error
        for code in (304, 404):
            err = urllib.error.HTTPError("u", code, "x", {}, None)
            with mock.patch.object(cert_sync.urllib.request, "urlopen", side_effect=err):
                self.assertEqual(cert_sync.fetch("http://cp", "s", None, 1.0), (code, None))

    def test_http_500_raises(self):
        import io
        import urllib.error
        err = urllib.error.HTTPError("u", 500, "boom", {}, io.BytesIO(b"fail"))
        with mock.patch.object(cert_sync.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(RuntimeError):
                cert_sync.fetch("http://cp", "s", None, 1.0)


if __name__ == "__main__":
    unittest.main()
