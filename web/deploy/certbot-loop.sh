#!/bin/sh
# certbot: первый выпуск (если сертификата нет или он самоподписанный) и продление каждые 12 ч.
DOMAIN="${SITE_DOMAIN:-pereval.top}"
LIVE="/etc/letsencrypt/live/$DOMAIN"
EMAIL_ARG="--register-unsafely-without-email"
[ -n "${CERTBOT_EMAIL:-}" ] && EMAIL_ARG="--email $CERTBOT_EMAIL"

trap 'exit 0' TERM INT

issue() {
  certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos $EMAIL_ARG --keep-until-expiring --expand
}

# ждём, пока nginx начнёт отвечать на 80
i=0
while [ $i -lt 30 ]; do
  if wget -qO- "http://nginx/healthz" >/dev/null 2>&1; then break; fi
  i=$((i+1)); sleep 2
done

if [ -f "$LIVE/.selfsigned" ] || [ ! -f "$LIVE/fullchain.pem" ]; then
  echo "[certbot] выпускаю сертификат для $DOMAIN"
  # временный самоподписанный мешает certbot — убираем его каталог
  rm -rf "$LIVE" "/etc/letsencrypt/archive/$DOMAIN" "/etc/letsencrypt/renewal/$DOMAIN.conf"
  if issue; then
    echo "[certbot] сертификат выпущен; nginx перечитает конфиг в ближайшие 6 ч (или: docker compose exec nginx nginx -s reload)"
  else
    echo "[certbot] выпуск не удался — проверьте DNS A-записи $DOMAIN и www.$DOMAIN"
  fi
fi

while :; do
  certbot renew --webroot -w /var/www/certbot --quiet || true
  sleep 43200 & wait $!
done
