#!/usr/bin/env bash
#
# Раскладывает сгенерированные конфиги на сервер (или весь кластер воркеров + основной узел),
# автоматически доустанавливает недостающие пакеты и перезапускает сервисы.
#
#   ./deploy.sh <ip-сервера> <путь-к-ssh-ключу> [пользователь] [опции]
#
# Что делает:
#   1. проверяет, что локальные файлы существуют, свежие и без незакрытых {{...}}
#   2. определяет список целевых узлов (воркеры из cluster-nodes.json -> основной узел)
#      и разрешает SSH-реквизиты каждого воркера (по умолчанию наследует от основного узла,
#      либо берёт из ssh_user_env / ssh_key_env / ssh_user / ssh_key / ssh_port)
#   3. автоматически устанавливает недостающие пакеты (tar, nginx, libnginx-mod-stream,
#      dnsmasq, python3, openssl, dnsutils, iproute2, ca-certificates) и освобождает
#      порт 53 от systemd-resolved stub listener при необходимости
#   4. заливает файлы в staging-каталог на сервере, проверяет синтаксис ДО замены
#   5. делает резервные копии, устанавливает, перезапускает сервисы, при ошибке откатывает
#
# dnsmasq именно перезапускается: по SIGHUP он перечитывает /etc/hosts и чистит
# кэш, но не конфиг, так что reload не подхватил бы новые address=.
# nginx наоборот перезагружается через reload — restart рвёт все текущие
# соединения, включая длинные SSE-потоки Claude и ChatGPT.

set -euo pipefail

DNSMASQ_CONF="dnsmasq-geoblock.conf"
NGINX_CONF="nginx.conf"
NGINX_MAPS=("nginx-sni-allow.map" "nginx-host-allow.map")
NGINX_WORKER_CONFS=("nginx-workers-stream.conf" "nginx-workers-http.conf")
SERVICE_MAP="service-map.json"
CLUSTER_NODES="cluster-nodes.json"
STATS_COLLECTOR="stats_collector.py"
DOH_PROXY="doh_proxy.py"
HEALTHCHECK="healthcheck.py"
WEB_FILES=("index.html" "stats.html" "terms.html" "privacy.html" "dns.mobileconfig" "favicon.svg" "favicon.ico" "apple-touch-icon.png" "og-image.svg" "og-image.png" "robots.txt" "sitemap.xml")
SOURCE_YAML="services.yaml"

SSH_PORT=22
DRY_RUN=0
FORCE=0
ROLE="auto"          # auto | primary | worker
DEPLOY_ALL=0         # 1 = принудительно развернуть воркеры + primary
PRIMARY_ONLY=0       # 1 = развернуть только указанный узел без обхода воркеров

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
[[ -t 1 ]] || { RED=; GRN=; YEL=; DIM=; OFF=; }

die()  { printf '%sошибка:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
warn() { printf '%sвнимание:%s %s\n' "$YEL" "$OFF" "$*" >&2; }
step() { printf '%s==>%s %s\n' "$GRN" "$OFF" "$*"; }
info() { printf '    %s%s%s\n' "$DIM" "$*" "$OFF"; }

usage() {
	cat <<'USAGE'
Использование:
  ./deploy.sh <ip-сервера> <путь-к-ssh-ключу> [пользователь] [опции]

Аргументы:
  ip-сервера         IPv4-адрес основного сервера (или конкретного воркера)
  путь-к-ssh-ключу   приватный ключ для подключения (по умолчанию наследуется воркерами)
  пользователь       SSH-пользователь (по умолчанию root; наследуется воркерами)

Опции:
  -p, --port ПОРТ          порт SSH по умолчанию (по умолчанию 22)
  -r, --role РОЛЬ          роль узла: auto (по умолчанию), primary или worker
  -a, --all                развернуть на все воркеры из cluster-nodes.json, затем на primary
      --primary-only       развернуть только на основной узел (пропустить пул воркеров)
  -n, --dry-run            показать план развёртывания без подключения и изменений
  -f, --force              не останавливаться на предупреждениях
  -h, --help               эта справка

Примеры:
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 ubuntu --all
  ./deploy.sh 153.80.200.171 ~/.ssh/id_ed25519 root --role worker
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 ubuntu --port 2222 --dry-run
USAGE
}

# --------------------------------------------------------------- аргументы

POSITIONAL=()
while (($#)); do
	case "$1" in
		-h|--help)         usage; exit 0 ;;
		-n|--dry-run)      DRY_RUN=1; shift ;;
		-f|--force)        FORCE=1; shift ;;
		-a|--all)          DEPLOY_ALL=1; shift ;;
		--primary-only)    PRIMARY_ONLY=1; shift ;;
		-p|--port)         SSH_PORT="${2:-}"; [[ -n $SSH_PORT ]] || die "--port без значения"; shift 2 ;;
		--port=*)          SSH_PORT="${1#*=}"; shift ;;
		-r|--role)         ROLE="${2:-}"; [[ -n $ROLE ]] || die "--role без значения"; shift 2 ;;
		--role=*)          ROLE="${1#*=}"; shift ;;
		-*)                die "неизвестная опция: $1 (см. --help)" ;;
		*)                 POSITIONAL+=("$1"); shift ;;
	esac
done

