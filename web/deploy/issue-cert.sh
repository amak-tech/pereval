#!/usr/bin/env bash
# Выпуск / продление ЕДИНОГО wildcard-сертификата Перевала на control plane (DNS-01).
#
#   cd /opt/pereval && ./deploy/issue-cert.sh            # продлить, если осталось < 30 дней
#   FORCE=1 ./deploy/issue-cert.sh                        # перевыпустить принудительно
#   nohup ./deploy/issue-cert.sh >dns01/issue.log 2>&1 &  # в фоне: TXT-записи появятся в dns01/records.txt,
#                                                         # certbot сам дождётся их в DNS (до 48 ч) и выпустит сертификат
#
# Имена: SITE_DOMAIN, *.SITE_DOMAIN, *.PRO_DOMAIN и CERT_EXTRA_DOMAINS из .env (устаревшие
# Free-имена вне зоны сайта, например pereval.portbuddy.tech). Если контейнер app запущен,
# список берётся из каталога приложения (services.yaml → cert_domains).
#
# TXT-записи: _acme-challenge.<имя> (для apex и *.apex — две записи с одним именем). Значения
# пишет deploy/certbot-auth-hook.sh в dns01/records.txt. После выпуска nginx публикует копию
# для нод и перечитывает конфиг; ноды забирают сертификат по таймеру в течение часа
# (быстрее: systemctl start pereval-cert-sync на ноде).
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

mkdir -p dns01
rm -f dns01/records.txt

# старые версии клали временный самоподписанный в каталог certbot — он мешает выпуску
"${COMPOSE[@]}" run --rm -T --entrypoint sh certbot -c \
	"if [ -f /etc/letsencrypt/live/$SITE_DOMAIN/.selfsigned ]; then rm -rf /etc/letsencrypt/live/$SITE_DOMAIN; echo 'устаревший временный сертификат из live/ удалён'; fi"

echo
echo "TXT-записи появятся в $(pwd)/dns01/records.txt — добавьте их у регистратора; certbot дождётся их в DNS сам."
echo
if "${COMPOSE[@]}" run --rm -T certbot certonly --manual --preferred-challenges dns \
	--manual-auth-hook /hooks/auth.sh --non-interactive \
	--cert-name "$SITE_DOMAIN" "${args[@]}" --agree-tos "${email_args[@]}" \
	--keep-until-expiring --expand "${force_args[@]}"; then
	echo
	"${COMPOSE[@]}" exec -T nginx sh /docker-entrypoint.d/40-pereval-certs.sh publish
	echo "Готово. Ноды подхватят сертификат по таймеру pereval-cert-sync (до 1 ч)."
else
	rc=$?
	echo "certbot завершился с ошибкой ($rc), см. dns01/issue.log и /var/log/letsencrypt в volume letsencrypt." >&2
	exit "$rc"
fi
