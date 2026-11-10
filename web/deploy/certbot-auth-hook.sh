#!/bin/sh
# manual-auth-hook для certbot (DNS-01). Вызывается по одному разу на имя:
#  * дописывает «_acme-challenge.<имя>  <значение>» в /dns01/records.txt;
#  * на последнем имени (CERTBOT_REMAINING_CHALLENGES=0) ждёт, пока ВСЕ записи появятся
#    в публичном DNS (DoH Cloudflare/Google), и только тогда возвращает управление —
#    certbot идёт на валидацию. Так issue-cert.sh работает без TTY: админ добавляет
#    TXT-записи из records.txt в любое время в течение DNS01_WAIT_SECONDS (по умолчанию 48 ч).
STATE="${DNS01_STATE:-/dns01/records.txt}"
TIMEOUT="${DNS01_WAIT_SECONDS:-172800}"
mkdir -p "$(dirname "$STATE")"
printf '%s %s\n' "_acme-challenge.$CERTBOT_DOMAIN" "$CERTBOT_VALIDATION" >>"$STATE"
echo "[dns01] TXT _acme-challenge.$CERTBOT_DOMAIN = $CERTBOT_VALIDATION (осталось имён: ${CERTBOT_REMAINING_CHALLENGES:-?})"
[ "${CERTBOT_REMAINING_CHALLENGES:-0}" = "0" ] || exit 0

python3 - "$STATE" "$TIMEOUT" <<'PY'
import json, sys, time, urllib.request, urllib.parse
state, timeout = sys.argv[1], int(sys.argv[2])
want = {}
for line in open(state, encoding="utf-8"):
    parts = line.split()
    if len(parts) == 2:
        want.setdefault(parts[0].rstrip("."), set()).add(parts[1])
import socket, struct, random
RESOLVERS = [
    ("https://cloudflare-dns.com/dns-query?name={n}&type={t}", {"Accept": "application/dns-json"}),
    ("https://dns.google/resolve?name={n}&type={t}", {}),
]
def doh(name, rtype):
    """Ответы публичных DoH-резолверов (данные записей типа rtype)."""
    out = set()
    for url, hdr in RESOLVERS:
        req = urllib.request.Request(url.format(n=urllib.parse.quote(name), t=rtype), headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                for a in json.loads(r.read().decode()).get("Answer") or []:
                    if a.get("type") == {"TXT": 16, "NS": 2, "A": 1}[rtype]:
                        out.add(str(a.get("data", "")).strip().rstrip("."))
        except Exception:
            pass
    return out
def authoritative_ips(name):
    """IP авторитетных NS зоны: поднимаемся по меткам, пока DoH не отдаст NS."""
    labels = name.strip(".").split(".")
    for i in range(1, len(labels) - 1):
        zone = ".".join(labels[i:])
        ns = doh(zone, "NS")
        if ns:
            ips = set()
            for h in ns:
                ips |= doh(h, "A")
            if ips:
                return ips
    return set()
def udp_txt(name, server):
    """Прямой UDP-запрос TXT к авторитетному серверу (без кеша резолверов)."""
    qid = random.randint(0, 65535)
    q = struct.pack(">HHHHHH", qid, 0x0000, 1, 0, 0, 0)
    for lab in name.strip(".").split("."):
        q += bytes([len(lab)]) + lab.encode()
    q += b"\x00" + struct.pack(">HH", 16, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5)
    try:
        s.sendto(q, (server, 53)); data, _ = s.recvfrom(4096)
    except Exception:
        return set()
    finally:
        s.close()
    if len(data) < 12 or struct.unpack(">H", data[:2])[0] != qid:
        return set()
    qd, an = struct.unpack(">HH", data[4:8])
    def skip_name(off):
        while True:
            l = data[off]
            if l == 0: return off + 1
            if l & 0xC0: return off + 2
            off += l + 1
    off = 12
    for _ in range(qd):
        off = skip_name(off) + 4
    vals = set()
    for _ in range(an):
        off = skip_name(off)
        rtype, _cls, _ttl, rdlen = struct.unpack(">HHIH", data[off:off + 10]); off += 10
        if rtype == 16:
            rd = data[off:off + rdlen]; i = 0; txt = b""
            while i < len(rd):
                ln = rd[i]; txt += rd[i + 1:i + 1 + ln]; i += 1 + ln
            vals.add(txt.decode("utf-8", "replace"))
        off += rdlen
    return vals
def txt_values(name):
    """Сначала авторитетные NS (так делает и Let's Encrypt — публичные резолверы могут
    держать отрицательный кеш часами), затем DoH как запасной вариант."""
    vals = set()
    for ip in authoritative_ips(name):
        vals |= udp_txt(name, ip)
    if not vals:
        vals = {v.strip().strip('"').replace('" "', "") for v in doh(name, "TXT")}
    return vals
print("[dns01] жду TXT-записи в публичном DNS:")
for n, vs in want.items():
    for v in sorted(vs):
        print("  %s  TXT  %s" % (n, v))
sys.stdout.flush()
start = time.time(); last = 0
while True:
    missing = {n: vs - txt_values(n) for n, vs in want.items()}
    missing = {n: vs for n, vs in missing.items() if vs}
    if not missing:
        print("[dns01] все записи видны, через 20 с запускаю валидацию"); time.sleep(20); sys.exit(0)
    if time.time() - start > timeout:
        print("[dns01] не дождался записей: %s" % missing); sys.exit(1)
    if time.time() - last > 300:
        last = time.time()
        print("[dns01] ещё нет: " + "; ".join("%s (%d)" % (n, len(vs)) for n, vs in missing.items())); sys.stdout.flush()
    time.sleep(30)
PY
