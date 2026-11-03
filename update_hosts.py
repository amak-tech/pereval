#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Manage Pereval domains in /etc/hosts for macOS (Scenario B: root access with corporate WARP VPN).

Usage:
    sudo python3 update_hosts.py               # Install or update Pereval entries in /etc/hosts
    sudo python3 update_hosts.py --remove      # Remove Pereval entries from /etc/hosts
    python3 update_hosts.py --dry-run          # Print generated /etc/hosts block without writing
"""

import argparse
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_IP = "153.80.200.170"
START_MARKER = "# >>> PEREVAL START"
END_MARKER = "# <<< PEREVAL END"

COMMON_SUBDOMAINS = (
    "www",
    "api",
    "auth",
    "cdn",
    "platform",
    "chat",
    "ab",
    "accounts",
    "app",
    "static",
    "assets",
)


def load_domains(services_path: Path, dnsmasq_path: Path) -> list[str]:
    """Load domain list from services.yaml (with fallback if PyYAML is unavailable under sudo)."""
    if services_path.is_file():
        try:
            import yaml  # type: ignore

            data = yaml.safe_load(services_path.read_text(encoding="utf-8"))
            domains = [
                str(d).strip().lower()
                for cat in data.get("categories", [])
                for svc in cat.get("services", [])
                for d in svc.get("domains", [])
                if d
            ]
            if domains:
                return domains
        except ImportError:
            pass

    if dnsmasq_path.is_file():
        domains = []
        for line in dnsmasq_path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^address=/([^/]+)/", line.strip())
            if m:
                domains.append(m.group(1).lower())
        if domains:
            return domains

    if services_path.is_file():
        # Minimal YAML fallback parser for services.yaml categories -> services -> domains
        domains = []
        in_categories = False
        in_domains = False
        for raw_line in services_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            if not line.startswith(" "):
                in_categories = line.startswith("categories:")
                in_domains = False
                continue
            if not in_categories:
                continue
            stripped = line.lstrip()
            if stripped.startswith("domains:"):
                in_domains = True
                continue
            if stripped.startswith("- ") and in_domains:
                val = stripped[2:].strip()
                if val and ":" not in val:
                    domains.append(val.lower())
            elif not stripped.startswith("- "):
                in_domains = False
        if domains:
            return domains

    sys.exit(f"Error: Could not load domains from {services_path} or {dnsmasq_path}")


def build_hosts_block(domains: list[str], ip: str) -> str:
    seen: set[str] = set()
    ordered_hosts: list[str] = []

    def add_host(h: str) -> None:
        if h not in seen:
            seen.add(h)
            ordered_hosts.append(h)

    for d in domains:
        add_host(d)
        # Expand common subdomains for apex domains (e.g. claude.ai -> www.claude.ai, api.claude.ai, ...)
        if d.count(".") == 1:
            for sub in COMMON_SUBDOMAINS:
                add_host(f"{sub}.{d}")

    lines = [START_MARKER]
    # Group up to 9 hostnames per line to keep /etc/hosts fast and compact
    chunk_size = 9
    for i in range(0, len(ordered_hosts), chunk_size):
        chunk = ordered_hosts[i : i + chunk_size]
        lines.append(f"{ip}\t" + " ".join(chunk))
    lines.append(END_MARKER)
    return "\n".join(lines)


def remove_existing_block(content: str) -> str:
    pattern = re.compile(
        r"\n?" + re.escape(START_MARKER) + r".*?" + re.escape(END_MARKER) + r"\n?",
        re.DOTALL,
    )
    cleaned = pattern.sub("\n", content)
    return cleaned.rstrip("\n") + "\n"


def flush_dns_cache() -> None:
    if platform.system() != "Darwin":
        return
    subprocess.run(["dscacheutil", "-flushcache"], check=False)
    subprocess.run(["killall", "-HUP", "mDNSResponder"], check=False)


def main() -> None:
    base_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="Install or remove Pereval domain mappings in /etc/hosts."
    )
    parser.add_argument(
        "--ip",
        default=DEFAULT_IP,
        help=f"Pereval server IP address (default: {DEFAULT_IP})",
    )
    parser.add_argument(
        "--services",
        type=Path,
        default=base_dir / "services.yaml",
        help="Path to services.yaml",
    )
    parser.add_argument(
        "--hosts-file",
        type=Path,
        default=Path("/etc/hosts"),
        help="Path to hosts file (default: /etc/hosts)",
    )
    parser.add_argument(
        "--remove",
        action="store_true",
        help="Remove Pereval block from /etc/hosts",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the generated /etc/hosts block without modifying files",
    )
    args = parser.parse_args()

    if args.dry_run:
        domains = load_domains(args.services, base_dir / "dnsmasq-geoblock.conf")
        print(build_hosts_block(domains, args.ip))
        return

    if os.geteuid() != 0 and args.hosts_file == Path("/etc/hosts"):
        sys.exit("Error: Root privileges required. Run with: sudo python3 update_hosts.py")

    if not args.hosts_file.exists():
        sys.exit(f"Error: Hosts file not found: {args.hosts_file}")

    original = args.hosts_file.read_text(encoding="utf-8")
    cleaned = remove_existing_block(original)

    if args.remove:
        if cleaned == original:
            print(f"No Pereval entries found in {args.hosts_file}.")
            return
        args.hosts_file.write_text(cleaned, encoding="utf-8")
        flush_dns_cache()
        print(f"Removed Pereval entries from {args.hosts_file} and flushed macOS DNS cache.")
        return

    domains = load_domains(args.services, base_dir / "dnsmasq-geoblock.conf")
    block = build_hosts_block(domains, args.ip)
    updated = cleaned + "\n" + block + "\n"
    args.hosts_file.write_text(updated, encoding="utf-8")
    flush_dns_cache()
    print(
        f"Updated {args.hosts_file} with {len(domains)} base domains (-> {args.ip}) "
        "and flushed macOS DNS cache."
    )


if __name__ == "__main__":
    main()
