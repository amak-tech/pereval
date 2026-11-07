# AGENTS.md — Pereval (`sutton`) Project Documentation & Architecture Guide

This document provides a comprehensive overview of **Перевал (Pereval)** (production URL: `https://pereval.portbuddy.tech`, repository: `sutton` / `pereval`), including its purpose, network architecture, how it is built, runtime components, deployment pipeline, and rules for making changes.

---

## 1. Purpose of the Service

**Pereval** is a free, zero-client **Smart DNS and transparent SNI/HTTP reverse proxy** hosted in Kazakhstan (default server IP: `153.80.200.170`).

### Problem Statement
Many foreign AI platforms, LLM APIs, cloud providers, and software engineering tools restrict access from Russian (`RU`) and Belarusian (`BY`) IP addresses at their own geo-IP edge (returning errors such as *"Unavailable in your country"* or *"Access denied"*).

Using a full-tunnel VPN routes all device traffic through a foreign server, which:
- Degrades bandwidth and increases latency for everyday traffic.
- Breaks access to domestic Russian/Belarusian services (banks, Gosuslugi, marketplaces, media, corporate intranets) that actively block foreign IP addresses.
- Interferes with local Docker containers, LAN resources, or corporate VPNs.

### How Pereval Solves It
Pereval routes **only** a curated allowlist of foreign AI and developer tool services (64 logical services across 2 categories, covering 214 base domains and all their subdomains) through the Kazakhstan proxy server, while **all other internet traffic connects directly** via the user's ISP:
1. **Selective DNS Resolution:** When a client queries a domain on the allowlist (e.g., `claude.ai`, `chatgpt.com`, `gemini.google.com`, `cursor.com`, `jetbrains.com`), Pereval's DNS server returns the Kazakhstan proxy IP (`153.80.200.170`). For any other domain (e.g., `gosuslugi.ru`, `ozon.ru`, `google.com`), Pereval forwards the query to upstream public resolvers (`1.1.1.1`, `8.8.8.8`) and returns the real IP address.
2. **Transparent TLS Routing (SNI Proxy):** When the client connects to `153.80.200.170:443`, `nginx` inspects the unencrypted `Server Name Indication (SNI)` extension in the TLS `ClientHello` packet (`ssl_preread`) and splices the TCP connection directly to the real upstream server from its Kazakhstan IP.
3. **End-to-End Encryption Preserved:** Pereval **does not terminate TLS** for proxied domains. It holds no private keys or custom CA certificates for third-party sites. The client verifies the genuine TLS certificate of OpenAI, Anthropic, Google, JetBrains, etc., and the proxy cannot inspect or modify encrypted HTTP payloads, headers, or API keys.
4. **No Client Software or Accounts:** Users configure Pereval in under a minute using standard OS/browser/router settings:
   - **Browsers (Chrome, Firefox, Brave, Edge, Yandex):** DNS-over-HTTPS (DoH) at `https://pereval.portbuddy.tech/dns-query`
   - **iOS / iPadOS:** One-click signed/managed Apple Configuration Profile (`/dns.mobileconfig`) using DNS-over-TLS (DoT)
   - **Android:** Built-in *Private DNS* (`pereval.portbuddy.tech`, DoT over port `853`)
   - **macOS / Windows / Linux / Home Routers:** Standard IPv4 DNS (`153.80.200.170`)
   - **Corporate VPN / Custom DNS Coexistence:** Local `/etc/hosts` injection script (`update_hosts.py`)

### Legal & Security Posture
- **Not a censorship-circumvention tool:** Pereval operates strictly on a fixed allowlist of lawful foreign IT/AI platforms that apply their own geo-restrictions and does not proxy resources prohibited by RU/BY regulators.
- **Closed Relay (Anti-Abuse):** Both the TLS stream proxy (port `443`) and HTTP proxy (port `80`) strictly validate incoming `SNI` / `Host` headers against generated allowlist maps (`nginx-sni-allow.map`, `nginx-host-allow.map`). Unlisted domains are immediately dropped (`127.0.0.1:9` in `stream`, `HTTP 403` in `http`) so the server cannot be abused as an open proxy.

---

## 2. System Architecture & End-to-End Request Flows

All server-side components run on a single Linux VPS (Debian/Ubuntu) and interact as follows:

