#!/bin/sh
# Выполняется образом nginx перед стартом (и вручную: `sh …/40-pereval-certs.sh publish`).
#  * нет сертификата — создаём временный самоподписанный, чтобы nginx поднялся;
#  * публикуем копию боевого сертификата в $PUBLISH_DIR с правами для контейнера app
#    (root:10001, ключ 0640) — её раздаёт нодам /api/internal/v1/node/cert;
#  * фоном раз в 5 минут: если certbot выпустил новый — публикуем и перечитываем nginx.
DOMAIN="${SITE_DOMAIN:-pereval.top}"
LIVE="/etc/letsencrypt/live/$DOMAIN"
PUBLISH_DIR="${CERT_PUBLISH_DIR:-/etc/letsencrypt/pereval}"
APP_GID="${CERT_APP_GID:-10001}"

ensure_cert() {
  if [ ! -f "$LIVE/fullchain.pem" ] || [ ! -f "$LIVE/privkey.pem" ]; then
    echo "[pereval] сертификата для $DOMAIN нет — создаю временный самоподписанный"
    mkdir -p "$LIVE"
    command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null 2>&1 || true
    openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN" \
      -keyout "$LIVE/privkey.pem" -out "$LIVE/fullchain.pem" >/dev/null 2>&1
    touch "$LIVE/.selfsigned"
  fi
}

same() { cmp -s "$1" "$2" 2>/dev/null; }

# 0 — опубликован новый сертификат (нужен reload), 1 — без изменений
publish() {
  [ -f "$LIVE/fullchain.pem" ] && [ -f "$LIVE/privkey.pem" ] || return 1
  [ -f "$LIVE/.selfsigned" ] && return 1   # временный нодам не раздаём
  if same "$LIVE/fullchain.pem" "$PUBLISH_DIR/fullchain.pem" && same "$LIVE/privkey.pem" "$PUBLISH_DIR/privkey.pem"; then
    return 1
  fi
  mkdir -p "$PUBLISH_DIR"
  cp -L "$LIVE/privkey.pem" "$PUBLISH_DIR/.privkey.tmp" && cp -L "$LIVE/fullchain.pem" "$PUBLISH_DIR/.fullchain.tmp" || return 1
  chown "0:$APP_GID" "$PUBLISH_DIR/.privkey.tmp" "$PUBLISH_DIR/.fullchain.tmp"
  chmod 0640 "$PUBLISH_DIR/.privkey.tmp"; chmod 0644 "$PUBLISH_DIR/.fullchain.tmp"
  mv -f "$PUBLISH_DIR/.privkey.tmp" "$PUBLISH_DIR/privkey.pem"
  mv -f "$PUBLISH_DIR/.fullchain.tmp" "$PUBLISH_DIR/fullchain.pem"
  echo "[pereval] опубликована копия сертификата $DOMAIN в $PUBLISH_DIR ($(openssl x509 -in "$PUBLISH_DIR/fullchain.pem" -noout -enddate 2>/dev/null))"
  return 0
}

case "${1:-}" in
  publish)
    ensure_cert
    if publish; then nginx -s reload 2>/dev/null || true; echo "[pereval] nginx перечитал конфиг"; else echo "[pereval] изменений нет"; fi
    exit 0
    ;;
esac

ensure_cert
publish || true
(
  while :; do
    sleep 300
    ensure_cert
    if publish; then nginx -s reload 2>/dev/null || true; fi
  done
) &
