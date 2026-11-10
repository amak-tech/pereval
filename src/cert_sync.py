#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cert_sync.py — синхронизация единого TLS-сертификата Перевала с control plane.

Один wildcard-сертификат (pereval.top, *.pereval.top, *.pro.pereval.top + устаревшие
Free-имена) выпускается на CP (pereval.top, DNS-01 вручную) и раздаётся нодам через
внутренний API. Этот скрипт запускается systemd-таймером (раз в час) на Free Primary
и на pro-dns и при деплое:

    GET {CP_ORIGIN}/api/internal/v1/node/cert
        Authorization: Bearer <NODE_SECRET>
        If-None-Match: "<sha256 текущего fullchain.pem>"
    200 {sha256, not_after, names, fullchain, privkey}  — новый сертификат
    304                                                   — без изменений
    404                                                   — у CP пока нет боевого сертификата

Перед установкой пара проверяется (ssl.load_cert_chain), сверяются срок и обязательные
имена (--expect), затем файлы записываются атомарно и выполняются --reload команды
(nginx -t && systemctl reload nginx, SIGHUP pro_dns). Только stdlib, Python 3.9+.

Коды выхода: 0 — обновлено / без изменений / сертификата на CP ещё нет;
             1 — ошибка сети, проверки или установки; 2 — ошибка параметров.