```text
                       ┌─────────────────────────────────────────────────────────────┐
                       │                  Pereval Server (Kazakhstan)                │
                       │               153.80.200.170 / pereval.portbuddy.tech       │
                       │                                                             │
  [Client Device]      │  ┌───────────────────────────────────────────────────────┐  │
  1. DNS Query:        │  │ DNS Frontend                                          │  │
   • UDP/TCP :53 ──────┼─►│ • dnsmasq (:53) ◄────────────────────┐                │  │
   • DoT TCP :853 ─────┼─►│ • nginx stream SSL (:853) ───────────┤                │  │
   • DoH HTTPS :443 ───┼─►│ • nginx (:443->:8443) /dns-query     │                │  │
     (/dns-query)      │  │     └─► doh_proxy.py (127.0.0.1:8053)┘                │  │
                       │  │                                                       │  │
                       │  │ If domain in allowlist -> returns A 153.80.200.170    │  │
                       │  │ Else -> forwards to 1.1.1.1 / 8.8.8.8                 │  │
                       │  └───────────────────────────────────────────────────────┘  │
                       │                                                             │
  2. App Traffic:      │  ┌───────────────────────────────────────────────────────┐  │
   • HTTPS TCP :443 ───┼─►│ nginx stream (:443, ssl_preread on)                   │  │
                       │  │ • SNI == pereval.portbuddy.tech -> 127.0.0.1:8443     │  │
                       │  │ • SNI in nginx-sni-allow.map    -> Real Origin (:443) │──┼──► [AI / Dev Service]
                       │  │   (resolved via 1.1.1.1 / 8.8.8.8)                    │  │    (Claude, ChatGPT,
                       │  │ • Unknown SNI                   -> 127.0.0.1:9 (drop) │  │     Gemini, JetBrains)
                       │  └───────────────────────────────────────────────────────┘  │
                       │                                                             │
   • HTTP TCP :80 ─────┼─►│ nginx http (:80)                                      │  │
                       │  │ • Host == pereval.portbuddy.tech -> ACME / 301 HTTPS  │  │
                       │  │ • Host in nginx-host-allow.map   -> Real Origin (:80) │──┼──► [Origin HTTP]
                       │  │   (strips X-Forwarded-For / X-Real-IP)                │  │
                       │  │ • Unknown Host                   -> HTTP 403          │  │
                       │  └───────────────────────────────────────────────────────┘  │
                       │                                                             │
  3. Telemetry:        │  ┌───────────────────────────────────────────────────────┐  │
   • GET /stats.html ──┼─►│ stats_collector.py (pereval-stats.service)            │  │
   • GET /stats.json   │  │ • Tails /var/log/nginx/sni.log & http-proxy.log       │  │
                       │  │ • Samples /proc/net/tcp & tcp6 (:443 & :80)           │  │
                       │  │ • Maps domains via service-map.json                   │  │
                       │  │ • Writes /var/www/geoblock/stats.json every 5s        │  │
                       │  └───────────────────────────────────────────────────────┘  │
                       └─────────────────────────────────────────────────────────────┘
```

### Key Architectural Details

1. **DNS Resolution & Record Filtering (`dnsmasq`):**
   - Configured via `/etc/dnsmasq.conf` (deployed from `dnsmasq-geoblock.conf`).
   - Uses `address=/<domain>/<server_ip>` directives, which automatically match `<domain>` and **all of its subdomains** (e.g., `address=/anthropic.com/153.80.200.170` matches `anthropic.com`, `api.anthropic.com`, `console.anthropic.com`).
   - **Critical DNS Options (`dnsmasq_options` in `services.yaml`):**
     - `filter-AAAA`: Strips IPv6 `AAAA` responses so dual-stack clients do not bypass the IPv4 proxy via direct IPv6 connections.
     - `filter-rr=HTTPS,SVCB`: Strips DNS `HTTPS` / `SVCB` (type 64/65) resource records! Modern browsers use `HTTPS` DNS records to discover ECH (Encrypted Client Hello), HTTP/3 QUIC hints, and embedded target IP hints—which would either bypass the proxy IP or hide the SNI inside ECH.
     - `no-resolv` and `no-hosts`: Ignores the server's `/etc/resolv.conf` and `/etc/hosts`, forwarding non-proxied queries explicitly to `1.1.1.1` and `8.8.8.8` (`cache-size=10000`, `min-cache-ttl=300`, `local-ttl=3600`).

2. **Avoiding DNS Loops on the Server:**
   - Because local `dnsmasq` resolves allowlisted domains to the server's own public IP (`153.80.200.170`), **`nginx` and the server OS must never use `127.0.0.1` as their upstream DNS resolver**.
   - Both `http` and `stream` blocks in `nginx.conf` explicitly set `resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;` so `nginx` resolves the genuine upstream IP addresses of proxied services.

3. **QUIC / HTTP/3 Fallback (`UDP/443`):**
   - `ngx_stream_ssl_preread_module` operates over TCP (`TCP/443`) and cannot inspect UDP QUIC handshakes.
   - Alongside `filter-rr=HTTPS,SVCB`, `UDP/443` should be blocked with `reject` in the server firewall so browsers immediately fall back to TCP/TLS (`HTTP/2` / `HTTP/1.1`) without waiting for a UDP connection timeout.

