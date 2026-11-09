#!/usr/bin/env bash
# Выпуск / продление ЕДИНОГО wildcard-сертификата Перевала на control plane (DNS-01 вручную).
#
#   cd /opt/pereval && ./deploy/issue-cert.sh          # продлить, если осталось < 30 дней
#   FORCE=1 ./deploy/issue-cert.sh                      # перевыпустить принудительно
#
# Имена: SITE_DOMAIN, *.SITE_DOMAIN, *.PRO_DOMAIN и CERT_EXTRA_DOMAINS из .env (устаревшие
# Free-имена вне зоны сайта, например pereval.portbuddy.tech). Если контейнер app запущен,
# список берётся из каталога приложения (services.yaml → cert_domains).
#
# certbot попросит TXT-записи _acme-challenge.<имя> (для apex и *.apex — две записи на одно имя).
# После выпуска nginx публикует копию для нод и перечитывает конфиг; ноды забирают
# сертификат по таймеру в течение часа (быстрее: systemctl start pereval-cert-sync на ноде).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then set -a; . ./.env; set +a; fi
SITE_DOMAIN="${SITE_DOMAIN:-pereval.top}"
PRO_DOMAIN="${PRO_DOMAIN:-pro.$SITE_DOMAIN}"
COMPOSE=(docker compose)
[[ -f .image.env ]] && COMPOSE+=(--env-file .env --env-file .image.env)

names=()
if from_app=$("${COMPOSE[@]}" exec -T app ./docker-entrypoint.sh admin cert names 2>/dev/null) && [[ -n $from_app ]]; then
	read -r -a names <<<"$from_app"
	echo "имена сертификата (из каталога приложения): ${names[*]}"
else
	names=("$SITE_DOMAIN" "*.$SITE_DOMAIN" "*.$PRO_DOMAIN")
	for d in ${CERT_EXTRA_DOMAINS:-}; do names+=("$d"); done
	echo "имена сертификата (из .env): ${names[*]}"
fi

args=()
for n in "${names[@]}"; do args+=(-d "$n"); done
email_args=(--register-unsafely-without-email)
[[ -n ${CERTBOT_EMAIL:-} ]] && email_args=(--email "$CERTBOT_EMAIL" --no-eff-email)
force_args=()
[[ ${FORCE:-0} == 1 ]] && force_args=(--force-renewal)

# временный самоподписанный каталог мешает certbot (он создал бы lineage <domain>-0001)
"${COMPOSE[@]}" run --rm --entrypoint sh certbot -c \
	"if [ -f /etc/letsencrypt/live/$SITE_DOMAIN/.selfsigned ]; then rm -rf /etc/letsencrypt/live/$SITE_DOMAIN; echo 'временный самоподписанный удалён'; fi"

echo
echo "Добавьте TXT-записи, которые попросит certbot, дождитесь их появления (dig TXT _acme-challenge.<имя> @1.1.1.1) и только затем нажимайте Enter."
echo
if "${COMPOSE[@]}" run --rm certbot certonly --manual --preferred-challenges dns \
	--cert-name "$SITE_DOMAIN" "${args[@]}" --agree-tos "${email_args[@]}" \
	--keep-until-expiring --expand "${force_args[@]}"; then
	echo
	"${COMPOSE[@]}" exec nginx sh /docker-entrypoint.d/40-pereval-certs.sh publish
	echo "Готово. Ноды подхватят сертификат по таймеру pereval-cert-sync (до 1 ч)."
else
	rc=$?
	echo "certbot завершился с ошибкой ($rc). Восстанавливаю временный сертификат, если боевого нет." >&2
	"${COMPOSE[@]}" exec nginx sh /docker-entrypoint.d/40-pereval-certs.sh publish || true
	exit "$rc"
fi