((${#POSITIONAL[@]} >= 2)) || { usage >&2; exit 1; }
((${#POSITIONAL[@]} <= 3)) || die "лишние аргументы: ${POSITIONAL[*]:3}"

SERVER_IP="${POSITIONAL[0]}"
SSH_KEY="${POSITIONAL[1]}"
SSH_USER="${POSITIONAL[2]:-root}"

validate_ipv4() {
	local ip="$1"
	[[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "«${ip}» не похож на IPv4-адрес"
	local octet
	for octet in ${ip//./ }; do
		((octet <= 255)) || die "«${ip}» не похож на IPv4-адрес: октет ${octet} больше 255"
	done
}

validate_ipv4 "$SERVER_IP"
[[ $SSH_PORT =~ ^[0-9]+$ ]] && ((SSH_PORT > 0 && SSH_PORT < 65536)) || die "некорректный порт SSH: $SSH_PORT"
[[ $ROLE == "auto" || $ROLE == "primary" || $ROLE == "worker" ]] || die "некорректная роль --role: $ROLE (ожидается auto, primary или worker)"

TEMP_KEY_FILES=()
ACTIVE_CTLS=()
ACTIVE_TARGETS=()
LOCAL_STAGE=""

cleanup_all() {
	if [[ -n ${LOCAL_STAGE:-} && -d ${LOCAL_STAGE:-} ]]; then
		rm -rf "$LOCAL_STAGE"
	fi
	if ((${#ACTIVE_CTLS[@]})); then
		local i
		for i in "${!ACTIVE_CTLS[@]}"; do
			local ctl="${ACTIVE_CTLS[$i]}"
			local tgt="${ACTIVE_TARGETS[$i]}"
			if [[ -n $ctl && -n $tgt ]]; then
				ssh -o "ControlPath=$ctl" -O exit "$tgt" 2>/dev/null || true
				rm -f "$ctl"
			fi
		done
	fi
	if ((${#TEMP_KEY_FILES[@]})); then
		local tf
		for tf in "${TEMP_KEY_FILES[@]}"; do
			[[ -n $tf ]] && rm -f "$tf"
		done
	fi
	return 0
}
trap cleanup_all EXIT

materialize_ssh_key() {
	# Принимает строку (путь к файлу или inline приватный ключ) и возвращает путь к файлу ключа.
	local raw_val="$1"
	local label="$2"
	if [[ $raw_val == *"-----BEGIN "* || $raw_val == *$'\n'* ]]; then
		local tmp_key
		tmp_key=$(mktemp "/tmp/.geoblock-key-XXXXXX")
		chmod 600 "$tmp_key"
		printf '%s\n' "$raw_val" >"$tmp_key"
		TEMP_KEY_FILES+=("$tmp_key")
		printf '%s' "$tmp_key"
		return 0
	fi
	local expanded="${raw_val/#\~/$HOME}"
	[[ -f $expanded ]] || die "ключ для $label не найден: $expanded"
	[[ -r $expanded ]] || die "ключ для $label недоступен для чтения: $expanded"
	local perms
	perms=$(stat -c '%a' "$expanded" 2>/dev/null || stat -f '%Lp' "$expanded" 2>/dev/null || echo "")
	if [[ -n $perms && $perms != 400 && $perms != 600 ]]; then
		warn "права на ключ $expanded ($perms), ssh может отказаться его использовать: chmod 600 $expanded"
	fi
	printf '%s' "$expanded"
}

SSH_KEY=$(materialize_ssh_key "$SSH_KEY" "primary ($SERVER_IP)")

cd "$(dirname "${BASH_SOURCE[0]}")"

# ------------------------------------------------------- локальные проверки

step "Проверяю локальные файлы"

LOCAL_FILES=(
	"$DNSMASQ_CONF"
	"$NGINX_CONF"
	"${NGINX_MAPS[@]}"
	"${NGINX_WORKER_CONFS[@]}"
	"$SERVICE_MAP"
	"$CLUSTER_NODES"
	"$STATS_COLLECTOR"
	"$DOH_PROXY"
	"$HEALTHCHECK"
	"${WEB_FILES[@]}"
)
missing=()
for f in "${LOCAL_FILES[@]}"; do
	[[ -f $f ]] || missing+=("$f")
done
if ((${#missing[@]})); then
	die "не хватает файлов: ${missing[*]}
    соберите их: python3 generate.py $SOURCE_YAML $SERVER_IP"
fi

# несведённые подстановки означают, что генератор падал на середине
for f in "${LOCAL_FILES[@]}"; do
	[[ $f == *.png || $f == *.ico || $f == "$STATS_COLLECTOR" || $f == "$DOH_PROXY" || $f == "$HEALTHCHECK" ]] && continue
	if grep -q '{{[a-z_]*}}' "$f"; then
		die "в $f остались подстановки {{...}} — генератор не доработал"
	fi
done

# списки уникальных доменов в dnsmasq и nginx-sni/host-allow.map должны совпадать
n_dnsmasq=$(awk -F/ '/^address=\//{print $2}' "$DNSMASQ_CONF" | sort -u | wc -l | tr -d ' ')
for m in "${NGINX_MAPS[@]}"; do
	n_map=$(grep -c '^\.' "$m" || true)
	((n_dnsmasq == n_map)) || die "в $DNSMASQ_CONF $n_dnsmasq уникальных доменов, а в $m — $n_map
    пересоберите оба файла одним запуском generate.py"
done
info "$n_dnsmasq доменов, списки dnsmasq и nginx совпадают"

DOMAIN=$(sed -n '/<key>ServerName<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;q;}' dns.mobileconfig)
[[ -n $DOMAIN ]] || die "не удалось определить ServerName из dns.mobileconfig"
info "домен сервера: $DOMAIN"

# Разбираем cluster-nodes.json через python3
CLUSTER_META=$(python3 - "$CLUSTER_NODES" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
primary = data.get("primary") or ""
print(f"PRIMARY={primary}")
for idx, w in enumerate(data.get("workers") or [], 1):
    if not isinstance(w, dict) or not w.get("ip"):
        continue
    fields = [
        w.get("ip") or "",
        w.get("name") or f"worker-{idx}",
        str(w.get("weight") or 1),
        w.get("ssh_user") or "",
        w.get("ssh_user_env") or "",
        w.get("ssh_key") or "",
        w.get("ssh_key_env") or "",
        str(w.get("ssh_port") or ""),
    ]
    print("WORKER=" + "|".join(fields))
PY
)

CLUSTER_PRIMARY=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^PRIMARY=//p' | head -1)
WORKER_LINES=()
while IFS= read -r line; do
	[[ -n $line ]] && WORKER_LINES+=("$line")
done < <(printf '%s\n' "$CLUSTER_META" | sed -n 's/^WORKER=//p')

# Проверяем соответствие IP в собранных конфигах (для primary / auto)
if [[ $ROLE != "worker" ]]; then
	ip_known=0
	[[ $SERVER_IP == "$CLUSTER_PRIMARY" ]] && ip_known=1
	if grep -q "/$SERVER_IP\$" "$DNSMASQ_CONF"; then
		ip_known=1
	fi
	if ((${#WORKER_LINES[@]})); then
		for wline in "${WORKER_LINES[@]}"; do
			[[ -z $wline ]] && continue
			wip="${wline%%|*}"
			[[ $SERVER_IP == "$wip" ]] && ip_known=1
		done
	fi
	if (( ! ip_known )); then
		baked="${CLUSTER_PRIMARY:-$(grep -m1 '^address=' "$DNSMASQ_CONF" | sed 's|.*/||')}"
		die "$DNSMASQ_CONF и $CLUSTER_NODES собраны для адреса ${baked:-неизвестного}, а разворачивается на $SERVER_IP
    пересоберите: python3 generate.py $SOURCE_YAML $SERVER_IP"
	fi
fi

if [[ -f $SOURCE_YAML ]]; then
	for f in "${LOCAL_FILES[@]}"; do
		[[ $f == "$STATS_COLLECTOR" || $f == "$DOH_PROXY" || $f == "$HEALTHCHECK" ]] && continue
		if [[ $SOURCE_YAML -nt $f ]]; then
			warn "$SOURCE_YAML новее, чем $f — возможно, забыли пересобрать"
			((FORCE)) || die "перезапустите generate.py или добавьте --force"
			break
		fi
	done
fi

# --------------------------------------------- разрешение SSH-реквизитов

resolve_env_or_literal() {
	local val="$1"
	if [[ $val =~ ^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$ ]]; then
		local var_name="${BASH_REMATCH[1]}"
		printf '%s' "${!var_name:-}"
	elif [[ $val =~ ^\$([A-Za-z_][A-Za-z0-9_]*)$ ]]; then
		local var_name="${BASH_REMATCH[1]}"
		printf '%s' "${!var_name:-}"
	else
		printf '%s' "$val"
	fi
}

resolve_worker_user() {
	local w_user="$1" w_user_env="$2"
	local resolved=""
	if [[ -n $w_user_env ]]; then
		resolved="${!w_user_env:-}"
	fi
	if [[ -z $resolved && -n $w_user ]]; then
		resolved=$(resolve_env_or_literal "$w_user")
	fi
	printf '%s' "${resolved:-$SSH_USER}"
}

resolve_worker_key() {
	local w_key="$1" w_key_env="$2" w_label="$3"
	local raw_key=""
	if [[ -n $w_key_env ]]; then
		raw_key="${!w_key_env:-}"
	fi
	if [[ -z $raw_key && -n $w_key ]]; then
		raw_key=$(resolve_env_or_literal "$w_key")
	fi
	if [[ -z $raw_key ]]; then
		printf '%s' "$SSH_KEY"
		return 0
	fi
	materialize_ssh_key "$raw_key" "$w_label"
}

resolve_worker_port() {
	local w_port="$1"
	if [[ -n $w_port ]]; then
		[[ $w_port =~ ^[0-9]+$ ]] && ((w_port > 0 && w_port < 65536)) || die "некорректный ssh_port воркера: $w_port"
		printf '%s' "$w_port"
	else
		printf '%s' "$SSH_PORT"
	fi
}

# ----------------------------------------- формирование apply.sh в stage

prepare_local_stage() {
	if [[ -n $LOCAL_STAGE && -d $LOCAL_STAGE ]]; then
		return 0
	fi
	step "Готовлю файлы для передачи"
	LOCAL_STAGE=$(mktemp -d)
	cp "${LOCAL_FILES[@]}" "$LOCAL_STAGE/"
	for f in "${LOCAL_FILES[@]}"; do
		info "$f ($(wc -c <"$f" | tr -d ' ') байт)"
	done

	cat >"$LOCAL_STAGE/apply.sh" <<'REMOTE'
#!/usr/bin/env bash
set -euo pipefail

STAGE="$1"; STAMP="$2"; SERVER_IP="$3"; DOMAIN="$4"; NODE_ROLE="${5:-primary}"
BACKUP="/var/backups/geoblock/$STAMP"
DNSMASQ_DST="/etc/dnsmasq.conf"
DNSMASQ_BASE_DST="/etc/nginx/geoblock/dnsmasq-base.conf"
DNSMASQ_OLD="/etc/dnsmasq.d/dnsmasq-geoblock.conf"
NGINX_DST="/etc/nginx/nginx.conf"
MAP_DIR="/etc/nginx/geoblock"
SSL_DIR="/etc/nginx/geoblock/ssl"
WEB_DIR="/var/www/geoblock"
SYSCTL_DST="/etc/sysctl.d/99-geoblock-highload.conf"
COLLECTOR_DST="/usr/local/bin/pereval-stats-collector.py"
STATS_UNIT_DST="/etc/systemd/system/pereval-stats.service"
STATS_STATE_DIR="/var/lib/pereval-stats"
DOH_DST="/usr/local/bin/pereval-doh-proxy.py"
DOH_UNIT_DST="/etc/systemd/system/pereval-doh.service"
HC_DST="/usr/local/bin/pereval-healthcheck.py"
HC_UNIT_DST="/etc/systemd/system/pereval-healthcheck.service"
HC_STATE_DIR="/var/lib/pereval-healthcheck"

say()  { printf '    %s\n' "$*"; }
fail() { printf 'ошибка на сервере (%s): %s\n' "$SERVER_IP" "$*" >&2; exit 1; }

# --- освобождение порта 53 от systemd-resolved stub listener при необходимости
if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
	if ss -tulnp '( sport = :53 )' 2>/dev/null | grep -qE '127\.0\.0\.5[34]|systemd-resolve'; then
		say "освобождаю порт 53 от systemd-resolved stub listener..."
		mkdir -p /etc/systemd/resolved.conf.d
		cat >/etc/systemd/resolved.conf.d/geoblock.conf <<'RESCONF'
[Resolve]
DNSStubListener=no
Domains=~.
DNS=1.1.1.1 8.8.8.8
RESCONF
		systemctl restart systemd-resolved || true
		if [[ -L /etc/resolv.conf ]] && readlink /etc/resolv.conf | grep -q 'stub-resolv.conf'; then
			ln -sfn /run/systemd/resolve/resolv.conf /etc/resolv.conf || true
		fi
		if ! grep -qE '^nameserver\s+[0-9]+' /etc/resolv.conf 2>/dev/null || grep -qE '^nameserver\s+127\.' /etc/resolv.conf 2>/dev/null; then
			rm -f /etc/resolv.conf
			printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >/etc/resolv.conf
		fi
		say "порт 53 освобождён для dnsmasq"
	fi
fi

mkdir -p "$BACKUP" "$MAP_DIR" "$SSL_DIR" "$WEB_DIR/.well-known/acme-challenge" "$STATS_STATE_DIR" "$HC_STATE_DIR" /etc/sysctl.d

# --- всё ли доехало -------------------------------------------------------
for f in dnsmasq-geoblock.conf nginx.conf nginx-sni-allow.map nginx-host-allow.map nginx-workers-stream.conf nginx-workers-http.conf service-map.json cluster-nodes.json stats_collector.py doh_proxy.py healthcheck.py index.html stats.html terms.html privacy.html dns.mobileconfig favicon.svg favicon.ico apple-touch-icon.png og-image.svg og-image.png robots.txt sitemap.xml; do
	[[ -s "$STAGE/$f" ]] || fail "файл $f не доехал или пустой — передача оборвалась"
done
say "получено 23 файла (роль узла: $NODE_ROLE)"

# Для воркера формируем локальный dnsmasq.conf со своим IP и прямые nginx-workers-*.conf,
# чтобы воркер всегда выходил напрямую в интернет со своего IP без петель.
if [[ $NODE_ROLE == "worker" ]]; then
	python3 "$STAGE/healthcheck.py" -c >/dev/null 2>&1 || true
	python3 - "$STAGE/dnsmasq-geoblock.conf" "$STAGE/dnsmasq-node.conf" "$SERVER_IP" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
import healthcheck
tpl = Path(sys.argv[1]).read_text(encoding="utf-8")
Path(sys.argv[2]).write_text(healthcheck.render_dnsmasq_conf(tpl, [sys.argv[3]]), encoding="utf-8")
PY
	cat >"$STAGE/nginx-workers-stream.node.conf" <<'EOF'
# Прямой выход с воркера на реальный origin (без каскадной пересылки)
map $sni_allow_target $sni_upstream {
    default           $sni_allow_target;
    "__WORKERS__"     $ssl_preread_server_name:443;
}
EOF
	cat >"$STAGE/nginx-workers-http.node.conf" <<'EOF'
# Прямой выход с воркера на реальный origin (без каскадной пересылки)
map $http_allow_target $http_upstream {
    default           $http_allow_target;
    "__WORKERS__"     $host;
}
EOF
else
	cp -a "$STAGE/dnsmasq-geoblock.conf" "$STAGE/dnsmasq-node.conf"
	cp -a "$STAGE/nginx-workers-stream.conf" "$STAGE/nginx-workers-stream.node.conf"
	cp -a "$STAGE/nginx-workers-http.conf" "$STAGE/nginx-workers-http.node.conf"
fi

# --- проверка синтаксиса ДО того, как что-то тронуто -----------------------
dnsmasq --test -C "$STAGE/dnsmasq-node.conf" \
	|| fail "dnsmasq не принимает новый конфиг, ничего не менял"
say "синтаксис dnsmasq в порядке"

# --- резервные копии ------------------------------------------------------
backup_one() {  # <источник> <имя-в-бэкапе>
	if [[ -f $1 ]]; then
		cp -a "$1" "$BACKUP/$2"
	fi
}
backup_one "$DNSMASQ_DST"                          dnsmasq.conf
backup_one "$DNSMASQ_BASE_DST"                     dnsmasq-base.conf
backup_one "$NGINX_DST"                            nginx.conf
backup_one "$MAP_DIR/nginx-sni-allow.map"          nginx-sni-allow.map
backup_one "$MAP_DIR/nginx-host-allow.map"         nginx-host-allow.map
backup_one "$MAP_DIR/nginx-workers-stream.conf"    nginx-workers-stream.conf
backup_one "$MAP_DIR/nginx-workers-http.conf"      nginx-workers-http.conf
backup_one "$MAP_DIR/service-map.json"             service-map.json
backup_one "$MAP_DIR/cluster-nodes.json"           cluster-nodes.json
backup_one "$COLLECTOR_DST"                        pereval-stats-collector.py
backup_one "$STATS_UNIT_DST"                       pereval-stats.service
backup_one "$DOH_DST"                              pereval-doh-proxy.py
backup_one "$DOH_UNIT_DST"                         pereval-doh.service
backup_one "$HC_DST"                               pereval-healthcheck.py
backup_one "$HC_UNIT_DST"                          pereval-healthcheck.service
backup_one "$WEB_DIR/index.html"                   index.html
backup_one "$WEB_DIR/stats.html"                   stats.html
backup_one "$WEB_DIR/terms.html"                   terms.html
backup_one "$WEB_DIR/privacy.html"                 privacy.html
backup_one "$WEB_DIR/dns.mobileconfig"             dns.mobileconfig
backup_one "$WEB_DIR/favicon.svg"                  favicon.svg
backup_one "$WEB_DIR/favicon.ico"                  favicon.ico
backup_one "$WEB_DIR/apple-touch-icon.png"         apple-touch-icon.png
backup_one "$WEB_DIR/og-image.svg"                 og-image.svg
backup_one "$WEB_DIR/og-image.png"                 og-image.png
backup_one "$WEB_DIR/robots.txt"                   robots.txt
backup_one "$WEB_DIR/sitemap.xml"                  sitemap.xml
backup_one "$SYSCTL_DST"                           99-geoblock-highload.conf
say "резервные копии: $BACKUP"

restore() {
	printf 'откатываю изменения\n' >&2
	for name in dnsmasq.conf dnsmasq-base.conf nginx.conf nginx-sni-allow.map nginx-host-allow.map nginx-workers-stream.conf nginx-workers-http.conf service-map.json cluster-nodes.json pereval-stats-collector.py pereval-stats.service pereval-doh-proxy.py pereval-doh.service pereval-healthcheck.py pereval-healthcheck.service index.html stats.html terms.html privacy.html dns.mobileconfig favicon.svg favicon.ico apple-touch-icon.png og-image.svg og-image.png robots.txt sitemap.xml 99-geoblock-highload.conf; do
		if [[ -f "$BACKUP/$name" ]]; then
			case "$name" in
				dnsmasq.conf)                                                                                                    cp -a "$BACKUP/$name" "$DNSMASQ_DST" ;;
				dnsmasq-base.conf)                                                                                               cp -a "$BACKUP/$name" "$DNSMASQ_BASE_DST" ;;
				nginx.conf)                                                                                                      cp -a "$BACKUP/$name" "$NGINX_DST" ;;
				99-geoblock-highload.conf)                                                                                       cp -a "$BACKUP/$name" "$SYSCTL_DST" ;;
				pereval-stats-collector.py)                                                                                      cp -a "$BACKUP/$name" "$COLLECTOR_DST" ;;
				pereval-stats.service)                                                                                           cp -a "$BACKUP/$name" "$STATS_UNIT_DST" ;;
				pereval-doh-proxy.py)                                                                                            cp -a "$BACKUP/$name" "$DOH_DST" ;;
				pereval-doh.service)                                                                                             cp -a "$BACKUP/$name" "$DOH_UNIT_DST" ;;
				pereval-healthcheck.py)                                                                                          cp -a "$BACKUP/$name" "$HC_DST" ;;
				pereval-healthcheck.service)                                                                                     cp -a "$BACKUP/$name" "$HC_UNIT_DST" ;;
				index.html|stats.html|terms.html|privacy.html|dns.mobileconfig|favicon.svg|favicon.ico|apple-touch-icon.png|og-image.svg|og-image.png|robots.txt|sitemap.xml) cp -a "$BACKUP/$name" "$WEB_DIR/$name" ;;
				*)                                                                                                               cp -a "$BACKUP/$name" "$MAP_DIR/$name" ;;
			esac
		fi
	done
	systemctl daemon-reload 2>/dev/null || true
	systemctl restart dnsmasq 2>/dev/null || true
	systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
	systemctl restart pereval-doh.service 2>/dev/null || true
	systemctl restart pereval-stats.service 2>/dev/null || true
	if [[ $NODE_ROLE == "primary" ]]; then
		systemctl restart pereval-healthcheck.service 2>/dev/null || true
	fi
}

# --- тюнинг сетевого стека ядра под высокую нагрузку -----------------------
cat >"$SYSCTL_DST" <<'SYSCTL'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.ip_local_port_range = 10240 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_max_tw_buckets = 131072
net.core.somaxconn = 16384
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 16384
net.netfilter.nf_conntrack_max = 262144
net.netfilter.nf_conntrack_tcp_timeout_established = 1800
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_tcp_timeout_close_wait = 15
net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 3
SYSCTL
chmod 0644 "$SYSCTL_DST"
sysctl -e -p "$SYSCTL_DST" >/dev/null 2>&1 || sysctl --system >/dev/null 2>&1 || true
say "применены параметры ядра ($SYSCTL_DST)"

# --- firewall: открыть TCP/853 для DNS-over-TLS ---------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
	if ! ufw status | grep -qE '^853/tcp\s+ALLOW'; then
		ufw allow 853/tcp >/dev/null
		say "открыт порт 853/tcp в ufw (DNS-over-TLS)"
	fi
fi

# --- TLS-сертификат: привязка к Let's Encrypt или временный самоподписанный --
LE_LIVE="/etc/letsencrypt/live/$DOMAIN"
if [[ -f "$LE_LIVE/fullchain.pem" && -f "$LE_LIVE/privkey.pem" ]]; then
	ln -sfn "$LE_LIVE/fullchain.pem" "$SSL_DIR/fullchain.pem"
	ln -sfn "$LE_LIVE/privkey.pem"   "$SSL_DIR/privkey.pem"
elif [[ ! -f "$SSL_DIR/fullchain.pem" || ! -f "$SSL_DIR/privkey.pem" ]]; then
	openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
		-subj "/CN=$DOMAIN" \
		-keyout "$SSL_DIR/privkey.pem" \
		-out "$SSL_DIR/fullchain.pem" >/dev/null 2>&1
	chmod 600 "$SSL_DIR/privkey.pem"
	say "создан временный самоподписанный сертификат для $DOMAIN"
fi

# --- статика сайта и профиль iOS ------------------------------------------
install -m 0644 "$STAGE/index.html"            "$WEB_DIR/index.html"
install -m 0644 "$STAGE/stats.html"            "$WEB_DIR/stats.html"
install -m 0644 "$STAGE/terms.html"            "$WEB_DIR/terms.html"
install -m 0644 "$STAGE/privacy.html"          "$WEB_DIR/privacy.html"
install -m 0644 "$STAGE/dns.mobileconfig"      "$WEB_DIR/dns.mobileconfig"
install -m 0644 "$STAGE/favicon.svg"           "$WEB_DIR/favicon.svg"
install -m 0644 "$STAGE/favicon.ico"           "$WEB_DIR/favicon.ico"
install -m 0644 "$STAGE/apple-touch-icon.png"  "$WEB_DIR/apple-touch-icon.png"
install -m 0644 "$STAGE/og-image.svg"          "$WEB_DIR/og-image.svg"
install -m 0644 "$STAGE/og-image.png"          "$WEB_DIR/og-image.png"
install -m 0644 "$STAGE/robots.txt"            "$WEB_DIR/robots.txt"
install -m 0644 "$STAGE/sitemap.xml"           "$WEB_DIR/sitemap.xml"

# --- nginx: сначала установить, потом проверить, при провале откатить ------
install -m 0644 "$STAGE/nginx-sni-allow.map"             "$MAP_DIR/nginx-sni-allow.map"
install -m 0644 "$STAGE/nginx-host-allow.map"            "$MAP_DIR/nginx-host-allow.map"
install -m 0644 "$STAGE/nginx-workers-stream.node.conf"  "$MAP_DIR/nginx-workers-stream.conf"
install -m 0644 "$STAGE/nginx-workers-http.node.conf"    "$MAP_DIR/nginx-workers-http.conf"
install -m 0644 "$STAGE/service-map.json"                "$MAP_DIR/service-map.json"
install -m 0644 "$STAGE/cluster-nodes.json"              "$MAP_DIR/cluster-nodes.json"
install -m 0644 "$STAGE/dnsmasq-geoblock.conf"           "$DNSMASQ_BASE_DST"
install -m 0644 "$STAGE/nginx.conf"                      "$NGINX_DST"

# --- DNS-over-HTTPS прокси (pereval-doh.service) --------------------------
install -m 0755 "$STAGE/doh_proxy.py"         "$DOH_DST"
cat >"$DOH_UNIT_DST" <<UNIT
[Unit]
Description=Pereval high-performance DNS-over-HTTPS (DoH, RFC 8484) proxy
After=network.target dnsmasq.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 $DOH_DST --listen-host 127.0.0.1 --listen-port 8053 --upstream-host 127.0.0.1 --upstream-port 53
Restart=always
RestartSec=2
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$DOH_UNIT_DST"

# --- коллектор статистики (pereval-stats.service) -------------------------
install -m 0755 "$STAGE/stats_collector.py"   "$COLLECTOR_DST"
cat >"$STATS_UNIT_DST" <<UNIT
[Unit]
Description=Pereval lightweight nginx proxy usage collector
After=network.target nginx.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 $COLLECTOR_DST --service-map $MAP_DIR/service-map.json --cluster-config $MAP_DIR/cluster-nodes.json --node-output $WEB_DIR/node-stats.json --output $WEB_DIR/stats.json --state-file $STATS_STATE_DIR/state.json --self-domain $DOMAIN --role $NODE_ROLE
Restart=always
RestartSec=5
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$STATS_UNIT_DST"
/usr/bin/python3 "$COLLECTOR_DST" \
	--service-map "$MAP_DIR/service-map.json" \
	--cluster-config "$MAP_DIR/cluster-nodes.json" \
	--node-output "$WEB_DIR/node-stats.json" \
	--output "$WEB_DIR/stats.json" \
	--state-file "$STATS_STATE_DIR/state.json" \
	--self-domain "$DOMAIN" \
	--role "$NODE_ROLE" \
	--once || true

# --- демон мониторинга воркеров и failover (pereval-healthcheck.service) --
install -m 0755 "$STAGE/healthcheck.py"       "$HC_DST"
if [[ $NODE_ROLE == "primary" ]]; then
	cat >"$HC_UNIT_DST" <<UNIT
[Unit]
Description=Pereval active worker healthcheck and DNS/nginx failover daemon
After=network.target dnsmasq.service nginx.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 $HC_DST --cluster-config $MAP_DIR/cluster-nodes.json --dnsmasq-template $DNSMASQ_BASE_DST --dnsmasq-out $DNSMASQ_DST --nginx-stream-out $MAP_DIR/nginx-workers-stream.conf --nginx-http-out $MAP_DIR/nginx-workers-http.conf --status-out $WEB_DIR/cluster-health.json --state-file $HC_STATE_DIR/state.json --interval 5 --fail-threshold 2 --rise-threshold 2
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
	chmod 0644 "$HC_UNIT_DST"
fi

# --- установка dnsmasq ----------------------------------------------------
install -m 0644 "$STAGE/dnsmasq-node.conf" "$DNSMASQ_DST"

# На основном узле сразу выполняем одиночный цикл healthcheck (без рестарта сервисов),
# чтобы /etc/dnsmasq.conf, nginx-workers-*.conf и cluster-health.json отражали
# реальную доступность воркеров до проверки nginx -t и запуска dnsmasq.
if [[ $NODE_ROLE == "primary" ]]; then
	/usr/bin/python3 "$HC_DST" \
		--cluster-config "$MAP_DIR/cluster-nodes.json" \
		--dnsmasq-template "$DNSMASQ_BASE_DST" \
		--dnsmasq-out "$DNSMASQ_DST" \
		--nginx-stream-out "$MAP_DIR/nginx-workers-stream.conf" \
		--nginx-http-out "$MAP_DIR/nginx-workers-http.conf" \
		--status-out "$WEB_DIR/cluster-health.json" \
		--state-file "$HC_STATE_DIR/state.json" \
		--fail-threshold 1 \
		--rise-threshold 1 \
		--no-service-reload \
		--once || true
fi

if ! nginx -t 2>/tmp/nginx-test.log; then
	cat /tmp/nginx-test.log >&2
	restore
	fail "nginx -t не прошёл, откатился на предыдущий конфиг"
fi
say "синтаксис nginx в порядке"

if [[ -f $DNSMASQ_OLD ]]; then
	cp -a "$DNSMASQ_OLD" "$BACKUP/dnsmasq.d-dnsmasq-geoblock.conf"
	rm -f "$DNSMASQ_OLD"
	say "убрал устаревший $DNSMASQ_OLD (копия в бэкапе)"
fi

# --- перезапуск -----------------------------------------------------------
if ! systemctl restart dnsmasq; then
	journalctl -u dnsmasq -n 20 --no-pager >&2 || true
	restore
	fail "dnsmasq не поднялся"
fi
say "dnsmasq перезапущен"

if systemctl is-active --quiet nginx; then
	if ! systemctl reload nginx; then
		journalctl -u nginx -n 20 --no-pager >&2 || true
		restore
		fail "nginx не перезагрузился"
	fi
	say "nginx перезагружен"
else
	if ! systemctl restart nginx; then
		journalctl -u nginx -n 20 --no-pager >&2 || true
		restore
		fail "nginx не поднялся"
	fi
	say "nginx запущен"
fi

systemctl daemon-reload
systemctl enable pereval-doh.service >/dev/null 2>&1 || true
if ! systemctl restart pereval-doh.service; then
	journalctl -u pereval-doh.service -n 20 --no-pager >&2 || true
	restore
	fail "pereval-doh.service не поднялся"
fi
say "DNS-over-HTTPS прокси pereval-doh перезапущен"

systemctl enable pereval-stats.service >/dev/null 2>&1 || true
if ! systemctl restart pereval-stats.service; then
	journalctl -u pereval-stats.service -n 20 --no-pager >&2 || true
	restore
	fail "pereval-stats.service не поднялся"
fi
say "коллектор статистики pereval-stats перезапущен"

if [[ $NODE_ROLE == "primary" ]]; then
	systemctl enable pereval-healthcheck.service >/dev/null 2>&1 || true
	if ! systemctl restart pereval-healthcheck.service; then
		journalctl -u pereval-healthcheck.service -n 20 --no-pager >&2 || true
		restore
		fail "pereval-healthcheck.service не поднялся"
	fi
	say "демон мониторинга воркеров pereval-healthcheck перезапущен"
else
	if systemctl list-unit-files pereval-healthcheck.service >/dev/null 2>&1; then
		systemctl disable --now pereval-healthcheck.service >/dev/null 2>&1 || true
	fi
fi

# --- выпуск и автопродление сертификата Let's Encrypt (только на Primary) -
if [[ $NODE_ROLE != "primary" ]]; then
	say "узел с ролью worker — пропуск выпуска сертификата Let's Encrypt (используется локальный сертификат)"
elif [[ $DOMAIN == *.example || $DOMAIN == *.invalid || $DOMAIN == *.localhost ]]; then
	say "ВНИМАНИЕ: домен $DOMAIN тестовый — пропуск выпуска сертификата Let's Encrypt (укажите настоящий meta.origin в services.yaml)"
else
	if ! command -v certbot >/dev/null 2>&1; then
		say "устанавливаю certbot..."
		DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update -qq >/dev/null
		DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y -qq certbot >/dev/null
		say "certbot установлен"
	fi

	mkdir -p /etc/letsencrypt/renewal-hooks/deploy
	cat >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/usr/bin/env bash
systemctl reload nginx
HOOK
	chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

	if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
		systemctl enable --now certbot.timer >/dev/null 2>&1 || true
		say "автопродление certbot.timer активно"
	fi

	if certbot certonly --webroot -w "$WEB_DIR" -d "$DOMAIN" \
		--non-interactive --agree-tos --register-unsafely-without-email \
		--keep-until-expiring >/tmp/certbot.log 2>&1; then
		ln -sfn "$LE_LIVE/fullchain.pem" "$SSL_DIR/fullchain.pem"
		ln -sfn "$LE_LIVE/privkey.pem"   "$SSL_DIR/privkey.pem"
		nginx -t 2>/tmp/nginx-test.log && systemctl reload nginx
		say "сертификат Let's Encrypt для $DOMAIN активен"
	else
		say "ВНИМАНИЕ: certbot не смог выпустить сертификат для $DOMAIN (см. /tmp/certbot.log)"
		cat /tmp/certbot.log >&2 || true
	fi
fi

# --- проверка результата --------------------------------------------------
sleep 1
EXPECTED_UNITS=(dnsmasq nginx pereval-doh pereval-stats)
if [[ $NODE_ROLE == "primary" ]]; then
	EXPECTED_UNITS+=(pereval-healthcheck)
fi
for unit in "${EXPECTED_UNITS[@]}"; do
	systemctl is-active --quiet "$unit" || { restore; fail "$unit не активен после перезапуска"; }
done

got=""
if command -v dig >/dev/null 2>&1; then
	got=$(dig +short +time=3 +tries=1 @127.0.0.1 claude.ai 2>/dev/null | head -1)
elif command -v kdig >/dev/null 2>&1; then
	got=$(kdig +short @127.0.0.1 claude.ai 2>/dev/null | head -1)
fi
if [[ -z $got ]]; then
	say "проверить подмену нечем — поставьте dnsutils: apt install -y dnsutils"
elif grep -q "/$got\$" "$DNSMASQ_DST"; then
	say "проверка: claude.ai -> $got, подмена работает"
else
	say "ВНИМАНИЕ: claude.ai -> ${got:-пусто}, адрес не найден в $DNSMASQ_DST"
fi

for port in 80 443 853 8053; do
	if ss -tlnH "sport = :$port" | grep -q .; then
		say "порт $port слушается"
	else
		say "ВНИМАНИЕ: на порту $port никто не слушает"
	fi
done

# --- чистка старых бэкапов, оставляем последние 10 ------------------------
{ ls -1dt /var/backups/geoblock/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf; } || true

exit 0
REMOTE
}

# ------------------------------------------------ развёртывание одного узла

deploy_node() {
	local node_ip="$1"
	local node_user="$2"
	local node_key="$3"
	local node_port="$4"
	local node_role="$5"
	local node_name="$6"

	local target="$node_user@$node_ip"
	local ctl="/tmp/.geoblock-cm-$$-${#ACTIVE_CTLS[@]}"
	local ssh_opts=(
		-i "$node_key"
		-p "$node_port"
		-o IdentitiesOnly=yes
		-o BatchMode=yes
		-o ConnectTimeout=10
		-o StrictHostKeyChecking=accept-new
		-o LogLevel=ERROR
		-o ControlMaster=auto
		-o "ControlPath=$ctl"
		-o ControlPersist=120
	)

	if ((DRY_RUN)); then
		step "Пробный запуск [$node_role: $node_name ($target:$node_port)], изменений не будет"
		info "SSH-пользователь: $node_user | SSH-ключ: $node_key | порт: $node_port | роль: $node_role"
		if ssh "${ssh_opts[@]}" -o ConnectTimeout=5 "$target" true 2>/dev/null; then
			ACTIVE_CTLS+=("$ctl")
			ACTIVE_TARGETS+=("$target")
			local dry_sudo=""
			if [[ $node_user != root ]]; then
				if ssh "${ssh_opts[@]}" "$target" "sudo -n true" 2>/dev/null; then
					dry_sudo="sudo"
				else
					warn "пользователю $node_user на $node_ip потребуется sudo без пароля"
				fi
			fi
			local dry_probe
			dry_probe=$(ssh "${ssh_opts[@]}" "$target" "$dry_sudo bash -s" <<'DRYPRE' || true
set -uo pipefail
os_name="Linux"
if . /etc/os-release 2>/dev/null; then os_name="${PRETTY_NAME:-Linux}"; fi
printf 'os=%s (%s)\n' "$os_name" "$(hostname 2>/dev/null || echo unknown)"
need_pkgs=()
command -v tar >/dev/null 2>&1 || need_pkgs+=(tar)
command -v nginx >/dev/null 2>&1 || need_pkgs+=(nginx)
if ! nginx -V 2>&1 | grep -qE -- '--with-stream($| )' && [[ ! -f /usr/lib/nginx/modules/ngx_stream_module.so && ! -f /etc/nginx/modules-enabled/50-mod-stream.conf ]]; then
	need_pkgs+=(libnginx-mod-stream)
fi
command -v dnsmasq >/dev/null 2>&1 || need_pkgs+=(dnsmasq)
command -v python3 >/dev/null 2>&1 || need_pkgs+=(python3)
command -v openssl >/dev/null 2>&1 || need_pkgs+=(openssl)
command -v dig >/dev/null 2>&1 || need_pkgs+=(dnsutils)
command -v ss >/dev/null 2>&1 || need_pkgs+=(iproute2)
[[ -d /etc/ssl/certs ]] || need_pkgs+=(ca-certificates)
printf 'missing_pkgs=%s\n' "${need_pkgs[*]:-нет (все установлены)}"
if systemctl is-active --quiet systemd-resolved 2>/dev/null && ss -tulnp '( sport = :53 )' 2>/dev/null | grep -qE '127\.0\.0\.5[34]|systemd-resolve'; then
	printf 'port53=занят systemd-resolved (будет автоматически освобождён через DNSStubListener=no)\n'
else
	printf 'port53=готов\n'
fi
DRYPRE
			)
			info "SSH-подключение: OK — $(printf '%s\n' "$dry_probe" | sed -n 's/^os=//p' | head -1)"
			info "пакеты для доустановки: $(printf '%s\n' "$dry_probe" | sed -n 's/^missing_pkgs=//p' | head -1)"
			info "статус порта 53: $(printf '%s\n' "$dry_probe" | sed -n 's/^port53=//p' | head -1)"
		else
			info "автоустановка при отсутствии: tar nginx libnginx-mod-stream dnsmasq python3 openssl dnsutils iproute2 ca-certificates"
		fi
		printf '    %-28s -> %s\n' "$DNSMASQ_CONF" "/etc/dnsmasq.conf (и /etc/nginx/geoblock/dnsmasq-base.conf)"
		printf '    %-28s -> %s\n' "$NGINX_CONF" "/etc/nginx/nginx.conf"
		for m in "${NGINX_MAPS[@]}" "${NGINX_WORKER_CONFS[@]}"; do
			printf '    %-28s -> %s\n' "$m" "/etc/nginx/geoblock/$m"
		done
		printf '    %-28s -> %s\n' "$SERVICE_MAP" "/etc/nginx/geoblock/$SERVICE_MAP"
		printf '    %-28s -> %s\n' "$CLUSTER_NODES" "/etc/nginx/geoblock/$CLUSTER_NODES"
		printf '    %-28s -> %s\n' "$STATS_COLLECTOR" "/usr/local/bin/pereval-stats-collector.py"
		printf '    %-28s -> %s\n' "pereval-stats.service" "/etc/systemd/system/pereval-stats.service"
		printf '    %-28s -> %s\n' "$DOH_PROXY" "/usr/local/bin/pereval-doh-proxy.py"
		printf '    %-28s -> %s\n' "pereval-doh.service" "/etc/systemd/system/pereval-doh.service"
		printf '    %-28s -> %s\n' "$HEALTHCHECK" "/usr/local/bin/pereval-healthcheck.py"
		if [[ $node_role == "primary" ]]; then
			printf '    %-28s -> %s\n' "pereval-healthcheck.service" "/etc/systemd/system/pereval-healthcheck.service"
		fi
		for w in "${WEB_FILES[@]}"; do
			printf '    %-28s -> %s\n' "$w" "/var/www/geoblock/$w"
		done
		printf '    %-28s -> %s\n' "sysctl (highload)" "/etc/sysctl.d/99-geoblock-highload.conf"
		if [[ $node_role == "primary" ]]; then
			printf '    затем: sysctl -e -p, dnsmasq --test, nginx -t, restart dnsmasq, reload nginx, restart pereval-doh, restart pereval-stats, restart pereval-healthcheck, certbot (%s)\n' "$DOMAIN"
		else
			printf '    затем: sysctl -e -p, dnsmasq --test, nginx -t, restart dnsmasq, reload nginx, restart pereval-doh, restart pereval-stats (прямой выход origin)\n'
		fi
		return 0
	fi

	step "Подключаюсь к [$node_role: $node_name] $target:$node_port"
	ssh "${ssh_opts[@]}" "$target" true 2>/dev/null \
		|| die "не удалось подключиться по SSH к $target:$node_port.
    Проверьте адрес, порт, пользователя и что ключ добавлен в authorized_keys.
    Если раньше подключение работало, возможно сработало ограничение частоты
    (ufw limit 22/tcp или fail2ban) — подождите 30 секунд и повторите.
    Для подробностей: ssh -vv -i $node_key -p $node_port $target"
	ACTIVE_CTLS+=("$ctl")
	ACTIVE_TARGETS+=("$target")

	local sudo_cmd=""
	if [[ $node_user != root ]]; then
		ssh "${ssh_opts[@]}" "$target" "sudo -n true" 2>/dev/null \
			|| die "пользователю $node_user на $node_ip нужен sudo без пароля.
    Добавьте на сервере: echo '$node_user ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/$node_user"
		sudo_cmd="sudo"
		info "команды выполняются через sudo"
	fi

	# Проверка окружения и автоматическая доустановка недостающих сервисов и утилит
	local preflight
	preflight=$(ssh "${ssh_opts[@]}" "$target" "$sudo_cmd bash -s" <<'PRE'
set -euo pipefail
if . /etc/os-release 2>/dev/null; then printf 'os=%s\n' "${PRETTY_NAME:-Linux}"; fi

# Освобождаем порт 53 от systemd-resolved ДО установки dnsmasq, чтобы postinst-скрипт
# пакета dnsmasq сразу смог занять порт 53 без ошибки dpkg.
if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
	if ss -tulnp '( sport = :53 )' 2>/dev/null | grep -qE '127\.0\.0\.5[34]|systemd-resolve'; then
		mkdir -p /etc/systemd/resolved.conf.d
		cat >/etc/systemd/resolved.conf.d/geoblock.conf <<'RESCONF'
[Resolve]
DNSStubListener=no
Domains=~.
DNS=1.1.1.1 8.8.8.8
RESCONF
		systemctl restart systemd-resolved || true
		if [[ -L /etc/resolv.conf ]] && readlink /etc/resolv.conf | grep -q 'stub-resolv.conf'; then
			ln -sfn /run/systemd/resolve/resolv.conf /etc/resolv.conf || true
		fi
		if ! grep -qE '^nameserver\s+[0-9]+' /etc/resolv.conf 2>/dev/null || grep -qE '^nameserver\s+127\.' /etc/resolv.conf 2>/dev/null; then
			rm -f /etc/resolv.conf
			printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >/etc/resolv.conf
		fi
		printf 'freed_port53=yes\n'
	fi
fi

need_pkgs=()
command -v tar >/dev/null 2>&1 || need_pkgs+=(tar)
command -v nginx >/dev/null 2>&1 || need_pkgs+=(nginx)
if ! nginx -V 2>&1 | grep -qE -- '--with-stream($| )' && [[ ! -f /usr/lib/nginx/modules/ngx_stream_module.so && ! -f /etc/nginx/modules-enabled/50-mod-stream.conf ]]; then
	need_pkgs+=(libnginx-mod-stream)
fi
command -v dnsmasq >/dev/null 2>&1 || need_pkgs+=(dnsmasq)
command -v python3 >/dev/null 2>&1 || need_pkgs+=(python3)
command -v openssl >/dev/null 2>&1 || need_pkgs+=(openssl)
command -v dig >/dev/null 2>&1 || need_pkgs+=(dnsutils)
command -v ss >/dev/null 2>&1 || need_pkgs+=(iproute2)
[[ -d /etc/ssl/certs ]] || need_pkgs+=(ca-certificates)

if ((${#need_pkgs[@]})); then
	printf 'installing=%s\n' "${need_pkgs[*]}"
	export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
	apt-get update -qq >/dev/null
	apt-get install -y -qq "${need_pkgs[@]}" >/dev/null || {
		systemctl reset-failed dnsmasq 2>/dev/null || true
	}
fi

for u in dnsmasq nginx; do
	if systemctl list-unit-files "$u.service" >/dev/null 2>&1 || systemctl cat "$u" >/dev/null 2>&1; then
		printf 'unit=%s\n' "$u"
	fi
done
if command -v tar >/dev/null 2>&1; then printf 'tar=yes\n'; fi
exit 0
PRE
	)

	info "сервер ($node_ip): $(printf '%s' "$preflight" | sed -n 's/^os=//p' | head -1)"
	if printf '%s' "$preflight" | grep -qx 'freed_port53=yes'; then
		info "порт 53 освобождён от systemd-resolved stub listener"
	fi
	local installed_pkgs
	installed_pkgs=$(printf '%s' "$preflight" | sed -n 's/^installing=//p' | head -1)
	if [[ -n $installed_pkgs ]]; then
		info "автоматически установлены пакеты: $installed_pkgs"
	fi

	for unit in dnsmasq nginx; do
		printf '%s' "$preflight" | grep -qx "unit=$unit" \
			|| die "на сервере $node_ip не удалось подготовить сервис $unit"
	done
	printf '%s' "$preflight" | grep -qx 'tar=yes' \
		|| die "на сервере $node_ip отсутствует tar после автоустановки"

	prepare_local_stage

	local stamp
	stamp=$(date +%Y%m%d-%H%M%S)
	local stage="/tmp/geoblock-$stamp-$$"

	step "Передаю файлы на $node_ip в $stage"
	if ! COPYFILE_DISABLE=1 tar -cf - -C "$LOCAL_STAGE" . \
		| ssh "${ssh_opts[@]}" "$target" "mkdir -p '$stage' && (tar --warning=no-unknown-keyword -xf - -C '$stage' 2>/dev/null || tar -xf - -C '$stage')"; then
		die "не удалось передать файлы на сервер $node_ip"
	fi

	step "Применяю на сервере $node_ip (роль: $node_role)"
	local apply_rc=0
	ssh "${ssh_opts[@]}" "$target" \
		"$sudo_cmd bash '$stage/apply.sh' '$stage' '$stamp' '$node_ip' '$DOMAIN' '$node_role'" || apply_rc=$?

	ssh "${ssh_opts[@]}" "$target" "rm -rf '$stage'" 2>/dev/null || true

	if ((apply_rc == 0)); then
		step "Узел $node_ip ($node_role: $node_name) успешно обновлён"
	else
		die "развёртывание на $node_ip ($node_role) не удалось, конфиги откачены на предыдущие"
	fi
}

# ------------------------------------------------ оркестрация развёртывания

# Определяем режим развёртывания:
# - Если явно задан --role worker или SERVER_IP совпадает с одним из воркеров (без --all):
#   разворачиваем только этот воркер.
# - Если явно задан --role primary или --primary-only:
#   разворачиваем только основной узел SERVER_IP.
# - Если режим auto (по умолчанию) или --all, и в cluster-nodes.json есть воркеры:
#   сначала поочерёдно разворачиваем все воркеры (Worker-first), затем основной узел Primary!

matched_worker_line=""
if ((${#WORKER_LINES[@]})); then
	for wline in "${WORKER_LINES[@]}"; do
		[[ -z $wline ]] && continue
		wip="${wline%%|*}"
		if [[ $wip == "$SERVER_IP" ]]; then
			matched_worker_line="$wline"
			break
		fi
	done
fi

if [[ $ROLE == "worker" ]] || { [[ $ROLE == "auto" ]] && (( ! DEPLOY_ALL )) && [[ -n $matched_worker_line ]]; }; then
	if [[ -n $matched_worker_line ]]; then
		IFS='|' read -r w_ip w_name _w_weight w_user w_user_env w_key w_key_env w_port <<<"$matched_worker_line"
		eff_user=$(resolve_worker_user "$w_user" "$w_user_env")
		eff_key=$(resolve_worker_key "$w_key" "$w_key_env" "worker $w_name ($w_ip)")
		eff_port=$(resolve_worker_port "$w_port")
		deploy_node "$w_ip" "$eff_user" "$eff_key" "$eff_port" "worker" "$w_name"
	else
		deploy_node "$SERVER_IP" "$SSH_USER" "$SSH_KEY" "$SSH_PORT" "worker" "worker-$SERVER_IP"
	fi
elif [[ $ROLE == "primary" ]] || (( PRIMARY_ONLY )) || (( ${#WORKER_LINES[@]} == 0 )); then
	deploy_node "$SERVER_IP" "$SSH_USER" "$SSH_KEY" "$SSH_PORT" "primary" "primary"
else
	step "Кластерное развёртывание: воркеров=${#WORKER_LINES[@]}, основной узел=$SERVER_IP"
	for wline in "${WORKER_LINES[@]}"; do
		[[ -z $wline ]] && continue
		IFS='|' read -r w_ip w_name _w_weight w_user w_user_env w_key w_key_env w_port <<<"$wline"
		validate_ipv4 "$w_ip"
		eff_user=$(resolve_worker_user "$w_user" "$w_user_env")
		eff_key=$(resolve_worker_key "$w_key" "$w_key_env" "worker $w_name ($w_ip)")
		eff_port=$(resolve_worker_port "$w_port")
		deploy_node "$w_ip" "$eff_user" "$eff_key" "$eff_port" "worker" "$w_name"
	done
	deploy_node "$SERVER_IP" "$SSH_USER" "$SSH_KEY" "$SSH_PORT" "primary" "primary"
fi

if (( ! DRY_RUN )); then
	step "Готово"
	info "кластер обновлён ($n_dnsmasq доменов)"
	info "логи: journalctl -u dnsmasq -f  |  journalctl -u pereval-healthcheck -f  |  tail -f /var/log/nginx/sni.log"
fi