4. **Long-Lived LLM Streaming (`SSE`):**
   - In `nginx.conf`, `stream` sets `proxy_timeout 300s;` and `proxy_socket_keepalive on;` (and `http` sets `proxy_read_timeout 600s; proxy_buffering off;`) so long pauses between tokens during reasoning models' Server-Sent Events (SSE) streams (Claude, ChatGPT, Gemini, Cursor) are never prematurely disconnected.
   - During deployments (`deploy.sh`), `nginx` is always updated via `systemctl reload nginx` (graceful reload) rather than `restart` to avoid dropping active user streams.

---

## 3. Repository Structure & File Inventory

The repository follows a **Single Source of Truth + Zero-Dependency Generator** architecture. Source scripts live in `src/`, static icons in `assets/`, templates are organized into subdirectories under `templates/`, and generated artifacts are output to `build/`.

```text
.
├── services.yaml            # SINGLE SOURCE OF TRUTH: metadata, nodes cluster, dnsmasq options, categories, services, domains
├── deploy.sh                # Automated zero-downtime fleet deployment script with auto-bootstrapping, staging, backups & rollback
├── README.md                # Public user-facing documentation (in Russian)
├── AGENTS.md                # Technical documentation & contributor/agent guide (this file)
├── src/                     # Python build, daemon, and client scripts
│   ├── generate.py          # Build script: validates services.yaml and renders templates/ into build/
│   ├── doh_proxy.py         # Production daemon: async RFC 8484 DNS-over-HTTPS proxy (pereval-doh.service)
│   ├── stats_collector.py   # Production daemon: real-time usage telemetry collector (pereval-stats.service)
│   ├── healthcheck.py       # Production daemon: active worker health-check & DNS/nginx failover (pereval-healthcheck.service)
│   ├── leads_service.py     # Production daemon: FastAPI demand-validation leads & SMTP notification service (pereval-leads.service)
│   └── update_hosts.py      # Client utility: manages Pereval domains in local /etc/hosts (macOS / Linux)
├── assets/                  # Static web icon assets
│   ├── favicon.svg
│   ├── favicon.ico
│   └── apple-touch-icon.png
├── templates/               # Source templates rendered by src/generate.py using {{placeholder}} syntax
│   ├── dnsmasq/
│   │   └── dnsmasq.conf             # -> build/dnsmasq-geoblock.conf
│   ├── nginx/
│   │   ├── nginx.conf               # -> build/nginx.conf
│   │   ├── nginx-sni-allow.map      # -> build/nginx-sni-allow.map
│   │   ├── nginx-host-allow.map     # -> build/nginx-host-allow.map
│   │   ├── nginx-workers-stream.conf # -> build/nginx-workers-stream.conf
│   │   └── nginx-workers-http.conf  # -> build/nginx-workers-http.conf
│   ├── web/
│   │   ├── index.html               # -> build/index.html (landing page, OS setup guides, interactive domain search, FAQ)
│   │   ├── pro.html                 # -> build/pro.html (Pereval Pro high-performance cluster landing page & lead form)
│   │   ├── dedicated.html           # -> build/dedicated.html (Pereval Dedicated family/B2B server landing page & lead form)
│   │   ├── stats.html               # -> build/stats.html (real-time telemetry dashboard reading /stats.json)
│   │   ├── terms.html               # -> build/terms.html (Terms of Service)
│   │   ├── privacy.html             # -> build/privacy.html (Privacy Policy)
│   │   ├── dns.mobileconfig         # -> build/dns.mobileconfig (Apple iOS/iPadOS/macOS DoT configuration profile)
│   │   ├── robots.txt               # -> build/robots.txt
│   │   └── sitemap.xml              # -> build/sitemap.xml
│   └── assets/
│       ├── favicon.svg              # -> build/favicon.svg (+ rasterized to favicon.ico and apple-touch-icon.png)
│       └── og-image.svg             # -> build/og-image.svg (+ rasterized to og-image.png 1200x630)
├── logos/                   # Brand assets (SVG & PNG in dark/light themes across 8 aspect ratios)
│   └── README.md            # Documentation of logo formats and usage
└── build/                   # Output of `python3 src/generate.py services.yaml 153.80.200.170` (gitignored)
    ├── dnsmasq-geoblock.conf
    ├── nginx.conf
    ├── nginx-sni-allow.map
    ├── nginx-host-allow.map
    ├── nginx-workers-stream.conf
    ├── nginx-workers-http.conf
    ├── service-map.json     # Generated directly by src/generate.py (domain -> {service, category})
    ├── cluster-nodes.json   # Generated directly by src/generate.py (primary IP, domain, worker pool & SSH env refs)
    ├── index.html
    ├── pro.html
    ├── dedicated.html
    ├── stats.html
    ├── terms.html
    ├── privacy.html
    ├── dns.mobileconfig
    ├── favicon.svg
    ├── favicon.ico
    ├── apple-touch-icon.png
    ├── og-image.svg
    ├── og-image.png
    ├── robots.txt
    └── sitemap.xml
```

---

## 4. How the Project is Built (`services.yaml` & `generate.py`)

