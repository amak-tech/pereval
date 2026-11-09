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
RESOLVERS = [
    ("https://cloudflare-dns.com/dns-query?name={n}&type=TXT", {"Accept": "application/dns-json"}),
    ("https://dns.google/resolve?name={n}&type=TXT", {}),
]
def txt_values(name):
    vals = set()
    for url, hdr in RESOLVERS:
        req = urllib.request.Request(url.format(n=urllib.parse.quote(name)), headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                for a in json.loads(r.read().decode()).get("Answer") or []:
                    if a.get("type") == 16:
                        vals.add(str(a.get("data", "")).strip().strip('"').replace('" "', ""))
        except Exception:
            pass
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
