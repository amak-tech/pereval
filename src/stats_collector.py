#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Lightweight real-time usage statistics collector for Перевал (pereval).

Tails buffered nginx logs (/var/log/nginx/sni.log and /var/log/nginx/http-proxy.log),
samples established connections from /proc/net/tcp, maps domains to logical services
via service-map.json, and atomically writes /var/www/geoblock/stats.json every 5s.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import signal
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

# log_format sni '$remote_addr [$time_local] sni="$ssl_preread_server_name" '
#                'up=$upstream_addr status=$status '
#                'sent=$bytes_sent recv=$bytes_received dur=$session_time';
SNI_LOG_RE = re.compile(
    r'^(?P<ip>\S+)\s+\[(?P<time>[^\]]+)\]\s+'
    r'sni="(?P<sni>[^"]*)"\s+'
    r'up=(?P<up>.+?)\s+'
    r'status=(?P<status>\d+)\s+'
    r'sent=(?P<sent>\d+)\s+'
    r'recv=(?P<recv>\d+)\s+'
    r'dur=(?P<dur>[\d.]+)'
)

# log_format hostproxy '$remote_addr [$time_local] "$request" host="$host" '
#                      '-> $upstream_addr $status $body_bytes_sent';
HTTP_LOG_RE = re.compile(
    r'^(?P<ip>\S+)\s+\[(?P<time>[^\]]+)\]\s+'
    r'"(?P<req>[^"]*)"\s+'
    r'host="(?P<host>[^"]*)"\s+'
    r'->\s+(?P<up>.+?)\s+'
    r'(?P<status>\d+)\s+'
    r'(?P<sent>\d+)'
)

MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4,
    "May": 5, "Jun": 6, "Jul": 7, "Aug": 8,
    "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}


def parse_nginx_time(raw: str) -> int:
    """Parse nginx $time_local ('03/Nov/2026:19:55:12 +0500') into unix epoch seconds."""
    try:
        # Fast manual parse to avoid strptime locale issues
        # Format: DD/Mon/YYYY:HH:MM:SS +ZZZZ
        day = int(raw[0:2])
        mon = MONTHS.get(raw[3:6], 1)
        year = int(raw[7:11])
        hour = int(raw[12:14])
        minute = int(raw[15:17])
        sec = int(raw[18:20])
        tz_sign = -1 if raw[21] == "-" else 1
        tz_hr = int(raw[22:24])
        tz_min = int(raw[24:26])
        tz_offset = tz_sign * (tz_hr * 3600 + tz_min * 60)

        # Days from 1970-01-01
        dt = datetime(year, mon, day, hour, minute, sec)
        epoch_utc = int((dt - datetime(1970, 1, 1)).total_seconds())
        return epoch_utc - tz_offset
    except Exception:
        return int(time.time())


def load_service_map(path: Path) -> dict:
    """Load domain -> {service, category} dictionary from service-map.json."""
    if path and path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {k.lower().strip("."): v for k, v in data.items() if isinstance(v, dict)}
        except Exception as exc:
            print(f"[pereval-stats] warning: failed to load {path}: {exc}", file=sys.stderr)
    return {}


def load_cluster_config(path: Path) -> dict:
    """Load cluster topology (primary, domain, workers) from cluster-nodes.json."""
    if path and path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception as exc:
            print(f"[pereval-stats] warning: failed to load {path}: {exc}", file=sys.stderr)
    return {}


def extract_ip_only(raw: str) -> str:
    """Extract clean IP address from 'ip' or 'ip:port' string."""
    if not raw:
        return ""
    s = str(raw).strip()
    if s.startswith("[") and "]" in s:
        return s[1:s.index("]")]
    if s.count(":") == 1:
        return s.split(":", 1)[0].strip()
    return s


def normalize_domain(raw: str) -> str:
    if not raw:
        return ""
    d = raw.strip().lower()
    if ":" in d:
        d = d.split(":", 1)[0]
    return d.strip(".")


def resolve_service(domain: str, service_map: dict) -> tuple:
    """Map a domain or subdomain (e.g. api.anthropic.com) to (service_name, category_name)."""
    if not domain:
        return ("Неизвестно", "Другое")
    if domain in service_map:
        info = service_map[domain]
        return (info.get("service", domain), info.get("category", "Другое"))
    parts = domain.split(".")
    for i in range(1, len(parts) - 1):
        suffix = ".".join(parts[i:])
        if suffix in service_map:
            info = service_map[suffix]
            return (info.get("service", suffix), info.get("category", "Другое"))
    return (domain, "Другое")