### 4.1. Data Model (`services.yaml`)
`services.yaml` defines all configuration data in five top-level sections:
1. `meta`:
   - `name`: Service display name (`Перевал`).
   - `origin`: Canonical public URL (`https://pereval.portbuddy.tech`). The hostname (`pereval.portbuddy.tech`) is automatically extracted as `{{domain}}` unless overridden by `meta.domain` or `--domain`.
   - `date` *(optional)*: ISO date `YYYY-MM-DD` (defaults to `date.today().isoformat()` at build time).
2. `dnsmasq_options`: List of raw `dnsmasq` configuration directives inserted at the top of `dnsmasq-geoblock.conf`.
3. `categories`: List of category objects (`name`, `services`), where each service has a `name` (e.g., `Anthropic / Claude`) and a list of base `domains` (e.g., `claude.ai`, `anthropic.com`).
   - **Subdomain rule:** Because both `dnsmasq` (`address=/domain/ip`) and `nginx` (`hostnames;` map with `.domain`) automatically cover all subdomains, child subdomains should **not** be listed if their parent domain is already in `categories`.
4. `disabled`: Groups of domains (`name`, `note`, `domains`) that are intentionally commented out (`#address=/.../`) in `dnsmasq-geoblock.conf` and displayed in the "Disabled / Not Included" section on `index.html` with an explanation (for example, shared Google/Firebase infrastructure like `clients6.google.com` that would break Android sync if proxied, or unconfirmed domain blocks).
5. `passthrough`: A group (`note`, `domains`) of Russian domestic domains (e.g., `gosuslugi.ru`, `ozon.ru`, `mos.ru`, `nalog.ru`, `rzd.ru`) that block foreign/Kazakhstan IPs and must **never** be added to `categories`.

### 4.2. Validation Logic in `generate.py`
Before writing any file, `generate.py` runs strict validation (`validate(doc)`):
- **Errors (abort build with exit code `1` or `2`):**
  - Invalid YAML syntax or wrong field types (`ParseError`, exit code `2`).
  - Unquoted numeric domains like `1.1.1.1` parsed as floats/non-strings by YAML.
  - Malformed domain names not matching `DOMAIN_RE` (`^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$`).
  - Duplicate domain entries across any active service in `categories`.
  - Any domain present in **both** `categories` and `passthrough`.
  - Any unknown or misspelled `{{placeholder}}` in a template (reports exact file and line number).
- **Warnings (printed to `stderr`, do not fail build):**
  - Domain looks like an IPv4 address (`IPISH_RE`).
  - Domain is active in `categories` and also listed in `disabled`.
  - Redundant subdomain: a domain (e.g., `api.example.com`) is listed when its parent (`example.com`) is already active.
  - Empty category, duplicate service name within a category, or service with no domains.

### 4.3. Template Rendering & Asset Generation Pipeline
`generate.py` contains **zero hardcoded HTML/CSS/JS**—all markup and config structure lives in `templates/`.
- **Double-Brace Syntax (`{{variable}}`):** Chosen specifically because it does not collide with `$variables` in `nginx.conf`, `@media` queries in CSS, or `{}` blocks in JavaScript/JSON.
- **Available Template Placeholders:**
  - Scalars: `{{name}}`, `{{ip}}`, `{{origin}}`, `{{domain}}`, `{{date}}`, `{{source}}`, `{{total}}`, `{{category_count}}`, `{{service_count}}`
  - iOS Profile deterministic UUIDv5 values (derived from `uuid.NAMESPACE_DNS` and `domain`): `{{profile_identifier}}` (e.g., `tech.portbuddy.pereval.dns`), `{{profile_uuid}}`, `{{dns_payload_uuid}}`
  - HTML fragments: `{{toc}}`, `{{cards}}`, `{{disabled}}` (in `.html`), `{{passthrough_note}}`, `{{passthrough_chips}}`, `{{faq_entities}}`
  - Config fragments: `{{options}}`, `{{body}}`, `{{disabled}}` (in non-`.html`), `{{passthrough}}`, `{{sni_entries}}`, `{{host_entries}}`
- **Automatic Schema.org `FAQPage` Generation (`faq_entities`):**
  - `src/generate.py` parses `<details class="faq"><summary>...</summary><p>...</p></details>` blocks directly from `templates/web/index.html`, substitutes any `{{...}}` placeholders inside them, strips HTML tags, and serializes the JSON-LD `mainEntity` array. FAQ text only needs to be edited once in `templates/web/index.html`.
- **Service Map Generation (`service-map.json`):**
  - Automatically writes `build/service-map.json` mapping every active base domain to `{"service": "...", "category": "..."}` for `src/stats_collector.py`.
