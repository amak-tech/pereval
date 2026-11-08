#!/bin/sh
# Выполняется образом nginx перед стартом: если сертификата Let's Encrypt ещё нет,
# создаём временный самоподписанный, чтобы nginx поднялся и certbot смог пройти HTTP-01.
# Также фоново перечитываем конфиг каждые 6 часов — подхватывать продлённые сертификаты.
set -e
DOMAIN="${SITE_DOMAIN:-pereval.top}"
LIVE="/etc/letsencrypt/live/$DOMAIN"
if [ ! -f "$LIVE/fullchain.pem" ] || [ ! -f "$LIVE/privkey.pem" ]; then
  echo "[pereval] сертификата для $DOMAIN нет — создаю временный самоподписанный"
  mkdir -p "$LIVE"
  apk add --no-cache openssl >/dev/null 2>&1 || true
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=$DOMAIN" \
    -keyout "$LIVE/privkey.pem" -out "$LIVE/fullchain.pem" >/dev/null 2>&1
  touch "$LIVE/.selfsigned"
fi
(
  while :; do
    sleep 21600
    nginx -s reload 2>/dev/null || true
  done
) &