class Bucket:
    """Aggregates metrics for a single time slice (1 minute or 1 hour)."""

    __slots__ = ("ts", "requests", "bytes_sent", "bytes_recv", "users", "services")

    def __init__(self, ts: int):
        self.ts = ts
        self.requests = 0
        self.bytes_sent = 0
        self.bytes_recv = 0
        self.users = set()
        self.services = {}  # service -> {"category": str, "requests": int, "bytes": int, "users": set}

    def add_event(self, ip_hash: int, service: str, category: str,
                  sent: int, recv: int):
        self.requests += 1
        self.bytes_sent += sent
        self.bytes_recv += recv
        self.users.add(ip_hash)

        total_bytes = sent + recv
        svc_entry = self.services.get(service)
        if svc_entry is None:
            svc_entry = {"category": category, "requests": 0, "bytes": 0, "users": set()}
            self.services[service] = svc_entry
        svc_entry["requests"] += 1
        svc_entry["bytes"] += total_bytes
        svc_entry["users"].add(ip_hash)

    def clone(self) -> "Bucket":
        b = Bucket(self.ts)
        b.requests = self.requests
        b.bytes_sent = self.bytes_sent
        b.bytes_recv = self.bytes_recv
        b.users = set(self.users)
        for k, v in self.services.items():
            b.services[k] = {
                "category": v["category"],
                "requests": v["requests"],
                "bytes": v["bytes"],
                "users": set(v["users"]),
            }
        return b

    def merge(self, other: "Bucket"):
        """Merge another Bucket into this one (sum counters, set-union user hashes)."""
        if other is None:
            return
        self.requests += other.requests
        self.bytes_sent += other.bytes_sent
        self.bytes_recv += other.bytes_recv
        self.users.update(other.users)
        for svc_name, other_svc in other.services.items():
            svc_entry = self.services.get(svc_name)
            if svc_entry is None:
                self.services[svc_name] = {
                    "category": other_svc.get("category", "Другое"),
                    "requests": int(other_svc.get("requests", 0)),
                    "bytes": int(other_svc.get("bytes", 0)),
                    "users": set(other_svc.get("users", [])),
                }
            else:
                svc_entry["requests"] += int(other_svc.get("requests", 0))
                svc_entry["bytes"] += int(other_svc.get("bytes", 0))
                svc_entry["users"].update(other_svc.get("users", []))

    def to_dict(self) -> dict:
        return {
            "ts": self.ts,
            "requests": self.requests,
            "bytes_sent": self.bytes_sent,
            "bytes_recv": self.bytes_recv,
            "users": list(self.users),
            "services": {
                k: {
                    "category": v["category"],
                    "requests": v["requests"],
                    "bytes": v["bytes"],
                    "users": list(v["users"]),
                }
                for k, v in self.services.items()
            },
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Bucket":
        b = cls(int(data["ts"]))
        b.requests = int(data.get("requests", 0))
        b.bytes_sent = int(data.get("bytes_sent", 0))
        b.bytes_recv = int(data.get("bytes_recv", 0))
        b.users = set(int(u) for u in data.get("users", []))
        for k, v in (data.get("services") or {}).items():
            b.services[k] = {
                "category": v.get("category", "Другое"),
                "requests": int(v.get("requests", 0)),
                "bytes": int(v.get("bytes", 0)),
                "users": set(int(u) for u in v.get("users", [])),
            }
        return b


class LogTailer:
    """Tracks a single log file across rotation (st_ino changes) and truncation."""

    def __init__(self, path: Path):
        self.path = path
        self.fp = None
        self.ino = None
        self.offset = 0

    def close(self):
        if self.fp is not None:
            try:
                self.fp.close()
            except Exception:
                pass
            self.fp = None

    def open_at(self, offset: int = 0):
        self.close()
        if not self.path.is_file():
            return False
        try:
            st = self.path.stat()
            self.fp = self.path.open("r", encoding="utf-8", errors="replace")
            if 0 < offset <= st.st_size:
                self.fp.seek(offset)
                self.offset = offset
            else:
                self.offset = 0
            self.ino = st.st_ino
            return True
        except Exception:
            self.close()
            return False

    def read_new_lines(self) -> list:
        lines = []
        if self.fp is None:
            if not self.open_at(0):
                return lines

        lines.extend(self._drain_fp())

        try:
            st = self.path.stat()
        except FileNotFoundError:
            self.close()
            return lines
        except Exception:
            return lines

        if st.st_ino != self.ino or st.st_size < self.offset:
            # File was rotated or truncated: drain old descriptor first, then reopen at 0
            lines.extend(self._drain_fp())
            if self.open_at(0):
                lines.extend(self._drain_fp())

        return lines

    def _drain_fp(self) -> list:
        out = []
        if self.fp is None:
            return out
        while True:
            pos = self.fp.tell()
            line = self.fp.readline()
            if not line:
                break
            if not line.endswith("\n"):
                # Incomplete line being written; rewind and wait for next tick
                self.fp.seek(pos)
                break
            self.offset = self.fp.tell()
            out.append(line)
        return out


class StatsCollector:
    """Collects and aggregates nginx proxy metrics over a 24-hour rolling window."""

    def __init__(
        self,
        service_map_path: Path,
        sni_log_path: Path,
        http_log_path: Path,
        output_path: Path,
        state_path: Path = None,
        proc_tcp_path: Path = Path("/proc/net/tcp"),
        proc_tcp6_path: Path = Path("/proc/net/tcp6"),
        self_domain: str = "pereval.portbuddy.tech",
        cluster_config_path: Path = None,
        node_output_path: Path = None,
        role: str = "auto",
        salt_seed: str = None,
        worker_timeout: float = 2.0,
        worker_stale_ttl: int = 60,
    ):
        self.service_map_path = service_map_path
        self.service_map = load_service_map(service_map_path)
        self.service_map_mtime = (
            service_map_path.stat().st_mtime if service_map_path and service_map_path.is_file() else 0
        )
        self.sni_log_path = sni_log_path
        self.http_log_path = http_log_path
        self.output_path = output_path
        self.node_output_path = node_output_path
        self.state_path = state_path
        self.proc_tcp_path = proc_tcp_path
        self.proc_tcp6_path = proc_tcp6_path
        self.self_domain = normalize_domain(self_domain)
        self.role = (role or "auto").strip().lower()
        self.custom_salt_seed = salt_seed
        self.worker_timeout = max(0.2, float(worker_timeout))
        self.worker_stale_ttl = max(0, int(worker_stale_ttl))
        self.worker_snapshot_cache = {}  # worker_key -> {"fetched_at": int, "data": dict}

        self.cluster_config_path = cluster_config_path
        self.cluster_config_mtime = 0
        self.cluster_primary_ip = ""
        self.cluster_workers = []
        self.ignored_ips = {"127.0.0.1", "::1"}
        self.salt_seed = self.custom_salt_seed or self.self_domain or "pereval.portbuddy.tech"
        self._apply_cluster_config(load_cluster_config(cluster_config_path))
        if cluster_config_path and cluster_config_path.is_file():
            try:
                self.cluster_config_mtime = cluster_config_path.stat().st_mtime
            except Exception:
                pass

        self.salt_day = int(time.time() // 86400)
        self.salt = self._compute_daily_salt(self.salt_day)

        self.minute_buckets = {}  # minute_ts -> Bucket
        self.hour_buckets = {}    # hour_ts   -> Bucket
        self.recent_5m_users = {}  # ip_hash -> last_seen_ts
        self.active_connections = 0

        self.sni_tailer = LogTailer(sni_log_path) if sni_log_path else None
        self.http_tailer = LogTailer(http_log_path) if http_log_path else None

    def _apply_cluster_config(self, cfg: dict):
        primary_ip = extract_ip_only(cfg.get("primary") or "")
        cfg_domain = normalize_domain(cfg.get("domain") or "")
        if cfg_domain and not self.self_domain:
            self.self_domain = cfg_domain
        self.cluster_primary_ip = primary_ip

        ignored = {"127.0.0.1", "::1"}
        if primary_ip:
            ignored.add(primary_ip)

        workers = []
        for item in cfg.get("workers") or []:
            if isinstance(item, str):
                raw_ip = item.strip()
                clean_ip = extract_ip_only(raw_ip)
                if clean_ip:
                    ignored.add(clean_ip)
                    workers.append({"ip": raw_ip, "clean_ip": clean_ip, "name": clean_ip})
            elif isinstance(item, dict):
                raw_ip = str(item.get("ip") or "").strip()
                clean_ip = extract_ip_only(raw_ip)
                if clean_ip:
                    ignored.add(clean_ip)
                    w_entry = dict(item)
                    w_entry["ip"] = raw_ip
                    w_entry["clean_ip"] = clean_ip
                    workers.append(w_entry)

        self.cluster_workers = workers
        self.ignored_ips = ignored

        if self.custom_salt_seed:
            self.salt_seed = self.custom_salt_seed
        else:
            dom = cfg_domain or self.self_domain or "pereval.portbuddy.tech"
            self.salt_seed = f"{dom}:{primary_ip}" if primary_ip else dom

    def _compute_daily_salt(self, day: int) -> str:
        raw = f"pereval-stats-v1:{self.salt_seed}:{day}".encode("utf-8")
        return hashlib.blake2b(raw, digest_size=16).hexdigest()

    def _rotate_salt_if_needed(self, now: int):
        day = now // 86400
        expected_salt = self._compute_daily_salt(day)
        if day != self.salt_day or self.salt != expected_salt:
            self.salt_day = day
            self.salt = expected_salt

    def hash_ip(self, ip: str) -> int:
        h = hashlib.blake2b(f"{self.salt}:{ip}".encode("utf-8"), digest_size=8).digest()
        return int.from_bytes(h, "big")

    def reload_service_map_if_changed(self):
        if self.service_map_path and self.service_map_path.is_file():
            try:
                mtime = self.service_map_path.stat().st_mtime
                if mtime != self.service_map_mtime:
                    self.service_map = load_service_map(self.service_map_path)
                    self.service_map_mtime = mtime
            except Exception:
                pass
        if self.cluster_config_path and self.cluster_config_path.is_file():
            try:
                mtime = self.cluster_config_path.stat().st_mtime
                if mtime != self.cluster_config_mtime:
                    self._apply_cluster_config(load_cluster_config(self.cluster_config_path))
                    self.cluster_config_mtime = mtime
                    self.salt = self._compute_daily_salt(self.salt_day)
            except Exception:
                pass

    def load_state(self, now: int = None) -> dict:
        """Load persisted buckets and file cursors if state file is fresh (< 24h)."""
        if now is None:
            now = int(time.time())
        self._rotate_salt_if_needed(now)
        if not self.state_path or not self.state_path.is_file():
            return {}
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
            saved_at = int(raw.get("saved_at", 0))
            if now - saved_at > 86400:
                return {}
            for bdata in raw.get("minute_buckets", []):
                b = Bucket.from_dict(bdata)
                if b.ts >= ((now // 60) - 59) * 60:
                    self.minute_buckets[b.ts] = b
            for bdata in raw.get("hour_buckets", []):
                b = Bucket.from_dict(bdata)
                if b.ts >= ((now // 3600) - 23) * 3600:
                    self.hour_buckets[b.ts] = b
            for ip_hash_str, seen_ts in (raw.get("recent_5m_users") or {}).items():
                if now - int(seen_ts) <= 300:
                    self.recent_5m_users[int(ip_hash_str)] = int(seen_ts)
            return raw.get("cursors") or {}
        except Exception as exc:
            print(f"[pereval-stats] warning: could not load state {self.state_path}: {exc}", file=sys.stderr)
            return {}

    def save_state(self, now: int = None):
        if not self.state_path:
            return
        if now is None:
            now = int(time.time())
        cursors = {}
        for key, tailer in (("sni", self.sni_tailer), ("http", self.http_tailer)):
            if tailer and tailer.ino is not None:
                cursors[key] = {
                    "path": str(tailer.path),
                    "ino": tailer.ino,
                    "offset": tailer.offset,
                }
        payload = {
            "saved_at": now,
            "salt": self.salt,
            "salt_day": self.salt_day,
            "cursors": cursors,
            "minute_buckets": [b.to_dict() for b in self.minute_buckets.values()],
            "hour_buckets": [b.to_dict() for b in self.hour_buckets.values()],
            "recent_5m_users": {str(k): v for k, v in self.recent_5m_users.items()},
        }
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.state_path)
        except Exception as exc:
            print(f"[pereval-stats] warning: could not save state {self.state_path}: {exc}", file=sys.stderr)

    def bootstrap_logs(self, cursors: dict, now: int = None):
        """Backfill last 24h from rotated (.1) and current log files without double counting."""
        if now is None:
            now = int(time.time())
        self._rotate_salt_if_needed(now)
        for key, tailer, parser in (
            ("sni", self.sni_tailer, self.ingest_sni_line),
            ("http", self.http_tailer, self.ingest_http_line),
        ):
            if tailer is None:
                continue
            cur = cursors.get(key)
            path = tailer.path
            rotated = Path(f"{path}.1")

            if cur and path.is_file():
                try:
                    st = path.stat()
                    saved_ino = cur.get("ino")
                    saved_off = int(cur.get("offset", 0))
                    if st.st_ino == saved_ino and st.st_size >= saved_off:
                        tailer.open_at(saved_off)
                        for line in tailer.read_new_lines():
                            parser(line, now)
                        continue
                    # Check if rotated .1 matches saved_ino
                    if rotated.is_file():
                        rst = rotated.stat()
                        if rst.st_ino == saved_ino and rst.st_size > saved_off:
                            self._read_file_from(rotated, saved_off, parser, now)
                            tailer.open_at(0)
                            for line in tailer.read_new_lines():
                                parser(line, now)
                            continue
                except Exception:
                    pass

            # Fresh backfill: read .1 if recent, then current file from 0
            if rotated.is_file():
                try:
                    if now - rotated.stat().st_mtime <= 86400:
                        self._read_file_from(rotated, 0, parser, now)
                except Exception:
                    pass
            if path.is_file():
                tailer.open_at(0)
                for line in tailer.read_new_lines():
                    parser(line, now)

    def _read_file_from(self, path: Path, offset: int, parser, now: int):
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fp:
                if offset > 0:
                    fp.seek(offset)
                for line in fp:
                    parser(line, now)
        except Exception:
            pass

    def _is_ignored_event(self, ip: str, domain: str, upstream: str, status: int) -> bool:
        if not ip or ip in self.ignored_ips or ip.startswith("127."):
            return True
        if not domain or domain == "-" or domain == self.self_domain:
            return True
        if self.self_domain and domain.endswith("." + self.self_domain):
            return True
        up_clean = (upstream or "").strip()
        if not up_clean or up_clean == "-" or "127.0.0.1:9" in up_clean or "127.0.0.1:8443" in up_clean:
            return True
        if status == 403 and up_clean == "-":
            return True
        return False

    def record_event(self, ip: str, ts: int, domain: str, sent: int, recv: int, now: int = None):
        if now is None:
            now = int(time.time())
        self._rotate_salt_if_needed(now)
        if ts < now - 86400 or ts > now + 300:
            return

        ip_hash = self.hash_ip(ip)
        service, category = resolve_service(domain, self.service_map)

        hour_ts = (ts // 3600) * 3600
        min_hour_ts = ((now // 3600) - 23) * 3600
        if hour_ts >= min_hour_ts:
            hb = self.hour_buckets.get(hour_ts)
            if hb is None:
                hb = Bucket(hour_ts)
                self.hour_buckets[hour_ts] = hb
            hb.add_event(ip_hash, service, category, sent, recv)

        min_ts = (ts // 60) * 60
        min_window_ts = ((now // 60) - 59) * 60
        if min_ts >= min_window_ts:
            mb = self.minute_buckets.get(min_ts)
            if mb is None:
                mb = Bucket(min_ts)
                self.minute_buckets[min_ts] = mb
            mb.add_event(ip_hash, service, category, sent, recv)

        if ts >= now - 300:
            prev = self.recent_5m_users.get(ip_hash, 0)
            if ts > prev:
                self.recent_5m_users[ip_hash] = ts

    def ingest_sni_line(self, line: str, now: int = None):
        m = SNI_LOG_RE.match(line.strip())
        if not m:
            return
        ip = m.group("ip")
        domain = normalize_domain(m.group("sni"))
        upstream = m.group("up")
        status = int(m.group("status"))
        if self._is_ignored_event(ip, domain, upstream, status):
            return
        ts = parse_nginx_time(m.group("time"))
        sent = int(m.group("sent"))
        recv = int(m.group("recv"))
        self.record_event(ip, ts, domain, sent, recv, now=now)

    def ingest_http_line(self, line: str, now: int = None):
        m = HTTP_LOG_RE.match(line.strip())
        if not m:
            return
        ip = m.group("ip")
        domain = normalize_domain(m.group("host"))
        upstream = m.group("up")
        status = int(m.group("status"))
        if self._is_ignored_event(ip, domain, upstream, status):
            return
        ts = parse_nginx_time(m.group("time"))
        sent = int(m.group("sent"))
        req = m.group("req") or ""
        recv = len(req) + len(domain) + 64
        self.record_event(ip, ts, domain, sent, recv, now=now)

    def sample_proc_net_tcp(self, now: int = None):
        """Inspect /proc/net/tcp for ESTABLISHED (01) sockets on local ports 443 (01BB) and 80 (0050)."""
        if now is None:
            now = int(time.time())
        active_conns = 0
        active_ips = set()

        for path in (self.proc_tcp_path, self.proc_tcp6_path):
            if not path or not path.is_file():
                continue
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except Exception:
                continue
            for line in lines[1:]:
                parts = line.split()
                if len(parts) < 4:
                    continue
                local_addr = parts[1]
                rem_addr = parts[2]
                state = parts[3]
                if state != "01":  # 01 = TCP_ESTABLISHED
                    continue
                if ":" not in local_addr or ":" not in rem_addr:
                    continue
                _, lport_hex = local_addr.split(":", 1)
                if lport_hex.upper() not in ("01BB", "0050"):
                    continue
                rhost_hex, _ = rem_addr.split(":", 1)
                ip_str = self._decode_proc_ip(rhost_hex)
                if not ip_str or ip_str.startswith("127.") or ip_str == "::1" or ip_str in self.ignored_ips:
                    continue
                active_conns += 1
                active_ips.add(ip_str)

        self.active_connections = active_conns
        self._rotate_salt_if_needed(now)
        min_ts = (now // 60) * 60
        hour_ts = (now // 3600) * 3600
        for ip_str in active_ips:
            ip_hash = self.hash_ip(ip_str)
            self.recent_5m_users[ip_hash] = now
            mb = self.minute_buckets.get(min_ts)
            if mb is None:
                mb = Bucket(min_ts)
                self.minute_buckets[min_ts] = mb
            mb.users.add(ip_hash)
            hb = self.hour_buckets.get(hour_ts)
            if hb is None:
                hb = Bucket(hour_ts)
                self.hour_buckets[hour_ts] = hb
            hb.users.add(ip_hash)

    @staticmethod
    def _decode_proc_ip(hex_ip: str) -> str:
        try:
            if len(hex_ip) == 8:
                b = bytes.fromhex(hex_ip)
                # Little-endian 32-bit IPv4 on x86/ARM Linux
                return f"{b[3]}.{b[2]}.{b[1]}.{b[0]}"
            if len(hex_ip) == 32:
                # Check IPv4-mapped IPv6 address (0000000000000000FFFF0000xxxxxxxx)
                if hex_ip[:24].upper() in ("0000000000000000FFFF0000", "00000000000000000000FFFF"):
                    b = bytes.fromhex(hex_ip[24:])
                    return f"{b[3]}.{b[2]}.{b[1]}.{b[0]}"
                return hex_ip.lower()
        except Exception:
            pass
        return ""

    def prune(self, now: int = None):
        if now is None:
            now = int(time.time())
        self._rotate_salt_if_needed(now)

        min_cutoff = ((now // 60) - 59) * 60
        for k in [k for k in self.minute_buckets if k < min_cutoff]:
            del self.minute_buckets[k]

        hour_cutoff = ((now // 3600) - 23) * 3600
        for k in [k for k in self.hour_buckets if k < hour_cutoff]:
            del self.hour_buckets[k]

        for k in [k for k, ts in self.recent_5m_users.items() if now - ts > 300]:
            del self.recent_5m_users[k]

    def tick(self, now: int = None):
        if now is None:
            now = int(time.time())
        self.reload_service_map_if_changed()

        if self.sni_tailer:
            for line in self.sni_tailer.read_new_lines():
                self.ingest_sni_line(line, now)
        if self.http_tailer:
            for line in self.http_tailer.read_new_lines():
                self.ingest_http_line(line, now)

        self.sample_proc_net_tcp(now)
        self.prune(now)

    @staticmethod
    def _aggregate_top(buckets, attr: str, key_name: str, extra_field: str, limit: int = 25) -> list:
        agg = {}
        for b in buckets:
            source = getattr(b, attr)
            for name, item in source.items():
                entry = agg.get(name)
                if entry is None:
                    entry = {
                        extra_field: item[extra_field],
                        "requests": 0,
                        "bytes": 0,
                        "users": set(),
                    }
                    agg[name] = entry
                entry["requests"] += item["requests"]
                entry["bytes"] += item["bytes"]
                entry["users"].update(item["users"])

        ranked = sorted(
            agg.items(),
            key=lambda kv: (kv[1]["requests"], len(kv[1]["users"]), kv[1]["bytes"]),
            reverse=True,
        )[:limit]

        return [
            {
                key_name: name,
                extra_field: data[extra_field],
                "requests": data["requests"],
                "unique_users": len(data["users"]),
                "bytes": data["bytes"],
            }
            for name, data in ranked
        ]

    def _should_pull_workers(self) -> bool:
        if self.role == "worker":
            return False
        return bool(self.cluster_workers)

    def _worker_stats_url(self, worker: dict) -> str:
        if worker.get("stats_url"):
            return str(worker["stats_url"])
        raw_ip = str(worker.get("ip") or "").strip()
        if raw_ip.startswith(("http://", "https://")):
            return raw_ip
        if worker.get("stats_port"):
            return f"http://{worker['clean_ip']}:{worker['stats_port']}/node-stats.json"
        return f"http://{raw_ip}/node-stats.json"

    def _fetch_single_worker_snapshot(self, worker: dict) -> tuple:
        w_key = str(worker.get("ip") or worker.get("clean_ip") or "")
        url = self._worker_stats_url(worker)
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "pereval-stats/1.0",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.worker_timeout) as resp:
                if getattr(resp, "status", 200) != 200:
                    return (w_key, None)
                body = resp.read().decode("utf-8", errors="replace")
            data = json.loads(body)
            if isinstance(data, dict):
                return (w_key, data)
        except Exception:
            pass
        return (w_key, None)

    def fetch_worker_snapshots(self, now: int = None) -> list:
        """Poll /node-stats.json from all configured workers in parallel."""
        if not self._should_pull_workers():
            return []
        if now is None:
            now = int(time.time())

        workers = list(self.cluster_workers)
        max_workers = min(16, max(1, len(workers)))
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            results = list(pool.map(self._fetch_single_worker_snapshot, workers))

        snapshots = []
        for w_key, data in results:
            if data is not None:
                self.worker_snapshot_cache[w_key] = {
                    "fetched_at": now,
                    "data": data,
                }
                snapshots.append(data)
            else:
                cached = self.worker_snapshot_cache.get(w_key)
                if cached and (now - int(cached.get("fetched_at", 0))) <= self.worker_stale_ttl:
                    stale_copy = dict(cached["data"])
                    stale_copy["active_connections"] = 0
                    snapshots.append(stale_copy)
                elif cached:
                    del self.worker_snapshot_cache[w_key]
        return snapshots

    def _merged_cluster_state(self, now: int) -> tuple:
        """Merge local buckets with all fetched worker snapshots without mutating local state."""
        if not self._should_pull_workers():
            return (
                self.minute_buckets,
                self.hour_buckets,
                self.recent_5m_users,
                self.active_connections,
            )

        merged_min = {ts: b.clone() for ts, b in self.minute_buckets.items()}
        merged_hour = {ts: b.clone() for ts, b in self.hour_buckets.items()}
        merged_5m = dict(self.recent_5m_users)
        total_active_conns = self.active_connections

        worker_snapshots = self.fetch_worker_snapshots(now=now)
        for snap in worker_snapshots:
            try:
                total_active_conns += max(0, int(snap.get("active_connections", 0)))
            except Exception:
                pass

            for ip_hash_str, seen_ts in (snap.get("recent_5m_users") or {}).items():
                try:
                    seen_int = int(seen_ts)
                    if now - seen_int <= 300:
                        ip_h = int(ip_hash_str)
                        if seen_int > merged_5m.get(ip_h, 0):
                            merged_5m[ip_h] = seen_int
                except Exception:
                    continue

            for bdata in snap.get("minute_buckets") or []:
                try:
                    wb = Bucket.from_dict(bdata)
                except Exception:
                    continue
                existing = merged_min.get(wb.ts)
                if existing is None:
                    merged_min[wb.ts] = wb
                else:
                    existing.merge(wb)

            for bdata in snap.get("hour_buckets") or []:
                try:
                    wb = Bucket.from_dict(bdata)
                except Exception:
                    continue
                existing = merged_hour.get(wb.ts)
                if existing is None:
                    merged_hour[wb.ts] = wb
                else:
                    existing.merge(wb)

        return (merged_min, merged_hour, merged_5m, total_active_conns)

    def build_payload(self, now: int = None) -> dict:
        if now is None:
            now = int(time.time())
        now_min = (now // 60) * 60
        now_hour = (now // 3600) * 3600

        minute_buckets, hour_buckets, recent_5m_users, active_connections = (
            self._merged_cluster_state(now)
        )

        per_minute = []
        users_1h = set()
        users_5m = set(recent_5m_users.keys())
        requests_1h = 0
        bytes_1h = 0
        active_min_buckets = []

        for i in range(59, -1, -1):
            ts = now_min - i * 60
            b = minute_buckets.get(ts)
            if b is not None:
                active_min_buckets.append(b)
                reqs = b.requests
                u_cnt = len(b.users)
                b_tot = b.bytes_sent + b.bytes_recv
                users_1h.update(b.users)
                if i < 5:
                    users_5m.update(b.users)
                requests_1h += reqs
                bytes_1h += b_tot
            else:
                reqs = 0
                u_cnt = 0
                b_tot = 0
            per_minute.append({
                "ts": ts,
                "requests": reqs,
                "unique_users": u_cnt,
                "bytes": b_tot,
            })

        per_hour = []
        users_24h = set(users_1h)
        requests_24h = 0
        bytes_24h = 0
        bytes_sent_24h = 0
        bytes_recv_24h = 0
        active_hour_buckets = []

        for i in range(23, -1, -1):
            ts = now_hour - i * 3600
            b = hour_buckets.get(ts)
            if b is not None:
                active_hour_buckets.append(b)
                reqs = b.requests
                u_cnt = len(b.users)
                b_tot = b.bytes_sent + b.bytes_recv
                users_24h.update(b.users)
                requests_24h += reqs
                bytes_24h += b_tot
                bytes_sent_24h += b.bytes_sent
                bytes_recv_24h += b.bytes_recv
            else:
                reqs = 0
                u_cnt = 0
                b_tot = 0
            per_hour.append({
                "ts": ts,
                "requests": reqs,
                "unique_users": u_cnt,
                "bytes": b_tot,
            })

        curr_min_bucket = minute_buckets.get(now_min)
        prev_min_bucket = minute_buckets.get(now_min - 60)
        if curr_min_bucket and curr_min_bucket.requests > 0:
            requests_current_min = curr_min_bucket.requests
        elif (now - now_min) < 15 and prev_min_bucket:
            requests_current_min = prev_min_bucket.requests
        else:
            requests_current_min = curr_min_bucket.requests if curr_min_bucket else 0

        peak_requests_1m = max((m["requests"] for m in per_minute), default=0)
        peak_requests_1h = max((h["requests"] for h in per_hour), default=0)

        top_services_24h = self._aggregate_top(
            active_hour_buckets, "services", "service", "category", limit=25
        )
        top_services_1h = self._aggregate_top(
            active_min_buckets, "services", "service", "category", limit=25
        )

        return {
            "generated_at": now,
            "window_seconds": 86400,
            "live": {
                "active_connections": active_connections,
                "online_users_5m": len(users_5m),
                "unique_users_1h": len(users_1h),
                "unique_users_24h": len(users_24h),
                "requests_current_min": requests_current_min,
                "peak_requests_1m": peak_requests_1m,
                "requests_1h": requests_1h,
                "peak_requests_1h": peak_requests_1h,
                "requests_24h": requests_24h,
                "bytes_1h": bytes_1h,
                "bytes_24h": bytes_24h,
                "bytes_sent_24h": bytes_sent_24h,
                "bytes_recv_24h": bytes_recv_24h,
            },
            "per_minute": per_minute,
            "per_hour": per_hour,
            "top_services_24h": top_services_24h,
            "top_services_1h": top_services_1h,
        }

    def build_node_snapshot(self, now: int = None) -> dict:
        """Build per-node local bucket snapshot for cluster-wide aggregation."""
        if now is None:
            now = int(time.time())
        self._rotate_salt_if_needed(now)
        return {
            "generated_at": now,
            "salt_day": self.salt_day,
            "active_connections": self.active_connections,
            "recent_5m_users": {str(k): v for k, v in self.recent_5m_users.items()},
            "minute_buckets": [b.to_dict() for b in sorted(self.minute_buckets.values(), key=lambda x: x.ts)],
            "hour_buckets": [b.to_dict() for b in sorted(self.hour_buckets.values(), key=lambda x: x.ts)],
        }

    def write_node_snapshot(self, now: int = None):
        """Atomically write local node snapshot to /var/www/geoblock/node-stats.json."""
        if not self.node_output_path:
            return None
        snapshot = self.build_node_snapshot(now=now)
        try:
            self.node_output_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = self.node_output_path.parent / f".{self.node_output_path.name}.tmp"
            tmp_path.write_text(
                json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            tmp_path.replace(self.node_output_path)
        except Exception as exc:
            print(f"[pereval-stats] warning: could not write node snapshot {self.node_output_path}: {exc}", file=sys.stderr)
        return snapshot

    def write_output(self, now: int = None):
        if self.node_output_path:
            self.write_node_snapshot(now=now)
        payload = self.build_payload(now=now)
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.output_path.parent / f".{self.output_path.name}.tmp"
        tmp_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        tmp_path.replace(self.output_path)
        return payload


def resolve_default_service_map() -> Path:
    prod = Path("/etc/nginx/geoblock/service-map.json")
    if prod.is_file():
        return prod
    script_dir = Path(__file__).resolve().parent
    build_path = script_dir.parent / "build" / "service-map.json"
    if build_path.is_file():
        return build_path
    return script_dir / "service-map.json"


def resolve_default_cluster_config() -> Path:
    prod = Path("/etc/nginx/geoblock/cluster-nodes.json")
    if prod.is_file():
        return prod
    script_dir = Path(__file__).resolve().parent
    build_path = script_dir.parent / "build" / "cluster-nodes.json"
    if build_path.is_file():
        return build_path
    return script_dir / "cluster-nodes.json"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="Собирает метрики nginx (sni.log / http-proxy.log) в stats.json."
    )
    p.add_argument("--sni-log", default="/var/log/nginx/sni.log",
                   help="путь к /var/log/nginx/sni.log")
    p.add_argument("--http-log", default="/var/log/nginx/http-proxy.log",
                   help="путь к /var/log/nginx/http-proxy.log")
    p.add_argument("--service-map", default=None,
                   help="путь к service-map.json")
    p.add_argument("--cluster-config", default=None,
                   help="путь к cluster-nodes.json")
    p.add_argument("--node-output", default="/var/www/geoblock/node-stats.json",
                   help="путь для атомарной записи локального снимка node-stats.json")
    p.add_argument("--output", default="/var/www/geoblock/stats.json",
                   help="путь для атомарной записи stats.json")
    p.add_argument("--state-file", default="/var/lib/pereval-stats/state.json",
                   help="путь для сохранения состояния между перезапусками")
    p.add_argument("--proc-tcp", default="/proc/net/tcp",
                   help="путь к /proc/net/tcp")
    p.add_argument("--proc-tcp6", default="/proc/net/tcp6",
                   help="путь к /proc/net/tcp6")
    p.add_argument("--self-domain", default="pereval.portbuddy.tech",
                   help="собственный домен сервиса (исключается из прокси-метрик)")
    p.add_argument("--role", choices=["auto", "primary", "worker"], default="auto",
                   help="роль узла: primary (опрашивает воркеров), worker (только локальный сбор) или auto")
    p.add_argument("--salt-seed", default=None,
                   help="переопределить seed для суточной ротации соли хеширования IP")
    p.add_argument("--worker-timeout", type=float, default=2.0,
                   help="таймаут HTTP-опроса /node-stats.json у воркеров в секундах (по умолчанию 2)")
    p.add_argument("--worker-stale-ttl", type=int, default=60,
                   help="время жизни кэша снимка воркера при временной недоступности в секундах (по умолчанию 60)")
    p.add_argument("--interval", type=float, default=5.0,
                   help="интервал обновления в секундах (по умолчанию 5)")
    p.add_argument("--now", type=int, default=None,
                   help="фиксированное время unix epoch (для тестирования)")
    p.add_argument("--once", action="store_true",
                   help="обработать логи один раз, записать stats.json и выйти")
    args = p.parse_args(argv)

    service_map_path = Path(args.service_map) if args.service_map else resolve_default_service_map()
    cluster_config_path = Path(args.cluster_config) if args.cluster_config else resolve_default_cluster_config()
    node_output_path = Path(args.node_output) if args.node_output else None
    output_path = Path(args.output)

    collector = StatsCollector(
        service_map_path=service_map_path,
        sni_log_path=Path(args.sni_log) if args.sni_log else None,
        http_log_path=Path(args.http_log) if args.http_log else None,
        output_path=output_path,
        state_path=Path(args.state_file) if args.state_file else None,
        proc_tcp_path=Path(args.proc_tcp) if args.proc_tcp else None,
        proc_tcp6_path=Path(args.proc_tcp6) if args.proc_tcp6 else None,
        self_domain=args.self_domain,
        cluster_config_path=cluster_config_path,
        node_output_path=node_output_path,
        role=args.role,
        salt_seed=args.salt_seed,
        worker_timeout=args.worker_timeout,
        worker_stale_ttl=args.worker_stale_ttl,
    )

    now = args.now if args.now is not None else int(time.time())
    cursors = collector.load_state(now=now)
    collector.bootstrap_logs(cursors, now=now)
    collector.tick(now=now)
    collector.write_output(now=now)
    collector.save_state(now=now)

    if args.once:
        return 0

    stop_requested = False

    def handle_signal(signum, _frame):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    last_state_save = time.time()
    while not stop_requested:
        time.sleep(max(0.5, args.interval))
        if stop_requested:
            break
        tick_now = int(time.time())
        collector.tick(now=tick_now)
        collector.write_output(now=tick_now)
        if tick_now - last_state_save >= 60:
            collector.save_state(now=tick_now)
            last_state_save = tick_now

    collector.save_state(now=int(time.time()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