- **Raster Image Generation (`favicon.ico`, `apple-touch-icon.png`, `og-image.png`):**
  - After rendering `favicon.svg` and `og-image.svg`, `src/generate.py` automatically rasterizes:
    - `favicon.ico`: Multi-resolution binary ICO container (`16×16`, `32×32`, `48×48` PNG frames packed via `struct.pack`).
    - `apple-touch-icon.png`: `180×180` full-bleed PNG (strips outer border stroke and sets `rx="0"` so iOS applies its own squircle mask cleanly).
    - `og-image.png`: `1200×630` Open Graph social preview card.
  - Supports multiple SVG rasterizer backends with automatic fallback: `rsvg-convert`, `resvg`, macOS `sips`, `inkscape`, ImageMagick (`magick` / `convert`), Python `cairosvg`, or `resvg_py`.

### 4.4. Build Commands
Requirement: Python 3 + `PyYAML` (`pip3 install pyyaml` or `apt install python3-yaml`).

```bash
# 1. Validate services.yaml and all templates without writing files
python3 src/generate.py services.yaml 153.80.200.170 --check

# 2. Full build: generate all configs, HTML pages, service-map.json, and PNG/ICO assets into build/
python3 src/generate.py services.yaml 153.80.200.170

# Optional flags:
#   -t / --templates <dir>   Custom templates directory (default: ./templates)
#   -o / --out-dir <dir>     Output directory (default: ./build)
#   -a / --assets-dir <dir>  Static assets directory (default: ./assets)
#   --name <str>             Override meta.name
#   --origin <url>           Override meta.origin
#   --domain <host>          Override DNS/DoT hostname
#   --date <YYYY-MM-DD>      Override meta.date
#   -q / --quiet             Suppress validation warnings
```

---

## 5. Runtime Daemons & Client Utilities

All Python runtime scripts (`doh_proxy.py`, `stats_collector.py`, `update_hosts.py`) use **only the Python 3 standard library** so they run out-of-the-box on any server or client without `pip` or virtualenvs.

### 5.1. `doh_proxy.py` (`pereval-doh.service`)
High-performance, zero-dependency asynchronous **RFC 8484 DNS-over-HTTPS (DoH)** daemon listening on `127.0.0.1:8053` behind `nginx` (`https://pereval.portbuddy.tech/dns-query`).
- **Why custom async implementation:** Browser clients send bursts of parallel DoH queries over persistent HTTP/2 connections terminated by `nginx` and forwarded over keep-alive HTTP/1.1 connections to `127.0.0.1:8053`.
- **Architecture:**
  - Multi-process worker pool (`os.fork()`, 2 to 8 workers based on CPU count) sharing the listening socket via `SO_REUSEPORT`, with automatic crash respawning in the master process.
  - `DohHttpServer`: Minimal async HTTP/1.1 server supporting keep-alive pipelines, `GET /dns-query?dns=<base64url>`, `POST /dns-query` (`application/dns-message`), `HEAD`, CORS `OPTIONS`, and `GET /healthz`.
  - `UdpDnsPool`: Each worker maintains a pool of 16 persistent connected non-blocking UDP sockets (`asyncio.DatagramProtocol`) to `127.0.0.1:53` (`dnsmasq`). Up to 65,536 concurrent in-flight queries are multiplexed per UDP socket by rewriting the 16-bit DNS Transaction ID (`txid`) and restoring the client's original ID upon response.
  - **Automatic TCP Fallback:** Inspects the DNS `TC` (Truncation, `0x02`) bit in UDP responses; if set, transparently retries the query over TCP (`127.0.0.1:53`).
  - **Smart `Cache-Control` Header:** Parses DNS answer/authority sections (`extract_min_ttl`) to compute `Cache-Control: max-age=<min_ttl>` (clamped between `1s` and `3600s`, or `10s` on non-zero `RCODE`).

