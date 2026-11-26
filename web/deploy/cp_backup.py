#!/usr/bin/env python3
"""Control Plane backup, S3 sync (SigV4), retention, and restore tool.

Uses Python 3.9+ standard library only (no awscli/rclone/boto3 required).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

BACKUP_NAME_RE = re.compile(r"^pereval-cp-\d{8}-\d{6}\.tar\.gz$")
DEFAULT_BACKUP_DIR = Path("/var/backups/pereval")
DEFAULT_PEREVAL_DIR = Path("/opt/pereval")
DEFAULT_KEEP_COUNT = 7


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        return env
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and ((val[0] == val[-1] == '"') or (val[0] == val[-1] == "'")):
            val = val[1:-1]
        env[key] = val
    return env


def load_config_env(pereval_dir: Path, env_file: Path | None = None) -> dict[str, str]:
    cfg = parse_env_file(env_file or (pereval_dir / ".env"))
    # Explicit process environment overrides .env
    for key, val in os.environ.items():
        if val != "" or key not in cfg:
            cfg[key] = val
    return cfg


def is_excluded_relpath(rel_path: str) -> bool:
    """Return True if a relative path is a log or temporary file that must never be archived."""
    norm = rel_path.replace("\\", "/").lstrip("./")
    if not norm:
        return False
    parts = norm.split("/")
    name = parts[-1]
    lower_name = name.lower()

    if any(part.lower() in {"log", "logs"} for part in parts[:-1]):
        return True
    if parts[0].lower() == "dns01":
        return True
    if lower_name.endswith(".log") or ".log." in lower_name:
        return True
    if ".tmp" in lower_name or lower_name.endswith(".bak"):
        return True
    if name.startswith(".env.tmp"):
        return True
    return False


def _hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _sigv4_signing_key(secret_key: str, date_stamp: str, region: str, service: str = "s3") -> bytes:
    k_date = _hmac_sha256(("AWS4" + secret_key).encode("utf-8"), date_stamp)
    k_region = _hmac_sha256(k_date, region)
    k_service = _hmac_sha256(k_region, service)
    return _hmac_sha256(k_service, "aws4_request")


@dataclass(frozen=True)
class S3Config:
    endpoint: str
    bucket: str
    region: str
    access_key_id: str
    secret_access_key: str
    prefix: str = "cp-backups"
    path_style: bool = True

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "S3Config | None":
        bucket = env.get("S3_BUCKET", "").strip()
        access_key = env.get("S3_ACCESS_KEY_ID", "").strip()
        secret_key = env.get("S3_SECRET_ACCESS_KEY", "").strip()
        if not bucket or not access_key or not secret_key:
            return None
        endpoint = env.get("S3_ENDPOINT", "").strip() or "https://s3.amazonaws.com"
        if "://" not in endpoint:
            endpoint = "https://" + endpoint
        region = env.get("S3_REGION", "").strip() or "us-east-1"
        prefix = env.get("S3_PREFIX", "cp-backups").strip().strip("/")
        path_style = parse_bool(env.get("S3_PATH_STYLE"), default=True)
        return cls(
            endpoint=endpoint.rstrip("/"),
            bucket=bucket,
            region=region,
            access_key_id=access_key,
            secret_access_key=secret_key,
            prefix=prefix,
            path_style=path_style,
        )

    def object_key(self, filename: str) -> str:
        clean = filename.lstrip("/")
        if self.prefix:
            return f"{self.prefix}/{clean}"
        return clean


@dataclass(frozen=True)
class S3Object:
    key: str
    name: str
    last_modified: str
    size: int


class S3Client:
    """Minimal S3-compatible client using AWS Signature Version 4."""

    def __init__(self, cfg: S3Config, timeout: int = 120) -> None:
        self.cfg = cfg
        self.timeout = timeout
        parsed = urllib.parse.urlsplit(cfg.endpoint)
        self.scheme = parsed.scheme or "https"
        self.netloc = parsed.netloc
        self.base_path = parsed.path.rstrip("/")

    def _request(
        self,
        method: str,
        key: str = "",
        query_params: dict[str, str] | None = None,
        body: bytes = b"",
        content_type: str | None = None,
    ) -> bytes:
        url, host, canonical_uri, canonical_query = self._build_url_and_host(key, query_params)
        now = dt.datetime.now(dt.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest()

        headers: dict[str, str] = {
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if content_type:
            headers["content-type"] = content_type

        signed_header_names = sorted(headers.keys())
        canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in signed_header_names)
        signed_headers = ";".join(signed_header_names)

        canonical_request = "\n".join(
            [
                method,
                canonical_uri,
                canonical_query,
                canonical_headers,
                signed_headers,
                payload_hash,
            ]
        )
        scope = f"{date_stamp}/{self.cfg.region}/s3/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
            ]
        )
        signing_key = _sigv4_signing_key(self.cfg.secret_access_key, date_stamp, self.cfg.region)
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

        auth_header = (
            f"AWS4-HMAC-SHA256 Credential={self.cfg.access_key_id}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )

        req_headers = {
            "Authorization": auth_header,
            "x-amz-date": amz_date,
            "x-amz-content-sha256": payload_hash,
        }
        if content_type:
            req_headers["Content-Type"] = content_type

        data = body if method in {"PUT", "POST"} else None
        req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"S3 {method} {url} failed ({exc.code}): {err_body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"S3 {method} {url} connection error: {exc.reason}") from exc

    def _build_url_and_host(self, key: str = "", query_params: dict[str, str] | None = None) -> tuple[str, str, str, str]:
        clean_key = key.lstrip("/")
        if self.cfg.path_style:
            host = self.netloc
            raw_path = f"{self.base_path}/{self.cfg.bucket}"
            if clean_key:
                raw_path += f"/{clean_key}"
        else:
            host = f"{self.cfg.bucket}.{self.netloc}"
            raw_path = f"{self.base_path}/{clean_key}" if clean_key else (self.base_path or "/")

        encoded_path = urllib.parse.quote(raw_path, safe="/-_.~")
        if not encoded_path.startswith("/"):
            encoded_path = "/" + encoded_path

        canonical_query = ""
        if query_params:
            items = sorted((urllib.parse.quote(k, safe="-_.~"), urllib.parse.quote(v, safe="-_.~")) for k, v in query_params.items())
            canonical_query = "&".join(f"{k}={v}" for k, v in items)

        url = f"{self.scheme}://{host}{encoded_path}"
        if canonical_query:
            url += f"?{canonical_query}"
        return url, host, encoded_path, canonical_query

    def put_file(self, src_path: Path, key: str) -> None:
        data = src_path.read_bytes()
        self._request("PUT", key=key, body=data, content_type="application/gzip")

    def get_file(self, key: str, dst_path: Path) -> None:
        data = self._request("GET", key=key)
        tmp = dst_path.with_name(f"{dst_path.name}.tmp.{os.getpid()}")
        tmp.write_bytes(data)
        os.replace(tmp, dst_path)

    def delete_object(self, key: str) -> None:
        self._request("DELETE", key=key)

    def list_backups(self) -> list[S3Object]:
        objects: list[S3Object] = []
        token: str | None = None
        prefix = f"{self.cfg.prefix}/" if self.cfg.prefix else ""

        while True:
            params: dict[str, str] = {"list-type": "2"}
            if prefix:
                params["prefix"] = prefix
            if token:
                params["continuation-token"] = token

            xml_bytes = self._request("GET", key="", query_params=params)
            root = ET.fromstring(xml_bytes)

            def find_text(elem: ET.Element, tag: str) -> str:
                for child in elem:
                    if child.tag.split("}")[-1] == tag:
                        return (child.text or "").strip()
                return ""

            for elem in root:
                if elem.tag.split("}")[-1] != "Contents":
                    continue
                key = find_text(elem, "Key")
                name = key.rsplit("/", 1)[-1]
                if not BACKUP_NAME_RE.match(name):
                    continue
                last_modified = find_text(elem, "LastModified")
                size_str = find_text(elem, "Size") or "0"
                objects.append(
                    S3Object(
                        key=key,
                        name=name,
                        last_modified=last_modified,
                        size=int(size_str),
                    )
                )

            is_truncated = find_text(root, "IsTruncated").lower() == "true"
            token = find_text(root, "NextContinuationToken") or None
            if not is_truncated or not token:
                break

        objects.sort(key=lambda o: o.name, reverse=True)
        return objects


def compose_base_cmd(pereval_dir: Path) -> list[str]:
    cmd = ["docker", "compose"]
    env_file = pereval_dir / ".env"
    image_env = pereval_dir / ".image.env"
    if env_file.is_file():
        cmd += ["--env-file", str(env_file)]
    if image_env.is_file():
        cmd += ["--env-file", str(image_env)]
    return cmd


def run_cmd(cmd: list[str], cwd: Path | None = None, input_bytes: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        input=input_bytes,
        capture_output=True,
        check=check,
    )


def dump_postgres(pereval_dir: Path, cfg: dict[str, str], out_file: Path) -> None:
    custom_cmd = cfg.get("CP_BACKUP_PG_DUMP_CMD", "").strip()
    if custom_cmd:
        res = subprocess.run(custom_cmd, shell=True, capture_output=True, check=False)
        if res.returncode != 0:
            raise RuntimeError(f"pg_dump failed ({res.returncode}): {res.stderr.decode('utf-8', errors='replace')}")
        out_file.write_bytes(res.stdout)
        return

    cmd = compose_base_cmd(pereval_dir) + ["exec", "-T"]
    pg_password = cfg.get("POSTGRES_PASSWORD", "")
    if pg_password:
        cmd += ["-e", f"PGPASSWORD={pg_password}"]
    cmd += ["postgres", "pg_dump", "-U", "pereval", "-d", "pereval", "-Fc"]
    res = run_cmd(cmd, cwd=pereval_dir, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"docker compose pg_dump failed ({res.returncode}): {res.stderr.decode('utf-8', errors='replace')}")
    if not res.stdout:
        raise RuntimeError("pg_dump produced empty output")
    out_file.write_bytes(res.stdout)


def resolve_letsencrypt_mountpoint(pereval_dir: Path, cfg: dict[str, str]) -> Path | None:
    override = cfg.get("LETSENCRYPT_DIR", "").strip()
    if override:
        p = Path(override)
        p.mkdir(parents=True, exist_ok=True)
        return p

    vol_name = cfg.get("LETSENCRYPT_VOLUME", "").strip() or "pereval_letsencrypt"
    res = run_cmd(["docker", "volume", "inspect", "-f", "{{.Mountpoint}}", vol_name], check=False)
    if res.returncode == 0:
        mp = Path(res.stdout.decode("utf-8", errors="replace").strip())
        if mp.is_dir() and os.access(mp, os.R_OK):
            return mp
    return None


def copy_letsencrypt_to_dir(pereval_dir: Path, cfg: dict[str, str], dst_dir: Path) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    mp = resolve_letsencrypt_mountpoint(pereval_dir, cfg)
    if mp is not None:
        for root, dirs, files in os.walk(mp):
            rel_root = Path(root).relative_to(mp)
            dirs[:] = [d for d in dirs if not is_excluded_relpath(str(rel_root / d / "x"))]
            target_root = dst_dir / rel_root
            target_root.mkdir(parents=True, exist_ok=True)
            for fname in files:
                rel = str(rel_root / fname)
                if is_excluded_relpath(rel):
                    continue
                src_f = Path(root) / fname
                dst_f = target_root / fname
                if src_f.is_symlink():
                    link_target = os.readlink(src_f)
                    if dst_f.exists() or dst_f.is_symlink():
                        dst_f.unlink()
                    os.symlink(link_target, dst_f)
                elif src_f.is_file():
                    shutil.copy2(src_f, dst_f)
        return

    # Fallback: stream tar from letsencrypt volume using nginx container image
    vol_name = cfg.get("LETSENCRYPT_VOLUME", "").strip() or "pereval_letsencrypt"
    res = run_cmd(
        ["docker", "run", "--rm", "-v", f"{vol_name}:/src:ro", "--entrypoint", "sh", "nginx:1.27-alpine", "-c", "tar -C /src -cf - ."],
        cwd=pereval_dir,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(f"failed to read letsencrypt volume: {res.stderr.decode('utf-8', errors='replace')}")
    with tarfile.open(fileobj=io.BytesIO(res.stdout), mode="r:*") as tf:
        safe_extract_tar(tf, dst_dir, skip_excluded=True)


def safe_extract_tar(tf: tarfile.TarFile, dst_dir: Path, skip_excluded: bool = False) -> None:
    dst_resolved = dst_dir.resolve()
    for member in tf.getmembers():
        rel = member.name.lstrip("./")
        if not rel or rel == ".":
            continue
        if skip_excluded and is_excluded_relpath(rel):
            continue
        target = (dst_resolved / rel).resolve()
        if target != dst_resolved and dst_resolved not in target.parents:
            raise RuntimeError(f"unsafe tar member path: {member.name}")
        tf.extract(member, path=dst_resolved)


def collect_opt_pereval_files(pereval_dir: Path) -> list[Path]:
    """Collect non-git files in /opt/pereval (excluding compose.yaml, deploy/, dns01/, logs, tmp)."""
    ignored_top = {"compose.yaml", "deploy", "dns01"}
    collected: list[Path] = []
    if not pereval_dir.is_dir():
        return collected
    for entry in sorted(pereval_dir.iterdir()):
        if entry.name in ignored_top:
            continue
        if entry.is_file():
            if not is_excluded_relpath(entry.name):
                collected.append(entry)
    return collected


def add_dir_to_tar(tf: tarfile.TarFile, src_dir: Path, arc_prefix: str) -> None:
    if not src_dir.is_dir():
        return
    for root, dirs, files in os.walk(src_dir):
        rel_root = Path(root).relative_to(src_dir)
        dirs[:] = sorted(d for d in dirs if not is_excluded_relpath(str(rel_root / d / "x")))
        for fname in sorted(files):
            rel = str(rel_root / fname)
            if is_excluded_relpath(rel):
                continue
            full_path = Path(root) / fname
            arcname = f"{arc_prefix}/{rel}".replace("/./", "/")
            tf.add(full_path, arcname=arcname, recursive=False)


def create_backup_archive(pereval_dir: Path, backup_dir: Path, cfg: dict[str, str]) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    archive_name = f"pereval-cp-{ts}.tar.gz"
    final_path = backup_dir / archive_name
    tmp_path = backup_dir / f"{archive_name}.tmp.{os.getpid()}"

    with tempfile.TemporaryDirectory(prefix="pereval-bkp-") as stage:
        stage_dir = Path(stage)
        db_dump = stage_dir / "db.dump"
        le_dir = stage_dir / "letsencrypt"

        dump_postgres(pereval_dir, cfg, db_dump)
        copy_letsencrypt_to_dir(pereval_dir, cfg, le_dir)

        try:
            with tarfile.open(tmp_path, "w:gz") as tf:
                tf.add(db_dump, arcname="db.dump")
                add_dir_to_tar(tf, le_dir, "letsencrypt")
                for opt_file in collect_opt_pereval_files(pereval_dir):
                    tf.add(opt_file, arcname=f"opt-pereval/{opt_file.name}", recursive=False)
            os.replace(tmp_path, final_path)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

    os.chmod(final_path, 0o600)
    return final_path


def prune_local_backups(backup_dir: Path, keep_count: int) -> list[Path]:
    if not backup_dir.is_dir() or keep_count <= 0:
        return []
    archives = sorted(
        (p for p in backup_dir.iterdir() if p.is_file() and BACKUP_NAME_RE.match(p.name)),
        key=lambda p: p.name,
        reverse=True,
    )
    removed: list[Path] = []
    for old in archives[keep_count:]:
        old.unlink(missing_ok=True)
        removed.append(old)
    return removed


def prune_s3_backups(client: S3Client, keep_count: int) -> list[str]:
    if keep_count <= 0:
        return []
    objects = client.list_backups()
    removed: list[str] = []
    for obj in objects[keep_count:]:
        client.delete_object(obj.key)
        removed.append(obj.key)
    return removed


def verify_backup_archive(archive_path: Path) -> None:
    if not archive_path.is_file() or archive_path.stat().st_size == 0:
        raise RuntimeError(f"backup archive is missing or empty: {archive_path}")
    with tarfile.open(archive_path, "r:gz") as tf:
        names = [m.name.lstrip("./") for m in tf.getmembers()]
        if "db.dump" not in names:
            raise RuntimeError(f"backup archive {archive_path} does not contain db.dump")
        for name in names:
            if is_excluded_relpath(name):
                raise RuntimeError(f"backup archive contains excluded log/tmp file: {name}")


def restore_letsencrypt_from_dir(pereval_dir: Path, cfg: dict[str, str], src_dir: Path) -> None:
    if not src_dir.is_dir():
        return
    mp = resolve_letsencrypt_mountpoint(pereval_dir, cfg)
    if mp is not None:
        for child in list(mp.iterdir()):
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
        for item in src_dir.iterdir():
            dst = mp / item.name
            if item.is_dir() and not item.is_symlink():
                shutil.copytree(item, dst, symlinks=True)
            elif item.is_symlink():
                os.symlink(os.readlink(item), dst)
            else:
                shutil.copy2(item, dst)
        return

    vol_name = cfg.get("LETSENCRYPT_VOLUME", "").strip() or "pereval_letsencrypt"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for item in src_dir.iterdir():
            tf.add(item, arcname=item.name, recursive=True)
    res = run_cmd(
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "-v",
            f"{vol_name}:/dst",
            "--entrypoint",
            "sh",
            "nginx:1.27-alpine",
            "-c",
            "rm -rf /dst/* /dst/.[!.]* /dst/..?* 2>/dev/null || true; tar -C /dst -xzf -",
        ],
        cwd=pereval_dir,
        input_bytes=buf.getvalue(),
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(f"failed to restore letsencrypt volume: {res.stderr.decode('utf-8', errors='replace')}")


def wait_for_postgres(pereval_dir: Path, timeout_sec: int = 60) -> None:
    cmd = compose_base_cmd(pereval_dir) + ["exec", "-T", "postgres", "pg_isready", "-U", "pereval", "-d", "pereval"]
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        res = run_cmd(cmd, cwd=pereval_dir, check=False)
        if res.returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError("postgres did not become ready in time")


def restore_postgres(pereval_dir: Path, cfg: dict[str, str], db_dump: Path) -> None:
    custom_cmd = cfg.get("CP_BACKUP_PG_RESTORE_CMD", "").strip()
    if custom_cmd:
        res = subprocess.run(custom_cmd, shell=True, input=db_dump.read_bytes(), capture_output=True, check=False)
        if res.returncode != 0:
            raise RuntimeError(f"pg_restore failed ({res.returncode}): {res.stderr.decode('utf-8', errors='replace')}")
        return

    cmd = compose_base_cmd(pereval_dir) + ["exec", "-T"]
    pg_password = cfg.get("POSTGRES_PASSWORD", "")
    if pg_password:
        cmd += ["-e", f"PGPASSWORD={pg_password}"]
    cmd += [
        "postgres",
        "pg_restore",
        "-U",
        "pereval",
        "-d",
        "pereval",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
    ]
    res = run_cmd(cmd, cwd=pereval_dir, input_bytes=db_dump.read_bytes(), check=False)
    if res.returncode != 0:
        raise RuntimeError(f"docker compose pg_restore failed ({res.returncode}): {res.stderr.decode('utf-8', errors='replace')}")


def cmd_backup(pereval_dir: Path, backup_dir: Path, env_file: Path | None) -> int:
    cfg = load_config_env(pereval_dir, env_file)
    keep_count = int(cfg.get("BACKUP_KEEP_COUNT", str(DEFAULT_KEEP_COUNT)) or DEFAULT_KEEP_COUNT)

    archive = create_backup_archive(pereval_dir, backup_dir, cfg)
    verify_backup_archive(archive)
    print(f"[backup] created {archive}")

    s3_cfg = S3Config.from_env(cfg)
    if s3_cfg is None:
        print("[backup] S3 credentials not configured; skipping S3 upload", file=sys.stderr)
    else:
        client = S3Client(s3_cfg)
        key = s3_cfg.object_key(archive.name)
        client.put_file(archive, key)
        print(f"[backup] uploaded to s3://{s3_cfg.bucket}/{key}")
        deleted_s3 = prune_s3_backups(client, keep_count)
        if deleted_s3:
            print(f"[backup] pruned {len(deleted_s3)} old S3 backup(s)")

    deleted_local = prune_local_backups(backup_dir, keep_count)
    if deleted_local:
        print(f"[backup] pruned {len(deleted_local)} old local backup(s)")
    return 0


def cmd_restore(
    pereval_dir: Path,
    backup_dir: Path,
    env_file: Path | None,
    backup_name: str,
    skip_compose: bool = False,
) -> int:
    cfg = load_config_env(pereval_dir, env_file)
    s3_cfg = S3Config.from_env(cfg)
    if s3_cfg is None:
        raise RuntimeError("S3 credentials (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) are required for restore")

    client = S3Client(s3_cfg)
    objects = client.list_backups()
    if not objects:
        raise RuntimeError(f"no backups found in s3://{s3_cfg.bucket}/{s3_cfg.prefix}")

    requested = (backup_name or "").strip()
    if not requested or requested.lower() == "latest":
        target = objects[0]
    else:
        matches = [o for o in objects if o.name == requested or o.key == requested]
        if not matches:
            raise RuntimeError(f"backup '{requested}' not found in S3")
        target = matches[0]

    backup_dir.mkdir(parents=True, exist_ok=True)
    local_archive = backup_dir / target.name
    client.get_file(target.key, local_archive)
    verify_backup_archive(local_archive)
    print(f"[restore] downloaded and verified {target.name}")

    with tempfile.TemporaryDirectory(prefix="pereval-restore-") as stage:
        stage_dir = Path(stage)
        with tarfile.open(local_archive, "r:gz") as tf:
            safe_extract_tar(tf, stage_dir, skip_excluded=False)

        if not skip_compose:
            run_cmd(compose_base_cmd(pereval_dir) + ["stop", "app", "jobs", "nginx"], cwd=pereval_dir, check=False)

        opt_src = stage_dir / "opt-pereval"
        if opt_src.is_dir():
            pereval_dir.mkdir(parents=True, exist_ok=True)
            for item in opt_src.iterdir():
                if item.is_file() and not is_excluded_relpath(item.name):
                    dst = pereval_dir / item.name
                    shutil.copy2(item, dst)
                    if item.name == ".env":
                        os.chmod(dst, 0o600)

        # Reload merged config after restoring .env so restored POSTGRES_PASSWORD is used
        restored_cfg = load_config_env(pereval_dir, env_file)
        restore_letsencrypt_from_dir(pereval_dir, restored_cfg, stage_dir / "letsencrypt")

        if not skip_compose:
            run_cmd(compose_base_cmd(pereval_dir) + ["up", "-d", "postgres"], cwd=pereval_dir, check=True)
            wait_for_postgres(pereval_dir)

        restore_postgres(pereval_dir, restored_cfg, stage_dir / "db.dump")

        if not skip_compose:
            run_cmd(compose_base_cmd(pereval_dir) + ["up", "-d", "--remove-orphans"], cwd=pereval_dir, check=True)
            run_cmd(
                compose_base_cmd(pereval_dir) + ["exec", "-T", "nginx", "sh", "/docker-entrypoint.d/40-pereval-certs.sh", "publish"],
                cwd=pereval_dir,
                check=False,
            )

    print(f"[restore] completed from {target.name}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Pereval Control Plane backup and restore")
    parser.add_argument("--pereval-dir", type=Path, default=Path(os.environ.get("PEREVAL_DIR", str(DEFAULT_PEREVAL_DIR))))
    parser.add_argument("--backup-dir", type=Path, default=Path(os.environ.get("BACKUP_DIR", str(DEFAULT_BACKUP_DIR))))
    parser.add_argument("--env-file", type=Path, default=None)
    parser.add_argument("--restore", action="store_true", help="Alias for 'restore' subcommand")
    parser.add_argument("--backup", default="latest", help="Backup name or 'latest' when using --restore")
    parser.add_argument("--skip-compose", action="store_true", help="Skip docker compose lifecycle commands (for tests)")

    sub = parser.add_subparsers(dest="command")

    sub.add_parser("backup", help="Create backup archive, upload to S3, and prune old backups")

    p_restore = sub.add_parser("restore", help="Download backup from S3 and restore CP state")
    p_restore.add_argument("--backup", default="latest", help="Backup archive name or 'latest'")
    p_restore.add_argument("--skip-compose", action="store_true", help="Skip docker compose lifecycle commands (for tests)")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "restore" or args.restore:
        return cmd_restore(
            pereval_dir=args.pereval_dir,
            backup_dir=args.backup_dir,
            env_file=args.env_file,
            backup_name=args.backup,
            skip_compose=args.skip_compose,
        )
    if args.command == "backup" or args.command is None:
        return cmd_backup(
            pereval_dir=args.pereval_dir,
            backup_dir=args.backup_dir,
            env_file=args.env_file,
        )
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