"""
from __future__ import annotations

import argparse
import grp
import hashlib
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

CERT_PATH = "/api/internal/v1/node/cert"
USER_AGENT = "pereval-cert-sync/1.0"
MIN_VALID_SECONDS = 24 * 3600  # сертификат, которому осталось меньше суток, не ставим


def log(msg: str) -> None:
    sys.stdout.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    sys.stdout.flush()


# ------------------------------------------------------------------ utilities


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def current_sha(out_dir: Path) -> str | None:
    """sha256 установленного fullchain.pem (как считает CP) или None, если файла нет."""
    chain = out_dir / "fullchain.pem"
    if not chain.is_file():
        return None
    try:
        return sha256_hex(chain.read_bytes())
    except OSError:
        return None


def name_matches(host: str, names) -> bool:
    """host покрыт одним из имён сертификата (точное совпадение или wildcard одного уровня)."""
    host = host.lower().rstrip(".")
    for n in names or []:
        n = str(n).lower().rstrip(".")
        if n == host:
            return True
        if n.startswith("*.") and "." in host and host.split(".", 1)[1] == n[2:]:
            return True
    return False


def decode_cert(cert_path: str) -> dict:
    """{'not_after': epoch|None, 'names': [...]} — через ssl (приватный, но стабильный
    _test_decode_cert) с фолбэком на openssl CLI; при полной недоступности — пусто."""
    info = {"not_after": None, "names": []}
    try:
        raw = ssl._ssl._test_decode_cert(cert_path)  # type: ignore[attr-defined]
        if raw.get("notAfter"):
            info["not_after"] = ssl.cert_time_to_seconds(raw["notAfter"])
        names = [v for (k, v) in raw.get("subjectAltName", ()) if k == "DNS"]
        if not names:
            for rdn in raw.get("subject", ()):
                for k, v in rdn:
                    if k == "commonName":
                        names.append(v)
        info["names"] = names
        return info
    except Exception:
        pass
    if shutil.which("openssl"):
        try:
            out = subprocess.run(
                ["openssl", "x509", "-in", cert_path, "-noout", "-enddate", "-ext", "subjectAltName"],
                check=True, capture_output=True, text=True,
            ).stdout
            for line in out.splitlines():
                line = line.strip()
                if line.startswith("notAfter="):
                    info["not_after"] = ssl.cert_time_to_seconds(line.split("=", 1)[1])
                elif "DNS:" in line:
                    info["names"].extend(p.strip()[4:] for p in line.split(",") if p.strip().startswith("DNS:"))
        except Exception:
            pass
    return info


def validate_pair(fullchain: bytes, privkey: bytes, expect=None, now: float | None = None) -> dict:
    """Проверяет, что цепочка и ключ образуют рабочую пару, сертификат не истекает
    в ближайшие сутки и покрывает все ожидаемые имена. Возвращает decode_cert()."""
    if b"-----BEGIN CERTIFICATE-----" not in fullchain:
        raise ValueError("fullchain.pem не содержит сертификата")
    if b"PRIVATE KEY-----" not in privkey:
        raise ValueError("privkey.pem не содержит ключа")
    with tempfile.TemporaryDirectory(prefix="pereval-cert-") as td:
        c = Path(td) / "fullchain.pem"
        k = Path(td) / "privkey.pem"
        c.write_bytes(fullchain)
        k.write_bytes(privkey)
        os.chmod(str(k), 0o600)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            ctx.load_cert_chain(str(c), str(k))
        except ssl.SSLError as exc:
            raise ValueError("сертификат и ключ не подходят друг к другу: %s" % exc) from exc
        info = decode_cert(str(c))
    now = time.time() if now is None else now
    if info["not_after"] is not None and info["not_after"] - now < MIN_VALID_SECONDS:
        raise ValueError("сертификат истекает %s — не ставлю" % time.strftime("%Y-%m-%d", time.gmtime(info["not_after"])))
    missing = [h for h in (expect or []) if not name_matches(h, info["names"])]
    if missing and info["names"]:
        raise ValueError("сертификат не покрывает имена: %s (есть: %s)" % (", ".join(missing), ", ".join(info["names"])))
    return info


def _atomic_write(path: Path, data: bytes, mode: int, gid: int | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s." % path.name, dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        if gid is not None:
            try:
                os.chown(tmp, 0, gid)
            except PermissionError:
                os.chown(tmp, -1, gid)
        if path.is_symlink():
            path.unlink()
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def install_pair(out_dir: Path, fullchain: bytes, privkey: bytes, group: str | None, key_mode: int) -> None:
    gid = None
    if group:
        try:
            gid = grp.getgrnam(group).gr_gid
        except KeyError:
            log("warning: группа %s не найдена, права по умолчанию" % group)
    # сначала ключ, потом цепочка: читатели (nginx, pro_dns) открывают их только при reload
    _atomic_write(out_dir / "privkey.pem", privkey, key_mode, gid)
    _atomic_write(out_dir / "fullchain.pem", fullchain, 0o644, gid)


def write_state(out_dir: Path, info: dict) -> None:
    try:
        (out_dir / ".cert-sync.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        log("warning: не удалось записать состояние: %s" % exc)


def run_reloads(commands) -> bool:
    ok = True
    for cmd in commands or []:
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if res.returncode == 0:
            log("reload ok: %s" % cmd)
        else:
            ok = False
            log("reload FAILED (%d): %s\n%s" % (res.returncode, cmd, (res.stderr or res.stdout).strip()))
    return ok


# ------------------------------------------------------------------ control plane


def fetch(origin: str, secret: str, etag: str | None, timeout: float, ca_file: str | None = None):
    """-> (status, payload|None). 304/404 возвращаются как статус без исключения."""
    url = origin.rstrip("/") + CERT_PATH
    headers = {"Authorization": "Bearer %s" % secret, "User-Agent": USER_AGENT, "Accept": "application/json"}
    if etag:
        headers["If-None-Match"] = '"%s"' % etag
    req = urllib.request.Request(url, headers=headers, method="GET")
    ctx = None
    if url.lower().startswith("https://"):
        ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read()
            return resp.status, (json.loads(body.decode("utf-8")) if body else None)
    except urllib.error.HTTPError as exc:
        if exc.code in (304, 404):
            return exc.code, None
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise RuntimeError("CP ответил %d: %s" % (exc.code, detail or exc.reason)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("CP недоступен: %s" % exc.reason) from exc


# ------------------------------------------------------------------ main


def sync(args) -> int:
    out_dir = Path(args.out_dir)
    have = current_sha(out_dir)
    etag = None if args.force else have
    status, payload = fetch(args.cp_origin, args.node_secret, etag, args.timeout, args.cp_ca_file)
    if status == 304:
        log("сертификат без изменений (sha256 %s…)" % (have or "")[:12])
        return 0
    if status == 404:
        log("на control plane пока нет боевого сертификата — оставляю текущий")
        return 0
    if status != 200 or not isinstance(payload, dict):
        raise RuntimeError("неожиданный ответ CP: %s" % status)
    fullchain = str(payload.get("fullchain") or "").encode("utf-8")
    privkey = str(payload.get("privkey") or "").encode("utf-8")
    if not fullchain or not privkey:
        raise RuntimeError("в ответе CP нет fullchain/privkey")
    sha = sha256_hex(fullchain)
    if payload.get("sha256") and payload["sha256"] != sha:
        raise RuntimeError("sha256 из ответа не совпадает с телом сертификата")
    if have == sha and not args.force:
        log("сертификат уже установлен (sha256 %s…)" % sha[:12])
        return 0
    info = validate_pair(fullchain, privkey, expect=args.expect)
    install_pair(out_dir, fullchain, privkey, args.group, int(args.key_mode, 8))
    not_after = info.get("not_after")
    write_state(out_dir, {
        "sha256": sha,
        "not_after": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(not_after)) if not_after else payload.get("not_after"),
        "names": info.get("names") or payload.get("names") or [],
        "synced_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    log("установлен новый сертификат в %s (sha256 %s…, до %s, имена: %s)" % (
        out_dir, sha[:12],
        time.strftime("%Y-%m-%d", time.gmtime(not_after)) if not_after else payload.get("not_after", "?"),
        ", ".join(info.get("names") or payload.get("names") or []) or "?"))
    return 0 if run_reloads(args.reload) else 1


def _env(name: str, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Синхронизация единого TLS-сертификата Перевала с control plane.")
    p.add_argument("--cp-origin", default=_env("CP_ORIGIN"), help="origin control plane (env CP_ORIGIN)")
    p.add_argument("--node-secret", default=_env("NODE_SECRET"), help="Bearer-секрет узла (env NODE_SECRET)")
    p.add_argument("--cp-ca-file", default=_env("CP_CA_FILE"), help="свой CA для HTTPS к control plane")
    p.add_argument("--out-dir", required=True, help="каталог для fullchain.pem и privkey.pem")
    p.add_argument("--group", default=None, help="группа-владелец файлов (например pereval-dns)")
    p.add_argument("--key-mode", default="0640", help="права privkey.pem в восьмеричном виде (по умолчанию 0640)")
    p.add_argument("--expect", action="append", default=[], help="имя, которое сертификат обязан покрывать (можно несколько)")
    p.add_argument("--reload", action="append", default=[], help="команда после установки (можно несколько)")
    p.add_argument("--timeout", type=float, default=20.0, help="таймаут HTTP, с")
    p.add_argument("--force", action="store_true", help="переустановить даже при совпадающем sha256")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if not args.cp_origin or not args.node_secret:
        log("CP_ORIGIN и NODE_SECRET обязательны (обычно из /etc/pereval/node.env)")
        return 2
    try:
        return sync(args)
    except (RuntimeError, ValueError) as exc:
        log("ошибка: %s" % exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