### 5.2. `stats_collector.py` (`pereval-stats.service`)
Lightweight real-time usage telemetry daemon that powers `https://pereval.portbuddy.tech/stats.html`.
- **Data Sources:**
  1. `/var/log/nginx/sni.log` (`stream` TLS proxy sessions: client IP, timestamp, SNI hostname, upstream, status, bytes sent/received, duration).
  2. `/var/log/nginx/http-proxy.log` (`http` port 80 proxy requests: client IP, timestamp, request, `Host`, upstream, status, bytes sent).
  3. `/proc/net/tcp` and `/proc/net/tcp6`: Samples live `TCP_ESTABLISHED` (`01`) sockets on local ports `443` (`01BB`) and `80` (`0050`) every 5 seconds so long-running connections (e.g., idle keep-alive or active streaming sessions that haven't written a closing log line yet) are accurately counted in active connections and online users.
- **Privacy-Preserving User Counting:**
  - Client IP addresses are **never stored or written to disk**.
  - Each IP is hashed in memory into a 64-bit integer using `BLAKE2b(daily_salt + ":" + ip, digest_size=8)`. The 128-bit `daily_salt` is derived deterministically from the UTC day (`now // 86400`) and cluster seed (`domain` + `primary` IP from `cluster-nodes.json`), so every node in the cluster computes the exact same hash for a client IP on the same UTC day while rotating automatically every 24 hours.
- **Log Rotation & Crash Recovery:**
  - `LogTailer` tracks file inode (`st_ino`) and byte offset, seamlessly draining rotated logs (`.1`) before switching to newly created log files.
  - On startup, `bootstrap_logs` restores state and file cursors from `/var/lib/pereval-stats/state.json` (if `< 24h` old) or backfills the last 24 hours from `/var/log/nginx/sni.log.1` and `/var/log/nginx/sni.log` without double-counting.
- **Cluster-Wide Aggregation, Deduplication & Output:**
  - Maintains a rolling 60-minute window (`minute_buckets`) and 24-hour window (`hour_buckets`), plus a 5-minute active user map (`recent_5m_users`).
  - Filters out internal/self traffic (`127.0.0.1`, `::1`, `pereval.portbuddy.tech`, rejected `127.0.0.1:9` / `403` probes) as well as all cluster node IPs (`primary` and `workers` from `cluster-nodes.json`), preventing `healthcheck.py` SNI probes and Primary-to-Worker L4/L7 fallback connections from being double-counted on Workers.
  - Every node atomically writes its local bucket snapshot to `/var/www/geoblock/node-stats.json` (served by `nginx` on port `80` with `access_log off`).
  - On the Primary node, `stats_collector.py` polls `http://<worker_ip>/node-stats.json` from all workers in parallel every 5 seconds (with a 60-second stale-snapshot grace cache for historical buckets), merges buckets via set-union of user hashes and summation of requests/bytes/connections, and atomically writes `/var/www/geoblock/stats.json` every 5 seconds.

### 5.3. `healthcheck.py` (`pereval-healthcheck.service`)
Active worker health-check and automatic failover daemon running on the Primary node (`153.80.200.170`).
- **Hybrid Direct + L4 Fallback Scaling:**
  - When `nodes.workers` in `services.yaml` lists Worker VPS instances, `dnsmasq` returns the healthy Worker IPs (`local-ttl=60`) so clients open `:443` / `:80` connections directly to Workers.
  - Traffic that still hits the Primary node (`153.80.200.170:443` or `:80`, such as `update_hosts.py` users or cached DNS records) is load-balanced by Primary's `nginx` (`least_conn` in `nginx-workers-stream.conf` and `nginx-workers-http.conf`) across the healthy Worker pool.
- **Health Probes & Hysteresis:**
  - Probes each Worker every `5s` on TCP `:443` (sends a TLS `ClientHello` with SNI and verifies a `0x16 0x03` `ServerHello` response) and TCP `:80` (`GET /healthz` expecting `HTTP 200`).
  - Uses hysteresis (`--fail-threshold 2`, `--rise-threshold 2`) and only rewrites `/etc/dnsmasq.conf` + `/etc/nginx/geoblock/nginx-workers-*.conf` and reloads `dnsmasq` / `nginx` when a worker actually transitions between `UP` and `DOWN`.
- **Fail-Open to Primary:**
  - If all workers become unreachable, `healthcheck.py` automatically falls back to `153.80.200.170` in `/etc/dnsmasq.conf` and switches Primary `nginx` to direct origin resolution so traffic continues uninterrupted.
  - Writes `/var/www/geoblock/cluster-health.json` on each cycle (`https://pereval.portbuddy.tech/cluster-health.json`).

### 5.4. `update_hosts.py` (Client-Side `/etc/hosts` Manager)
Standalone CLI tool for macOS and Linux users who cannot change their system DNS (e.g., when running a corporate VPN like Cloudflare WARP, Cisco AnyConnect, or GlobalProtect that locks DNS settings, or when using Tailscale MagicDNS / local dnsmasq).
- Reads active domains from `services.yaml` using `PyYAML` if installed, or falls back to parsing `dnsmasq-geoblock.conf` or a built-in zero-dependency YAML parser (crucial when run under `sudo python3` where user site-packages aren't loaded).
- Since `/etc/hosts` does not support wildcards, it automatically expands second-level apex domains (`d.count(".") == 1`, e.g., `claude.ai`) with 11 common subdomains (`www`, `api`, `auth`, `cdn`, `platform`, `chat`, `ab`, `accounts`, `app`, `static`, `assets`).
- Packs up to 9 hostnames per line between `# >>> PEREVAL START` and `# <<< PEREVAL END` markers without touching user entries, and flushes the macOS DNS cache (`dscacheutil -flushcache` and `killall -HUP mDNSResponder`).

### 5.5. `leads_service.py` (`pereval-leads.service`)
Demand-validation lead capture and SMTP notification microservice listening on `127.0.0.1:8054` behind `nginx` (`POST /api/leads`) on the Primary node.
- **Stack:** Built with **FastAPI + Pydantic + Uvicorn** running inside an isolated virtual environment `/opt/pereval-leads/venv` provisioned automatically by `deploy.sh`.
- **Storage:** Synchronously appends validated lead submissions (`email`, `plan`, `scenario`, `desired_services`, `contact`, `page`, `ip_hash`, `user_agent`) as UTF-8 JSON Lines to `/var/lib/pereval-leads/leads.jsonl` (`0600`).
- **SMTP Notifications (`BackgroundTasks`):** Asynchronously sends a confirmation email to the user from `${MAIL_FROM_NAME:Port Buddy} <${MAIL_FROM:no-reply@portbuddy.dev}>` and an alert email to `${ADMIN_EMAIL:admin@portbuddy.dev}` (`Reply-To` set to the user's email) via `${SMTP_HOST:smtp-pulse.com}:${SMTP_PORT:2525}` using credentials from `/etc/pereval/leads.env` (`0600`).

---

## 6. Deployment Pipeline (`deploy.sh`)

`deploy.sh` automates deploying generated configurations, web assets, and systemd daemons to a single server or across the entire Worker + Primary cluster over SSH:

```bash
./deploy.sh <server-ip> <path-to-ssh-key> [ssh-user] [--port PORT] [--role auto|primary|worker] [--all] [--primary-only] [--dry-run] [--force]
# Example (rolls out to all workers in cluster-nodes.json first, then Primary):
./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 root
```

### Step-by-Step Execution Flow
1. **Local Pre-Flight Verification:**
   - Verifies all 23 required local files exist.
   - Verifies `dnsmasq-geoblock.conf` and `cluster-nodes.json` match the target `<server-ip>`.
   - Scans text files to ensure no unrendered `{{...}}` placeholders remain.
   - Verifies the exact number of unique domains in `dnsmasq-geoblock.conf` matches both `nginx-sni-allow.map` and `nginx-host-allow.map`.
   - Checks that `services.yaml` is not newer than any generated file (unless `--force` is passed).
2. **Fleet Orchestration & Per-Worker SSH Credential Inheritance:**
   - When `nodes.workers` in `services.yaml` (`cluster-nodes.json`) contains worker nodes, `./deploy.sh` updates and validates every Worker node (`--role worker`) **before** updating the Primary node (`--role primary`).
   - By default, Worker nodes inherit the Primary node's `<path-to-ssh-key>`, `[ssh-user]`, and `--port`.
   - Optional per-worker overrides in `services.yaml` (`ssh_user_env`, `ssh_key_env`, `ssh_user`, `ssh_key`, `ssh_port`) allow pointing each worker to GitHub Actions secrets via environment variables. Inline private keys from environment variables are automatically written to temporary `0600` files and cleaned up on exit.
3. **Zero-Touch Package Bootstrapping & SSH Multiplexing:**
   - Opens a `ControlMaster` socket per node so all SSH commands reuse one TCP connection.
   - Automatically detects and installs any missing packages on fresh Debian/Ubuntu servers (`tar`, `nginx`, `libnginx-mod-stream`, `dnsmasq`, `python3`, `openssl`, `dnsutils`, `iproute2`, `ca-certificates`) and frees port `53` from `systemd-resolved` stub listener (`DNSStubListener=no`) if active.
   - Streams all 23 files + generated `apply.sh` to `/tmp/geoblock-<timestamp>` using `COPYFILE_DISABLE=1 tar -cf - ... | ssh ... tar -xf -`.
3. **Remote Validation, Backup & Atomic Rollback (`apply.sh`):**
   - Tests `dnsmasq --test -C "$STAGE/dnsmasq-geoblock.conf"` **before** touching any live file.
   - Backs up all existing configs, units, scripts, and web files to `/var/backups/geoblock/<timestamp>/` (retaining the 10 most recent backups).
   - Defines an automatic `restore()` function that rolls back all files and restarts/reloads services if any subsequent step fails.
4. **System & Network Provisioning:**
   - Installs `/etc/sysctl.d/99-geoblock-highload.conf` (enables TCP BBR, `fq` qdisc, `somaxconn=16384`, `nf_conntrack_max=262144`, shortened FIN/TIME_WAIT timeouts, and TCP keepalives) and applies via `sysctl`.
   - Opens `853/tcp` (DNS-over-TLS) in `ufw` if `ufw` is active.
   - Links Let's Encrypt certificates from `/etc/letsencrypt/live/$DOMAIN/` into `/etc/nginx/geoblock/ssl/`, or generates a temporary 10-year self-signed certificate on first bootstrap so `nginx` can start before `certbot` runs.
5. **Service Installation & Reload:**
   - Installs static files to `/var/www/geoblock/`, nginx maps and `service-map.json` to `/etc/nginx/geoblock/`, and `/etc/nginx/nginx.conf`.
   - Installs `/usr/local/bin/pereval-doh-proxy.py` (`pereval-doh.service`) and `/usr/local/bin/pereval-stats-collector.py` (`pereval-stats.service`).
   - Runs `pereval-stats-collector.py --once` to ensure `/var/www/geoblock/stats.json` exists immediately.
   - Runs `nginx -t` (rolls back immediately if invalid).
   - Installs `/etc/dnsmasq.conf` (and removes legacy `/etc/dnsmasq.d/dnsmasq-geoblock.conf` if present).
   - Executes `systemctl restart dnsmasq` (required because `dnsmasq` does not reload `address=` rules on `SIGHUP`) and `systemctl reload nginx` (graceful reload to preserve active SSE connections), then restarts `pereval-doh.service` and `pereval-stats.service`.
6. **Let's Encrypt Automation & Post-Deploy Health Checks:**
   - Installs `certbot` if missing, configures `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`, enables `certbot.timer`, and obtains/renews the certificate for `$DOMAIN` via `--webroot -w /var/www/geoblock`.
   - Verifies all 4 systemd units (`dnsmasq`, `nginx`, `pereval-doh`, `pereval-stats`) are `active`.
   - Runs a live DNS resolution test (`dig @127.0.0.1 claude.ai`) confirming it resolves to `$SERVER_IP`.
   - Verifies TCP ports `80`, `443`, `853`, and `8053` are listening via `ss -tlnH`.

---

## 7. Guidelines for Agents & Contributors

When modifying this repository, always follow these rules:

### Rule 1: Never Edit Generated Build Files Directly
The following files in `build/` are **build outputs** of `src/generate.py` and will be overwritten on the next run:
- `build/dnsmasq-geoblock.conf`
- `build/nginx.conf`
- `build/nginx-sni-allow.map`
- `build/nginx-host-allow.map`
- `build/nginx-workers-stream.conf`, `build/nginx-workers-http.conf`
- `build/service-map.json`, `build/cluster-nodes.json`
- `build/index.html`, `build/pro.html`, `build/dedicated.html`, `build/stats.html`, `build/terms.html`, `build/privacy.html`
- `build/dns.mobileconfig`
- `build/favicon.svg`, `build/favicon.ico`, `build/apple-touch-icon.png`, `build/og-image.svg`, `build/og-image.png`
- `build/robots.txt`, `build/sitemap.xml`

**Always edit the corresponding source in `services.yaml` or `templates/<subdir>/<filename>`, then run:**
```bash
python3 src/generate.py services.yaml 153.80.200.170 --check
python3 src/generate.py services.yaml 153.80.200.170
```

### Rule 2: Adding or Updating Domains in `services.yaml`
1. **Check parent coverage first:** Before adding `sub.example.com`, check if `example.com` is already in `services.yaml`. If `example.com` is present, all its subdomains are already proxied by `dnsmasq` and `nginx`. Only add specific subdomains when proxying the entire parent domain would break unrelated services (e.g., specific `*.clients6.google.com` or `*.googleapis.com` hosts for Google Gemini/AI Studio while `clients6.google.com` itself stays in `disabled`).
2. **Never proxy shared CDN or consumer root domains carelessly:** Avoid adding broad shared domains like `google.com`, `gstatic.com`, `googleapis.com`, or `cloudflare.com` as apex entries.
3. **Quote numeric or special domains:** In YAML, any domain resembling numbers must be quoted as a string.
4. **Always run `--check` and regenerate:** Run `python3 src/generate.py services.yaml 153.80.200.170` so all config files, domain counts on the landing page, `service-map.json`, and SEO metadata stay synchronized.

### Rule 3: Editing Templates (`templates/**/*`)
- Use `{{placeholder_name}}` for substitutions. If you introduce a new placeholder in `templates/`, add its builder logic to `build_values()` in `src/generate.py`.
- In `templates/web/index.html`, FAQ items must keep the `<details class="faq"><summary>...</summary><p>...</p></details>` structure so `faq_entities()` can extract them into the Schema.org `FAQPage` JSON-LD block.
- Keep `templates/` self-contained (inline CSS and vanilla JS without external bundler steps).

### Rule 4: Modifying Runtime Scripts (`src/doh_proxy.py`, `src/stats_collector.py`, `src/update_hosts.py`)
- **Zero third-party dependencies:** Server daemons (`src/doh_proxy.py`, `src/stats_collector.py`, `src/healthcheck.py`) and `src/update_hosts.py` (when invoked via `sudo`) must rely strictly on the Python 3 standard library.
- **Log format compatibility:** `SNI_LOG_RE` and `HTTP_LOG_RE` in `src/stats_collector.py` are tightly coupled to `log_format sni` and `log_format hostproxy` in `templates/nginx/nginx.conf`. If you change either log format in `templates/nginx/nginx.conf`, update the corresponding regex in `src/stats_collector.py`.
- **Atomic file writes:** Any file read directly by `nginx` (such as `/var/www/geoblock/stats.json`) must be written to a temporary file in the same directory and atomically renamed (`Path.replace()`).
