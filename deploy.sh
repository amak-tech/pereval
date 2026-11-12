#!/usr/bin/env bash
#
# Раскладывает сгенерированные конфиги на сервер (или весь кластер воркеров + основной узел),
# автоматически доустанавливает недостающие пакеты и перезапускает сервисы.
#
#   ./deploy.sh <ip-сервера> <путь-к-ssh-ключу> [пользователь] [опции]
#
# Роли узлов: primary / worker (Free-кластер), pro-dns / pro-worker (Перевал Pro).
# Сайт, кабинет и API (pereval.top) разворачиваются отдельно — web/compose.yaml.
#
# Что делает:
#   1. проверяет, что локальные файлы существуют, свежие и без незакрытых {{...}}
#   2. определяет список целевых узлов (воркеры из cluster-nodes.json -> основной узел)
#      и разрешает SSH-реквизиты каждого воркера (по умолчанию наследует от основного узла,
#      либо берёт из ssh_user_env / ssh_key_env / ssh_user / ssh_key / ssh_port)
#   3. автоматически устанавливает недостающие пакеты (tar, nginx, libnginx-mod-stream,
#      dnsmasq, python3, openssl, dnsutils, iproute2, ca-certificates, bmon) и освобождает
#      порт 53 от systemd-resolved stub listener при необходимости
#   4. заливает файлы в staging-каталог на сервере, проверяет синтаксис ДО замены
#   5. делает резервные копии, устанавливает, перезапускает сервисы, при ошибке откатывает
#
# dnsmasq именно перезапускается: по SIGHUP он перечитывает /etc/hosts и чистит
# кэш, но не конфиг, так что reload не подхватил бы новые address=.
# nginx наоборот перезагружается через reload — restart рвёт все текущие
# соединения, включая длинные SSE-потоки Claude и ChatGPT.

set -euo pipefail

BUILD_DIR="${BUILD_DIR:-build}"
SRC_DIR="${SRC_DIR:-src}"

# --- манифесты файлов по ролям --------------------------------------------
# Общие Python-модули (ставятся в /usr/local/lib/pereval на всех узлах)
LIB_FILES=("$SRC_DIR/poolrouting.py" "$SRC_DIR/dnscommon.py")
# Free-кластер (primary / worker)
FREE_FILES=(
	"$BUILD_DIR/dnsmasq-geoblock.conf"
	"$BUILD_DIR/nginx.conf"
	"$BUILD_DIR/nginx-sni-allow.map"
	"$BUILD_DIR/nginx-host-allow.map"
	"$BUILD_DIR/nginx-workers-stream.conf"
	"$BUILD_DIR/nginx-workers-http.conf"
	"$BUILD_DIR/service-map.json"
	"$BUILD_DIR/cluster-nodes.json"
	"$BUILD_DIR/free-policy-map.json"
	"$SRC_DIR/stats_collector.py"
	"$SRC_DIR/pro_dns.py"
	"$SRC_DIR/doh_proxy.py"
	"$SRC_DIR/healthcheck.py"
	"$SRC_DIR/cert_sync.py"
)
# Pro DNS-нода
PRO_DNS_FILES=(
	"$BUILD_DIR/pro-dns-nginx.conf"
	"$BUILD_DIR/cache-dnsmasq.conf"
	"$BUILD_DIR/pro-policy-map.json"
	"$BUILD_DIR/pro-nodes.json"
	"$SRC_DIR/pro_dns.py"
	"$SRC_DIR/healthcheck.py"
	"$SRC_DIR/cert_sync.py"
)
# Pro прокси-воркер
PRO_WORKER_FILES=(
	"$BUILD_DIR/pro-worker-nginx.conf"
	"$BUILD_DIR/pro-nginx-sni-allow.map"
	"$BUILD_DIR/pro-nginx-host-allow.map"
	"$BUILD_DIR/pro-service-map.json"
	"$BUILD_DIR/pro-nodes.json"
	"$SRC_DIR/pro_node_agent.py"
	"$SRC_DIR/stats_collector.py"
)
DNSMASQ_CONF="$BUILD_DIR/dnsmasq-geoblock.conf"
CLUSTER_NODES="$BUILD_DIR/cluster-nodes.json"
PRO_NODES="$BUILD_DIR/pro-nodes.json"
SOURCE_YAML="services.yaml"

SSH_PORT=22
DRY_RUN=0
FORCE=0
ROLE="auto"          # auto | primary | worker | pro-dns | pro-worker
DEPLOY_ALL=0         # 1 = принудительно развернуть воркеры + primary
PRIMARY_ONLY=0       # 1 = развернуть только указанный узел без обхода воркеров
DEPLOY_PRO=0         # 1 = развернуть Pro: DNS-ноду, затем Pro-воркеры (из pro-nodes.json)

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
  -r, --role РОЛЬ          роль узла: auto (по умолчанию), primary, worker, pro-dns или pro-worker
  -a, --all                развернуть на все Free-воркеры из cluster-nodes.json, затем на primary
      --primary-only       развернуть только на основной узел (пропустить пул воркеров)
      --pro                развернуть Pro: DNS-ноду (pro.dns_ip), затем Pro-воркеры из pro-nodes.json
                           (ip-сервера при этом игнорируется; SSH-реквизиты наследуются)
  -n, --dry-run            показать план развёртывания без подключения и изменений
  -f, --force              не останавливаться на предупреждениях
  -h, --help               эта справка

Примеры:
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 ubuntu --all
  ./deploy.sh 153.80.200.171 ~/.ssh/id_ed25519 root --role worker
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 root --pro
  ./deploy.sh 203.0.113.10 ~/.ssh/id_ed25519 root --role pro-dns
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 ubuntu --port 2222 --dry-run

Секреты нод (см. web: pnpm admin node add): FREE_PRIMARY_SECRET (Free primary: забирает единый TLS-сертификат
с control plane), PRO_DNS_SECRET, и по одному на Pro-воркер — в переменных окружения, попадут в /etc/pereval/node.env.
Секрет Pro-воркера берётся из переменной secret_env воркера в services.yaml (по умолчанию <NAME>_SECRET,
например PRO_WORKER_AI_1_SECRET), а если она пуста — из общего PRO_WORKER_SECRET.
CP_ORIGIN по умолчанию = site_origin из services.yaml.
TLS: один wildcard-сертификат (cert_domains в cluster-nodes.json) выпускается на control plane
(web/deploy/issue-cert.sh) и раздаётся нодам скриптом cert_sync.py по systemd-таймеру; certbot на нодах не нужен.
Сайт, кабинет и API (pereval.top) разворачиваются отдельно: web/compose.yaml + .github/workflows/web.yml.
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
		--pro)             DEPLOY_PRO=1; shift ;;
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
[[ $ROLE == "auto" || $ROLE == "primary" || $ROLE == "worker" || $ROLE == "pro-dns" || $ROLE == "pro-worker" ]] \
	|| die "некорректная роль --role: $ROLE (ожидается auto, primary, worker, pro-dns или pro-worker)"

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

# Какие роли будем разворачивать в этом запуске
NEED_FREE=1; NEED_PRO=0
if [[ $ROLE == "pro-dns" || $ROLE == "pro-worker" ]]; then NEED_FREE=0; NEED_PRO=1; fi
if ((DEPLOY_PRO)); then NEED_FREE=0; NEED_PRO=1; fi

LOCAL_FILES=("${LIB_FILES[@]}")
((NEED_FREE)) && LOCAL_FILES+=("${FREE_FILES[@]}")
((NEED_PRO)) && LOCAL_FILES+=("${PRO_DNS_FILES[@]}" "${PRO_WORKER_FILES[@]}")
# убираем дубли, сохраняя порядок
_uniq=()
for f in "${LOCAL_FILES[@]}"; do
	skip=0
	for u in ${_uniq[@]+"${_uniq[@]}"}; do [[ $u == "$f" ]] && { skip=1; break; }; done
	((skip)) || _uniq+=("$f")
done
LOCAL_FILES=("${_uniq[@]}")
# опциональные карты пулов со strict_allowlist
for f in "$BUILD_DIR"/nginx-sni-allow.*.map "$BUILD_DIR"/nginx-host-allow.*.map "$BUILD_DIR"/pro-nginx-sni-allow.*.map "$BUILD_DIR"/pro-nginx-host-allow.*.map; do
	[[ -f $f ]] && LOCAL_FILES+=("$f")
done

missing=()
for f in "${LOCAL_FILES[@]}"; do
	[[ -f $f ]] || missing+=("$f")
done
if ((${#missing[@]})); then
	die "не хватает файлов: ${missing[*]}
    соберите их: python3 $SRC_DIR/generate.py $SOURCE_YAML $SERVER_IP"
fi

# несведённые подстановки означают, что генератор падал на середине
for f in "${LOCAL_FILES[@]}"; do
	[[ $f == *.py ]] && continue
	if grep -q '{{[a-z_]*}}' "$f"; then
		die "в $f остались подстановки {{...}} — генератор не доработал"
	fi
done

n_dnsmasq=0
if ((NEED_FREE)); then
	# списки уникальных доменов в dnsmasq и nginx-sni/host-allow.map должны совпадать
	n_dnsmasq=$(awk -F/ '/^address=\//{print $2}' "$DNSMASQ_CONF" | sort -u | wc -l | tr -d ' ')
	for m in "$BUILD_DIR/nginx-sni-allow.map" "$BUILD_DIR/nginx-host-allow.map"; do
		n_map=$(grep -c '^\.' "$m" || true)
		((n_dnsmasq == n_map)) || die "в $DNSMASQ_CONF $n_dnsmasq уникальных доменов, а в $m — $n_map
    пересоберите оба файла одним запуском $SRC_DIR/generate.py"
	done
	info "$n_dnsmasq доменов, списки dnsmasq и nginx совпадают"
fi
if ((NEED_PRO)); then
	n_pro=$(grep -c '^\.' "$BUILD_DIR/pro-nginx-sni-allow.map" || true)
	n_pro_host=$(grep -c '^\.' "$BUILD_DIR/pro-nginx-host-allow.map" || true)
	((n_pro == n_pro_host)) || die "pro-nginx-sni-allow.map ($n_pro) и pro-nginx-host-allow.map ($n_pro_host) расходятся"
	info "Pro: $n_pro доменов в allow-картах"
fi

# Разбираем cluster-nodes.json и pro-nodes.json через python3
CLUSTER_META=$(python3 - "$CLUSTER_NODES" "$PRO_NODES" <<'PYMETA'
import json, sys
from pathlib import Path
def load(p):
    p = Path(p)
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}
data = load(sys.argv[1])
pro = load(sys.argv[2])
print(f"PRIMARY={data.get('primary') or ''}")
print(f"DOMAIN={data.get('domain') or ''}")
print("FREE_DOMAINS=" + " ".join(data.get("free_domains") or ([data["domain"]] if data.get("domain") else [])))
print(f"SITE_ORIGIN={data.get('site_origin') or ''}")
print("CERT_DOMAINS=" + " ".join(data.get("cert_domains") or pro.get("cert_domains") or []))
def worker_lines(prefix, workers):
    for idx, w in enumerate(workers or [], 1):
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
            ",".join(w.get("pools") or ["default"]),
            w.get("secret_env") or "",
        ]
        print(prefix + "|".join(fields))
worker_lines("WORKER=", data.get("workers"))
print(f"PRO_DOMAIN={pro.get('domain') or ''}")
print(f"PRO_DNS_IP={pro.get('dns_ip') or ''}")
print(f"PRO_CP_IP={pro.get('cp_ip') or ''}")
worker_lines("PRO_WORKER=", pro.get("workers"))
PYMETA
)

CLUSTER_PRIMARY=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^PRIMARY=//p' | head -1)
DOMAIN=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^DOMAIN=//p' | head -1)
FREE_DOMAINS=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^FREE_DOMAINS=//p' | head -1)
SITE_ORIGIN=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^SITE_ORIGIN=//p' | head -1)
CERT_DOMAINS=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^CERT_DOMAINS=//p' | head -1)
PRO_DOMAIN=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^PRO_DOMAIN=//p' | head -1)
PRO_DNS_IP=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^PRO_DNS_IP=//p' | head -1)
PRO_CP_IP=$(printf '%s\n' "$CLUSTER_META" | sed -n 's/^PRO_CP_IP=//p' | head -1)
CP_ORIGIN="${CP_ORIGIN:-$SITE_ORIGIN}"
[[ -n $DOMAIN ]] || die "не удалось определить домен из $CLUSTER_NODES"
info "DNS-домены Free: $FREE_DOMAINS; сайт: $SITE_ORIGIN"
WORKER_LINES=()
while IFS= read -r line; do
	[[ -n $line ]] && WORKER_LINES+=("$line")
done < <(printf '%s\n' "$CLUSTER_META" | sed -n 's/^WORKER=//p')
PRO_WORKER_LINES=()
while IFS= read -r line; do
	[[ -n $line ]] && PRO_WORKER_LINES+=("$line")
done < <(printf '%s\n' "$CLUSTER_META" | sed -n 's/^PRO_WORKER=//p')
if ((NEED_PRO)); then
	[[ -n $PRO_DOMAIN && -n $PRO_DNS_IP ]] || die "в $PRO_NODES нет domain/dns_ip — заполните секцию pro в $SOURCE_YAML"
	info "Pro: домен $PRO_DOMAIN, DNS-нода $PRO_DNS_IP, воркеров: ${#PRO_WORKER_LINES[@]}"
fi

# Проверяем соответствие IP в собранных конфигах (для primary / auto)
if ((NEED_FREE)) && [[ $ROLE != "worker" ]]; then
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
    пересоберите: python3 $SRC_DIR/generate.py $SOURCE_YAML $SERVER_IP"
	fi
fi

if [[ -f $SOURCE_YAML ]]; then
	for f in "${LOCAL_FILES[@]}"; do
		[[ $f == *.py ]] && continue
		if [[ $SOURCE_YAML -nt $f ]]; then
			warn "$SOURCE_YAML новее, чем $f — возможно, забыли пересобрать"
			((FORCE)) || die "перезапустите $SRC_DIR/generate.py или добавьте --force"
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

# Какая env-переменная хранит секрет Pro-воркера: secret_env из services.yaml, иначе общий PRO_WORKER_SECRET.
# Печатает имя переменной (пусто, если секрета нет ни в одной).
resolve_pro_worker_secret_var() {
	local secret_env="$1"
	if [[ -n $secret_env && -n ${!secret_env:-} ]]; then
		printf '%s' "$secret_env"
	elif [[ -n ${PRO_WORKER_SECRET:-} ]]; then
		printf '%s' "PRO_WORKER_SECRET"
	fi
}

# Готовит $LOCAL_STAGE/node.pro-worker.env для конкретного воркера (вызывается перед каждым deploy_node pro-worker).
# Без секрета файл удаляется: на ноде останется прежний /etc/pereval/node.env.
stage_pro_worker_env() {
	local w_name="$1" secret_env="$2"
	local var
	var=$(resolve_pro_worker_secret_var "$secret_env")
	rm -f "$LOCAL_STAGE/node.pro-worker.env"
	if [[ -z $var ]]; then
		[[ -n $w_name ]] && warn "pro-worker $w_name: нет секрета ни в ${secret_env:-secret_env}, ни в PRO_WORKER_SECRET — node.env на ноде не обновляется"
		return 0
	fi
	cat >"$LOCAL_STAGE/node.pro-worker.env" <<EOF
CP_ORIGIN=$CP_ORIGIN
NODE_SECRET=${!var}
TRUSTED_IPS=$PRO_DNS_IP,$PRO_CP_IP,$CLUSTER_PRIMARY
EOF
	chmod 600 "$LOCAL_STAGE/node.pro-worker.env"
	if [[ -n $w_name ]]; then
		if [[ $var == PRO_WORKER_SECRET && -n $secret_env ]]; then
			warn "pro-worker $w_name: переменная $secret_env не задана — используется общий PRO_WORKER_SECRET (в CP нода будет видна как общая)"
		else
			info "pro-worker $w_name: node.env из $var"
		fi
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

	# секреты нод (из GitHub Secrets / окружения) — попадут в /etc/pereval/node.env
	if [[ -n ${FREE_PRIMARY_SECRET:-} ]]; then
		cat >"$LOCAL_STAGE/node.primary.env" <<EOF
CP_ORIGIN=$CP_ORIGIN
NODE_SECRET=$FREE_PRIMARY_SECRET
EOF
		chmod 600 "$LOCAL_STAGE/node.primary.env"
		info "подготовлен node.env для Free primary (cert_sync)"
	fi
	if [[ -n ${PRO_DNS_SECRET:-} ]]; then
		cat >"$LOCAL_STAGE/node.pro-dns.env" <<EOF
CP_ORIGIN=$CP_ORIGIN
NODE_SECRET=$PRO_DNS_SECRET
PRO_DNS_IP=$PRO_DNS_IP
PRO_DOMAIN=$PRO_DOMAIN
EOF
		chmod 600 "$LOCAL_STAGE/node.pro-dns.env"
		info "подготовлен node.env для pro-dns"
	fi
	stage_pro_worker_env "" ""

	cat >"$LOCAL_STAGE/apply.sh" <<'REMOTE'
#!/usr/bin/env bash
set -euo pipefail

STAGE="$1"; STAMP="$2"; SERVER_IP="$3"; DOMAIN="$4"; NODE_ROLE="${5:-primary}"; FREE_DOMAINS="${6:-$4}"; CP_ORIGIN="${7:-}"; CERT_DOMAINS="${8:-}"
BACKUP="/var/backups/geoblock/$STAMP"
LIB_DIR="/usr/local/lib/pereval"
ETC_DIR="/etc/pereval"
NODE_ENV_DST="/etc/pereval/node.env"
CERT_SYNC_DST="/usr/local/bin/pereval-cert-sync.py"
CERT_SYNC_UNIT="/etc/systemd/system/pereval-cert-sync.service"
CERT_SYNC_TIMER="/etc/systemd/system/pereval-cert-sync.timer"
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
LEADS_UNIT_DST="/etc/systemd/system/pereval-leads.service"   # устаревший сервис заявок — удаляется
LEADS_DST="/usr/local/bin/pereval-leads.py"

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

mkdir -p "$BACKUP" "$MAP_DIR" "$SSL_DIR" "$WEB_DIR/.well-known/acme-challenge" "$STATS_STATE_DIR" "$HC_STATE_DIR" "$LIB_DIR" /etc/sysctl.d

# --- всё ли доехало -------------------------------------------------------
for f in dnsmasq-geoblock.conf nginx.conf nginx-sni-allow.map nginx-host-allow.map nginx-workers-stream.conf nginx-workers-http.conf service-map.json cluster-nodes.json free-policy-map.json stats_collector.py pro_dns.py doh_proxy.py healthcheck.py poolrouting.py dnscommon.py cert_sync.py; do
	[[ -s "$STAGE/$f" ]] || fail "файл $f не доехал или пустой — передача оборвалась"
done
say "файлы получены (роль узла: $NODE_ROLE)"

# Для воркера формируем прямые nginx-workers-*.conf,
# чтобы воркер всегда выходил напрямую в интернет со своего IP без петель.
if [[ $NODE_ROLE == "worker" ]]; then
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
	cp -a "$STAGE/nginx-workers-stream.conf" "$STAGE/nginx-workers-stream.node.conf"
	cp -a "$STAGE/nginx-workers-http.conf" "$STAGE/nginx-workers-http.node.conf"
fi

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
backup_one "$LIB_DIR/poolrouting.py"               poolrouting.py
backup_one "$LIB_DIR/dnscommon.py"                 dnscommon.py
backup_one "$SYSCTL_DST"                           99-geoblock-highload.conf
say "резервные копии: $BACKUP"

restore() {
	printf 'откатываю изменения\n' >&2
	for name in dnsmasq.conf dnsmasq-base.conf nginx.conf nginx-sni-allow.map nginx-host-allow.map nginx-workers-stream.conf nginx-workers-http.conf service-map.json cluster-nodes.json pereval-stats-collector.py pereval-stats.service pereval-doh-proxy.py pereval-doh.service pereval-healthcheck.py pereval-healthcheck.service poolrouting.py dnscommon.py 99-geoblock-highload.conf; do
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
				poolrouting.py|dnscommon.py)                                                                                     cp -a "$BACKUP/$name" "$LIB_DIR/$name" ;;
				*)                                                                                                               cp -a "$BACKUP/$name" "$MAP_DIR/$name" ;;
			esac
		fi
	done
	systemctl daemon-reload 2>/dev/null || true
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

# --- TLS-сертификат: боевой приезжает с control plane (cert_sync, ниже). Пока его нет —
#     старый lineage Let's Encrypt этой ноды (если остался) или временный самоподписанный.
LE_LIVE="/etc/letsencrypt/live/$DOMAIN"
if [[ ! -f "$SSL_DIR/fullchain.pem" || ! -f "$SSL_DIR/privkey.pem" ]]; then
	if [[ -f "$LE_LIVE/fullchain.pem" && -f "$LE_LIVE/privkey.pem" ]]; then
		ln -sfn "$LE_LIVE/fullchain.pem" "$SSL_DIR/fullchain.pem"
		ln -sfn "$LE_LIVE/privkey.pem"   "$SSL_DIR/privkey.pem"
		say "временно использую сертификат из $LE_LIVE"
	else
		SAN="DNS:$DOMAIN"
		for d in $FREE_DOMAINS; do [[ $d == "$DOMAIN" ]] || SAN="$SAN,DNS:$d"; done
		openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
			-subj "/CN=$DOMAIN" -addext "subjectAltName=$SAN" \
			-keyout "$SSL_DIR/privkey.pem" \
			-out "$SSL_DIR/fullchain.pem" >/dev/null 2>&1
		chmod 600 "$SSL_DIR/privkey.pem"
		say "создан временный самоподписанный сертификат для $FREE_DOMAINS"
	fi
fi

# --- общие Python-модули (poolrouting, dnscommon, healthcheck) -------------
install -m 0644 "$STAGE/poolrouting.py" "$LIB_DIR/poolrouting.py"
install -m 0644 "$STAGE/dnscommon.py"   "$LIB_DIR/dnscommon.py"
install -m 0644 "$STAGE/healthcheck.py" "$LIB_DIR/healthcheck.py"

# --- статика сайта переехала на $SITE_ORIGIN: чистим старые страницы ---------
for old in index.html pro.html dedicated.html stats.html terms.html privacy.html dns.mobileconfig favicon.svg favicon.ico apple-touch-icon.png og-image.svg og-image.png robots.txt sitemap.xml; do
	if [[ -f "$WEB_DIR/$old" ]]; then
		cp -a "$WEB_DIR/$old" "$BACKUP/$old" 2>/dev/null || true
		rm -f "$WEB_DIR/$old"
	fi
done

# --- nginx: сначала установить, потом проверить, при провале откатить ------
install -m 0644 "$STAGE/nginx-sni-allow.map"             "$MAP_DIR/nginx-sni-allow.map"
install -m 0644 "$STAGE/nginx-host-allow.map"            "$MAP_DIR/nginx-host-allow.map"
install -m 0644 "$STAGE/nginx-workers-stream.node.conf"  "$MAP_DIR/nginx-workers-stream.conf"
install -m 0644 "$STAGE/nginx-workers-http.node.conf"    "$MAP_DIR/nginx-workers-http.conf"
for pm in "$STAGE"/nginx-sni-allow.*.map "$STAGE"/nginx-host-allow.*.map; do
	[[ -f $pm ]] && install -m 0644 "$pm" "$MAP_DIR/$(basename "$pm")"
done
install -m 0644 "$STAGE/service-map.json"                "$MAP_DIR/service-map.json"
install -m 0644 "$STAGE/cluster-nodes.json"              "$MAP_DIR/cluster-nodes.json"
install -m 0644 "$STAGE/free-policy-map.json"            "$MAP_DIR/free-policy-map.json"
install -m 0644 "$STAGE/dnsmasq-geoblock.conf"           "$DNSMASQ_BASE_DST"
install -m 0644 "$STAGE/nginx.conf"                      "$NGINX_DST"

# --- отключение системного dnsmasq (заменён единым pro_dns.py) -------------
# Сначала останавливаем старый pereval-healthcheck, чтобы он до своего обновления
# не перезапустил dnsmasq по таймеру при изменении cluster-nodes.json.
if systemctl list-unit-files pereval-healthcheck.service >/dev/null 2>&1; then
	systemctl stop pereval-healthcheck.service >/dev/null 2>&1 || true
fi
if systemctl list-unit-files dnsmasq.service >/dev/null 2>&1; then
	systemctl disable --now dnsmasq.service >/dev/null 2>&1 || true
fi
pkill -9 -x dnsmasq >/dev/null 2>&1 || true
if ! grep -qE '^nameserver\s+[0-9]+' /etc/resolv.conf 2>/dev/null || grep -qE '^nameserver\s+127\.' /etc/resolv.conf 2>/dev/null; then
	rm -f /etc/resolv.conf
	printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >/etc/resolv.conf
fi

# --- единый DNS-сервер (pro_dns.py --tier free на Primary) -----------------
install -m 0755 "$STAGE/pro_dns.py"           "$DOH_DST"
if [[ $NODE_ROLE == "primary" ]]; then
	cat >"$DOH_UNIT_DST" <<UNIT
[Unit]
Description=Pereval Free unified DNS (DoH/DoT/Do53) daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $DOH_DST --tier free --no-cp --listen-ip $SERVER_IP --pro-domain $DOMAIN --policy-map $MAP_DIR/free-policy-map.json --cert $SSL_DIR/fullchain.pem --key $SSL_DIR/privkey.pem --doh-listen 127.0.0.1:8053 --upstream 1.1.1.1:53,8.8.8.8:53 --health-out $WEB_DIR/cluster-health.json
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=2
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
	chmod 0644 "$DOH_UNIT_DST"
else
	if systemctl list-unit-files pereval-doh.service >/dev/null 2>&1; then
		systemctl disable --now pereval-doh.service >/dev/null 2>&1 || true
	fi
fi

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

# --- демон мониторинга воркеров и failover nginx (pereval-healthcheck.service)
install -m 0755 "$STAGE/healthcheck.py"       "$HC_DST"
if [[ $NODE_ROLE == "primary" ]]; then
	cat >"$HC_UNIT_DST" <<UNIT
[Unit]
Description=Pereval active worker healthcheck and nginx failover daemon
After=network.target nginx.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 $HC_DST --cluster-config $MAP_DIR/cluster-nodes.json --nginx-stream-out $MAP_DIR/nginx-workers-stream.conf --nginx-http-out $MAP_DIR/nginx-workers-http.conf --service-map $MAP_DIR/service-map.json --status-out $WEB_DIR/cluster-health.json --state-file $HC_STATE_DIR/state.json --interval 5 --fail-threshold 2 --rise-threshold 2
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
	chmod 0644 "$HC_UNIT_DST"
fi

# --- устаревший сервис заявок (pereval-leads) — переехал на сайт -----------
if systemctl list-unit-files pereval-leads.service >/dev/null 2>&1 || [[ -f $LEADS_UNIT_DST ]]; then
	systemctl disable --now pereval-leads.service >/dev/null 2>&1 || true
	rm -f "$LEADS_UNIT_DST" "$LEADS_DST"
	say "pereval-leads.service удалён (заявки принимает сайт)"
fi

# На основном узле сразу выполняем одиночный цикл healthcheck (без рестарта сервисов),
# чтобы nginx-workers-*.conf и cluster-health.json отражали реальную доступность воркеров.
if [[ $NODE_ROLE == "primary" ]]; then
	/usr/bin/python3 "$HC_DST" \
		--cluster-config "$MAP_DIR/cluster-nodes.json" \
		--nginx-stream-out "$MAP_DIR/nginx-workers-stream.conf" \
		--nginx-http-out "$MAP_DIR/nginx-workers-http.conf" \
		--service-map "$MAP_DIR/service-map.json" \
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
if systemctl is-active --quiet nginx; then
	if [[ $NODE_ROLE == "primary" ]] && ss -tlnp "sport = :853" 2>/dev/null | grep -q nginx; then
		if ! systemctl restart nginx; then
			journalctl -u nginx -n 20 --no-pager >&2 || true
			restore
			fail "nginx не перезапустился для освобождения порта :853"
		fi
		say "nginx перезапущен (освобождён порт :853 для pro_dns)"
	elif ! systemctl reload nginx; then
		journalctl -u nginx -n 20 --no-pager >&2 || true
		restore
		fail "nginx не перезагрузился"
	else
		say "nginx перезагружен"
	fi
else
	if ! systemctl restart nginx; then
		journalctl -u nginx -n 20 --no-pager >&2 || true
		restore
		fail "nginx не поднялся"
	fi
	say "nginx запущен"
fi

systemctl daemon-reload
if [[ $NODE_ROLE == "primary" ]]; then
	systemctl disable --now dnsmasq.service >/dev/null 2>&1 || true
	pkill -9 -x dnsmasq >/dev/null 2>&1 || true
	systemctl enable pereval-doh.service >/dev/null 2>&1 || true
	if ! systemctl restart pereval-doh.service; then
		journalctl -u pereval-doh.service -n 20 --no-pager >&2 || true
		restore
		fail "pereval-doh.service не поднялся"
	fi
	say "единый DNS-сервер pereval-doh (pro_dns --tier free) перезапущен"
fi

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

# --- единый TLS-сертификат с control plane (только на Primary) ---------------
# Один wildcard на всю инфраструктуру выпускается на pereval.top и раздаётся
# через /api/internal/v1/node/cert. Secret ноды — FREE_PRIMARY_SECRET → node.env.
if [[ $NODE_ROLE != "primary" ]]; then
	say "узел с ролью worker — TLS не терминирует, сертификат не нужен"
else
	# certbot этой ноды больше не нужен: его lineage заменяет единый сертификат
	if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
		systemctl disable --now certbot.timer >/dev/null 2>&1 || true
	fi
	rm -f /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

	mkdir -p "$ETC_DIR"; chmod 0750 "$ETC_DIR"
	if [[ -f "$STAGE/node.env" ]]; then
		install -m 0640 "$STAGE/node.env" "$NODE_ENV_DST"
		say "обновлён $NODE_ENV_DST"
	elif [[ ! -f "$NODE_ENV_DST" ]]; then
		cat >"$NODE_ENV_DST" <<ENVEOF
CP_ORIGIN=${CP_ORIGIN:-https://pereval.top}
NODE_SECRET=
ENVEOF
		chmod 0640 "$NODE_ENV_DST"
		say "создан шаблон $NODE_ENV_DST — впишите NODE_SECRET (web: pnpm admin node add primary free_primary $SERVER_IP)"
	fi

	install -m 0755 "$STAGE/cert_sync.py" "$CERT_SYNC_DST"
	EXPECT_ARGS=""
	for d in $FREE_DOMAINS; do EXPECT_ARGS="$EXPECT_ARGS --expect $d"; done
	cat >"$CERT_SYNC_UNIT" <<UNIT
[Unit]
Description=Pereval: fetch the shared TLS certificate from control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$NODE_ENV_DST
ExecStart=/usr/bin/python3 $CERT_SYNC_DST --out-dir $SSL_DIR --key-mode 0600$EXPECT_ARGS --reload 'nginx -t && systemctl reload nginx' --reload 'systemctl kill -s HUP pereval-doh.service || true'
UNIT
	cat >"$CERT_SYNC_TIMER" <<UNIT
[Unit]
Description=Pereval: hourly TLS certificate sync with control plane

[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
RandomizedDelaySec=10min
Unit=pereval-cert-sync.service

[Install]
WantedBy=timers.target
UNIT
	systemctl daemon-reload
	systemctl enable --now pereval-cert-sync.timer >/dev/null 2>&1 || true
	if grep -qE '^NODE_SECRET=.+' "$NODE_ENV_DST"; then
		if systemctl start pereval-cert-sync.service; then
			say "сертификат синхронизирован с control plane ($(python3 -c "import json;print(json.load(open('$SSL_DIR/.cert-sync.json'))['not_after'])" 2>/dev/null || echo 'без изменений'))"
		else
			say "ВНИМАНИЕ: cert_sync не смог получить сертификат (journalctl -u pereval-cert-sync); работает текущий"
		fi
	else
		say "ВНИМАНИЕ: NODE_SECRET пуст — боевой сертификат не получен. Выпустите единый сертификат на CP (web/deploy/issue-cert.sh) и задайте FREE_PRIMARY_SECRET"
	fi
fi

# --- проверка результата --------------------------------------------------
sleep 1
EXPECTED_UNITS=(nginx pereval-stats)
if [[ $NODE_ROLE == "primary" ]]; then
	EXPECTED_UNITS+=(pereval-doh pereval-healthcheck)
fi
for unit in "${EXPECTED_UNITS[@]}"; do
	systemctl is-active --quiet "$unit" || { restore; fail "$unit не активен после перезапуска"; }
done

if [[ $NODE_ROLE == "primary" ]]; then
	got=""
	if command -v dig >/dev/null 2>&1; then
		got=$(dig +short +time=3 +tries=1 @"$SERVER_IP" claude.ai 2>/dev/null | head -1)
	elif command -v kdig >/dev/null 2>&1; then
		got=$(kdig +short @"$SERVER_IP" claude.ai 2>/dev/null | head -1)
	fi
	if [[ -z $got ]]; then
		say "проверить подмену нечем — поставьте dnsutils: apt install -y dnsutils"
	else
		say "проверка: claude.ai -> $got, подмена работает"
	fi
	CHECK_PORTS=(53 80 443 853 8053)
else
	CHECK_PORTS=(80 443)
fi
for port in "${CHECK_PORTS[@]}"; do
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

	cat >"$LOCAL_STAGE/apply-pro.sh" <<'REMOTEPRO'
#!/usr/bin/env bash
# Установка Pro-ноды: pro-dns (DNS-нода Перевал Pro) или pro-worker (прокси-воркер с nftables-ACL).
set -euo pipefail

STAGE="$1"; STAMP="$2"; SERVER_IP="$3"; PRO_DOMAIN="$4"; NODE_ROLE="$5"; PRO_DNS_IP="$6"; TRUSTED_IPS="${7:-}"; CP_ORIGIN="${8:-}"
BACKUP="/var/backups/pereval-pro/$STAMP"
LIB_DIR="/usr/local/lib/pereval"
ETC_DIR="/etc/pereval"
SSL_DIR="/etc/pereval/ssl"
NODE_ENV_DST="/etc/pereval/node.env"
MAP_DIR="/etc/nginx/geoblock"
NGINX_DST="/etc/nginx/nginx.conf"
WEB_DIR="/var/www/pereval-pro"
GEO_WEB_DIR="/var/www/geoblock"
SYSCTL_DST="/etc/sysctl.d/99-geoblock-highload.conf"
PRO_DNS_DST="/usr/local/bin/pereval-pro-dns.py"
PRO_DNS_UNIT="/etc/systemd/system/pereval-pro-dns.service"
PRO_DNS_STATE="/var/lib/pereval-pro-dns"
AGENT_DST="/usr/local/bin/pereval-pro-agent.py"
AGENT_UNIT="/etc/systemd/system/pereval-pro-agent.service"
COLLECTOR_DST="/usr/local/bin/pereval-stats-collector.py"
STATS_UNIT_DST="/etc/systemd/system/pereval-stats.service"
STATS_STATE_DIR="/var/lib/pereval-stats"
CERT_SYNC_DST="/usr/local/bin/pereval-cert-sync.py"
CERT_SYNC_UNIT="/etc/systemd/system/pereval-cert-sync.service"
CERT_SYNC_TIMER="/etc/systemd/system/pereval-cert-sync.timer"

say()  { printf '    %s\n' "$*"; }
fail() { printf 'ошибка на сервере (%s): %s\n' "$SERVER_IP" "$*" >&2; exit 1; }

mkdir -p "$BACKUP" "$ETC_DIR" "$SSL_DIR" "$LIB_DIR" "$MAP_DIR" "$WEB_DIR/.well-known/acme-challenge" "$GEO_WEB_DIR" "$STATS_STATE_DIR" /etc/sysctl.d
chmod 0750 "$ETC_DIR"

backup_one() { [[ -f $1 ]] && cp -a "$1" "$BACKUP/$2" || true; }
backup_one "$NGINX_DST" nginx.conf
backup_one /etc/dnsmasq.conf dnsmasq.conf
backup_one "$NODE_ENV_DST" node.env
backup_one "$MAP_DIR/nginx-sni-allow.map" nginx-sni-allow.map
backup_one "$MAP_DIR/nginx-host-allow.map" nginx-host-allow.map

restore() {
	printf 'откатываю изменения\n' >&2
	[[ -f "$BACKUP/nginx.conf" ]] && cp -a "$BACKUP/nginx.conf" "$NGINX_DST"
	[[ -f "$BACKUP/dnsmasq.conf" ]] && cp -a "$BACKUP/dnsmasq.conf" /etc/dnsmasq.conf
	[[ -f "$BACKUP/nginx-sni-allow.map" ]] && cp -a "$BACKUP/nginx-sni-allow.map" "$MAP_DIR/nginx-sni-allow.map"
	[[ -f "$BACKUP/nginx-host-allow.map" ]] && cp -a "$BACKUP/nginx-host-allow.map" "$MAP_DIR/nginx-host-allow.map"
	systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
}

# --- sysctl (как на Free-узлах) ----------------------------------------------
cat >"$SYSCTL_DST" <<'SYSCTL'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.ip_local_port_range = 10240 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.core.somaxconn = 16384
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 16384
net.netfilter.nf_conntrack_max = 262144
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 3
SYSCTL
sysctl -e -p "$SYSCTL_DST" >/dev/null 2>&1 || true

# --- общие модули ------------------------------------------------------------
install -m 0644 "$STAGE/poolrouting.py" "$LIB_DIR/poolrouting.py"
install -m 0644 "$STAGE/dnscommon.py"   "$LIB_DIR/dnscommon.py"
install -m 0644 "$STAGE/healthcheck.py" "$LIB_DIR/healthcheck.py"

# --- node.env (секрет ноды для control plane) ---------------------------------
if [[ -f "$STAGE/node.env" ]]; then
	install -m 0640 "$STAGE/node.env" "$NODE_ENV_DST"
	say "обновлён $NODE_ENV_DST"
elif [[ ! -f "$NODE_ENV_DST" ]]; then
	cat >"$NODE_ENV_DST" <<ENVEOF
CP_ORIGIN=${CP_ORIGIN:-https://pereval.top}
NODE_SECRET=
PRO_DNS_IP=$PRO_DNS_IP
PRO_DOMAIN=$PRO_DOMAIN
TRUSTED_IPS=$TRUSTED_IPS
ENVEOF
	chmod 0640 "$NODE_ENV_DST"
	say "создан шаблон $NODE_ENV_DST — впишите NODE_SECRET (web: pnpm admin node add ...)"
fi

if [[ $NODE_ROLE == "pro-dns" ]]; then
	for f in pro-dns-nginx.conf cache-dnsmasq.conf pro-policy-map.json pro-nodes.json pro_dns.py cert_sync.py; do
		[[ -s "$STAGE/$f" ]] || fail "файл $f не доехал"
	done
	id -u pereval-dns >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pereval-dns
	mkdir -p "$PRO_DNS_STATE"; chown pereval-dns:pereval-dns "$PRO_DNS_STATE"
	chgrp pereval-dns "$ETC_DIR" "$NODE_ENV_DST" 2>/dev/null || true
	install -m 0644 "$STAGE/pro-policy-map.json" "$ETC_DIR/pro-policy-map.json"
	install -m 0644 "$STAGE/pro-nodes.json"      "$ETC_DIR/pro-nodes.json"
	install -m 0755 "$STAGE/pro_dns.py"          "$PRO_DNS_DST"

	# сертификат: единый wildcard с control plane (cert_sync по таймеру); пока его нет — самоподписанный
	rm -f /etc/letsencrypt/renewal-hooks/deploy/pereval-pro-dns.sh
	systemctl disable --now certbot.timer >/dev/null 2>&1 || true
	if [[ ! -f "$SSL_DIR/fullchain.pem" || ! -f "$SSL_DIR/privkey.pem" ]]; then
		openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=$PRO_DOMAIN" \
			-addext "subjectAltName=DNS:$PRO_DOMAIN,DNS:*.$PRO_DOMAIN" \
			-keyout "$SSL_DIR/privkey.pem" -out "$SSL_DIR/fullchain.pem" >/dev/null 2>&1
		say "создан временный самоподписанный сертификат для $PRO_DOMAIN"
	fi
	chgrp pereval-dns "$SSL_DIR/privkey.pem" "$SSL_DIR/fullchain.pem" 2>/dev/null || true
	chmod 0640 "$SSL_DIR/privkey.pem"; chmod 0644 "$SSL_DIR/fullchain.pem"
	install -m 0755 "$STAGE/cert_sync.py" "$CERT_SYNC_DST"
	cat >"$CERT_SYNC_UNIT" <<UNIT
[Unit]
Description=Pereval: fetch the shared TLS certificate from control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$NODE_ENV_DST
ExecStart=/usr/bin/python3 $CERT_SYNC_DST --out-dir $SSL_DIR --group pereval-dns --key-mode 0640 --expect $PRO_DOMAIN --expect token.$PRO_DOMAIN --reload 'nginx -t && systemctl reload nginx' --reload 'systemctl kill -s HUP pereval-pro-dns.service || true'
UNIT
	cat >"$CERT_SYNC_TIMER" <<UNIT
[Unit]
Description=Pereval: hourly TLS certificate sync with control plane

[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
RandomizedDelaySec=10min
Unit=pereval-cert-sync.service

[Install]
WantedBy=timers.target
UNIT
	systemctl daemon-reload
	systemctl enable --now pereval-cert-sync.timer >/dev/null 2>&1 || true
	# первая синхронизация — до запуска nginx/pro_dns, чтобы DoT/DoH сразу поднялись с боевым сертификатом
	if grep -qE '^NODE_SECRET=.+' "$NODE_ENV_DST"; then
		if python3 "$CERT_SYNC_DST" --out-dir "$SSL_DIR" --group pereval-dns --key-mode 0640 --expect "$PRO_DOMAIN" --expect "token.$PRO_DOMAIN" \
			--cp-origin "$(sed -n 's/^CP_ORIGIN=//p' "$NODE_ENV_DST" | head -1)" --node-secret "$(sed -n 's/^NODE_SECRET=//p' "$NODE_ENV_DST" | head -1)"; then
			say "сертификат синхронизирован с control plane"
		else
			say "ВНИМАНИЕ: cert_sync не смог получить сертификат с control plane — работает текущий"
		fi
	else
		say "ВНИМАНИЕ: NODE_SECRET пуст — боевой сертификат не получен (web/deploy/issue-cert.sh на CP, затем PRO_DNS_SECRET)"
	fi

	# отключение локального dnsmasq (кеширование выполняется внутри pro_dns.py)
	if systemctl list-unit-files dnsmasq.service >/dev/null 2>&1; then
		systemctl disable --now dnsmasq.service >/dev/null 2>&1 || true
	fi
	pkill -9 -x dnsmasq >/dev/null 2>&1 || true
	rm -f /etc/dnsmasq.d/dnsmasq-geoblock.conf
	if ! grep -qE '^nameserver\s+[0-9]+' /etc/resolv.conf 2>/dev/null || grep -qE '^nameserver\s+127\.' /etc/resolv.conf 2>/dev/null; then
		rm -f /etc/resolv.conf
		printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >/etc/resolv.conf
	fi

	# nginx (DoH за TLS)
	install -m 0644 "$STAGE/pro-dns-nginx.conf" "$NGINX_DST"
	nginx -t 2>/tmp/nginx-test.log || { cat /tmp/nginx-test.log >&2; restore; fail "nginx -t не прошёл"; }
	systemctl enable nginx >/dev/null 2>&1 || true
	systemctl reload nginx 2>/dev/null || systemctl restart nginx || { restore; fail "nginx не поднялся"; }

	cat >"$PRO_DNS_UNIT" <<UNIT
[Unit]
Description=Pereval Pro personal DNS (DoH/DoT/Do53) daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pereval-dns
Group=pereval-dns
EnvironmentFile=$NODE_ENV_DST
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ExecStart=/usr/bin/python3 $PRO_DNS_DST --tier pro --listen-ip $PRO_DNS_IP --pro-domain $PRO_DOMAIN --policy-map $ETC_DIR/pro-policy-map.json --policy-cache $PRO_DNS_STATE/policy-cache.json --cert $SSL_DIR/fullchain.pem --key $SSL_DIR/privkey.pem --doh-listen 127.0.0.1:8057 --upstream 1.1.1.1:53,8.8.8.8:53 --health-out $WEB_DIR/pro-health.json
ExecReload=/bin/kill -HUP \$MAINPID
StateDirectory=pereval-pro-dns
ReadWritePaths=$WEB_DIR
Restart=always
RestartSec=2
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
	chown -R pereval-dns:pereval-dns "$WEB_DIR"
	systemctl daemon-reload
	systemctl enable pereval-pro-dns.service >/dev/null 2>&1 || true
	systemctl restart pereval-pro-dns.service || { journalctl -u pereval-pro-dns -n 30 --no-pager >&2 || true; fail "pereval-pro-dns не поднялся"; }
	say "pereval-pro-dns перезапущен"

	sleep 1
	for unit in nginx pereval-pro-dns; do
		systemctl is-active --quiet "$unit" || fail "$unit не активен"
	done
	for port in 53 853 443 8057; do
		if ss -tlnH "sport = :$port" | grep -q .; then say "порт $port слушается"; else say "ВНИМАНИЕ: порт $port не слушается"; fi
	done
	if command -v dig >/dev/null 2>&1; then
		rc=$(dig +time=2 +tries=1 @"$PRO_DNS_IP" claude.ai 2>/dev/null | sed -n 's/.*status: \([A-Z]*\).*/\1/p' | head -1)
		say "проверка: запрос с неизвестного IP -> ${rc:-нет ответа} (ожидается REFUSED)"
	fi

elif [[ $NODE_ROLE == "pro-worker" ]]; then
	for f in pro-worker-nginx.conf pro-nginx-sni-allow.map pro-nginx-host-allow.map pro-service-map.json pro-nodes.json pro_node_agent.py stats_collector.py; do
		[[ -s "$STAGE/$f" ]] || fail "файл $f не доехал"
	done
	install -m 0644 "$STAGE/pro-nginx-sni-allow.map"  "$MAP_DIR/nginx-sni-allow.map"
	install -m 0644 "$STAGE/pro-nginx-host-allow.map" "$MAP_DIR/nginx-host-allow.map"
	for pm in "$STAGE"/pro-nginx-sni-allow.*.map "$STAGE"/pro-nginx-host-allow.*.map; do
		[[ -f $pm ]] && install -m 0644 "$pm" "$MAP_DIR/$(basename "${pm#pro-}")"
	done
	install -m 0644 "$STAGE/pro-service-map.json" "$MAP_DIR/service-map.json"
	# карты доп. доменов (Dedicated) — агент заполняет их сам; пустые нужны для nginx -t
	[[ -f "$MAP_DIR/extra-sni-allow.map" ]]  || : >"$MAP_DIR/extra-sni-allow.map"
	[[ -f "$MAP_DIR/extra-host-allow.map" ]] || : >"$MAP_DIR/extra-host-allow.map"
	# cluster-nodes.json для stats_collector: primary = DNS-нода Pro, воркеры = Pro-воркеры
	python3 - "$STAGE/pro-nodes.json" "$MAP_DIR/cluster-nodes.json" <<'PYC'
import json, sys
pro = json.load(open(sys.argv[1], encoding="utf-8"))
out = {"primary": pro.get("dns_ip"), "domain": pro.get("domain"), "include_primary_in_dns": False,
       "probe_sni": pro.get("probe_sni") or "claude.ai", "pools": pro.get("pools") or {},
       "workers": [{k: w.get(k) for k in ("ip", "name", "weight", "pools")} for w in pro.get("workers") or []]}
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PYC
	install -m 0644 "$STAGE/pro-worker-nginx.conf" "$NGINX_DST"
	nginx -t 2>/tmp/nginx-test.log || { cat /tmp/nginx-test.log >&2; restore; fail "nginx -t не прошёл"; }
	systemctl enable nginx >/dev/null 2>&1 || true
	systemctl reload nginx 2>/dev/null || systemctl restart nginx || { restore; fail "nginx не поднялся"; }

	# nftables: доступ к 80/443 только для подписчиков (набор синхронизирует агент)
	mkdir -p /etc/nftables.d
	NFT_TRUSTED="$(printf '%s' "$TRUSTED_IPS" | tr ',' ' ' | xargs | tr ' ' ',')"
	# правило для доверенных IP собираем заранее: внутри ${VAR:+...} фигурные скобки nft ломают раскрытие
	NFT_TRUSTED_RULE=""
	if [[ -n $NFT_TRUSTED ]]; then
		NFT_TRUSTED_RULE="		tcp dport { 80, 443 } ip saddr { $NFT_TRUSTED } accept"
	fi
	cat >/etc/nftables.d/pereval-pro.nft <<NFT
table inet pereval_pro {
	set pro_clients {
		type ipv4_addr
	}
	chain input {
		type filter hook input priority -10; policy accept;
		iif lo accept
		tcp dport { 80, 443 } ip saddr @pro_clients accept
$NFT_TRUSTED_RULE
		tcp dport { 80, 443 } drop
		udp dport 443 reject
	}
}
NFT
	if ! grep -q 'nftables.d/pereval-pro.nft' /etc/nftables.conf 2>/dev/null; then
		printf '\ninclude "/etc/nftables.d/pereval-pro.nft"\n' >>/etc/nftables.conf
	fi
	systemctl enable nftables >/dev/null 2>&1 || true
	nft -f /etc/nftables.d/pereval-pro.nft 2>/dev/null || { nft delete table inet pereval_pro 2>/dev/null || true; nft -f /etc/nftables.d/pereval-pro.nft; }
	if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
		ufw allow 80/tcp >/dev/null 2>&1 || true
		ufw allow 443/tcp >/dev/null 2>&1 || true
	fi
	say "nftables: таблица pereval_pro применена (доверенные: ${NFT_TRUSTED:-нет})"

	install -m 0755 "$STAGE/pro_node_agent.py" "$AGENT_DST"
	cat >"$AGENT_UNIT" <<UNIT
[Unit]
Description=Pereval Pro worker agent (nftables ACL sync with control plane)
After=network-online.target nftables.service nginx.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$NODE_ENV_DST
ExecStart=/usr/bin/python3 $AGENT_DST
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
	install -m 0755 "$STAGE/stats_collector.py" "$COLLECTOR_DST"
	cat >"$STATS_UNIT_DST" <<UNIT
[Unit]
Description=Pereval lightweight nginx proxy usage collector
After=network.target nginx.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 $COLLECTOR_DST --service-map $MAP_DIR/service-map.json --cluster-config $MAP_DIR/cluster-nodes.json --node-output $GEO_WEB_DIR/node-stats.json --output $GEO_WEB_DIR/stats.json --state-file $STATS_STATE_DIR/state.json --self-domain $PRO_DOMAIN --role worker
Restart=always
RestartSec=5
Nice=10

[Install]
WantedBy=multi-user.target
UNIT
	systemctl daemon-reload
	systemctl enable pereval-pro-agent.service pereval-stats.service >/dev/null 2>&1 || true
	systemctl restart pereval-stats.service || { journalctl -u pereval-stats -n 20 --no-pager >&2 || true; fail "pereval-stats не поднялся"; }
	systemctl restart pereval-pro-agent.service || { journalctl -u pereval-pro-agent -n 30 --no-pager >&2 || true; fail "pereval-pro-agent не поднялся"; }
	say "pereval-pro-agent и pereval-stats перезапущены"

	sleep 1
	for unit in nginx pereval-pro-agent pereval-stats; do
		systemctl is-active --quiet "$unit" || fail "$unit не активен"
	done
	for port in 80 443; do
		if ss -tlnH "sport = :$port" | grep -q .; then say "порт $port слушается (доступ ограничен nftables)"; else say "ВНИМАНИЕ: порт $port не слушается"; fi
	done
	say "nft set pro_clients: $(nft -j list set inet pereval_pro pro_clients 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(len(x.get("set",{}).get("elem",[]) or []) for x in d.get("nftables",[]) if "set" in x))' 2>/dev/null || echo '?') адресов"
else
	fail "неизвестная роль $NODE_ROLE"
fi

{ ls -1dt /var/backups/pereval-pro/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf; } || true
exit 0
REMOTEPRO
}

# ------------------------------------------------ развёртывание одного узла

deploy_node() {
	local node_ip="$1"
	local node_user="$2"
	local node_key="$3"
	local node_port="$4"
	local node_role="$5"
	local node_name="$6"
	local node_secret_env="${7:-}"   # pro-worker: имя env-переменной с секретом ноды

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

	local is_pro=0
	[[ $node_role == "pro-dns" || $node_role == "pro-worker" ]] && is_pro=1

	if ((DRY_RUN)); then
		step "Пробный запуск [$node_role: $node_name ($target:$node_port)], изменений не будет"
		info "SSH-пользователь: $node_user | SSH-ключ: $node_key | порт: $node_port | роль: $node_role"
		if [[ $node_role == "pro-worker" ]]; then
			local dry_secret_var
			dry_secret_var=$(resolve_pro_worker_secret_var "$node_secret_env")
			info "секрет ноды: ${dry_secret_var:-не задан (${node_secret_env:-secret_env} / PRO_WORKER_SECRET пусты — node.env не обновится)}"
		fi
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
command -v bmon >/dev/null 2>&1 || need_pkgs+=(bmon)
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
			info "автоустановка при отсутствии: tar nginx libnginx-mod-stream dnsmasq python3 openssl dnsutils iproute2 ca-certificates bmon"
		fi
		if ((is_pro)); then
			if [[ $node_role == "pro-dns" ]]; then
				for f in "${PRO_DNS_FILES[@]}" "${LIB_FILES[@]}"; do printf '    %-34s -> %s\n' "$f" "pro-dns ($PRO_DOMAIN)"; done
				printf '    затем: dnsmasq(cache) :53, resolv.conf, nginx (DoH), pereval-pro-dns (:53/:853/:8057), pereval-cert-sync.timer (единый сертификат с CP: %s)\n' "$CERT_DOMAINS"
			else
				for f in "${PRO_WORKER_FILES[@]}" "${LIB_FILES[@]}"; do printf '    %-34s -> %s\n' "$f" "pro-worker"; done
				printf '    затем: nginx (SNI/Host-прокси), nftables pereval_pro, pereval-pro-agent, pereval-stats\n'
			fi
			return 0
		fi
		printf '    %-34s -> %s\n' "$DNSMASQ_CONF" "/etc/dnsmasq.conf (и /etc/nginx/geoblock/dnsmasq-base.conf)"
		printf '    %-34s -> %s\n' "$BUILD_DIR/nginx.conf" "/etc/nginx/nginx.conf"
		for m in nginx-sni-allow.map nginx-host-allow.map nginx-workers-stream.conf nginx-workers-http.conf service-map.json cluster-nodes.json; do
			printf '    %-34s -> %s\n' "$BUILD_DIR/$m" "/etc/nginx/geoblock/$m"
		done
		printf '    %-34s -> %s\n' "$SRC_DIR/poolrouting.py, dnscommon.py" "/usr/local/lib/pereval/"
		printf '    %-34s -> %s\n' "$SRC_DIR/stats_collector.py" "/usr/local/bin/pereval-stats-collector.py"
		printf '    %-34s -> %s\n' "$SRC_DIR/doh_proxy.py" "/usr/local/bin/pereval-doh-proxy.py"
		printf '    %-34s -> %s\n' "$SRC_DIR/healthcheck.py" "/usr/local/bin/pereval-healthcheck.py"
		[[ $node_role == "primary" ]] && printf '    %-34s -> %s\n' "$SRC_DIR/cert_sync.py" "/usr/local/bin/pereval-cert-sync.py"
		printf '    %-34s -> %s\n' "sysctl (highload)" "/etc/sysctl.d/99-geoblock-highload.conf"
		if [[ $node_role == "primary" ]]; then
			printf '    затем: sysctl -e -p, dnsmasq --test, nginx -t, restart dnsmasq, reload nginx, restart pereval-doh, restart pereval-stats, restart pereval-healthcheck, pereval-cert-sync.timer (единый сертификат с CP: %s), удаление pereval-leads\n' "$CERT_DOMAINS"
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
	preflight=$(ssh "${ssh_opts[@]}" "$target" "$sudo_cmd env NODE_ROLE_HINT=$node_role bash -s" <<'PRE'
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
if [[ "${NODE_ROLE_HINT:-}" == "pro-worker" ]]; then command -v nft >/dev/null 2>&1 || need_pkgs+=(nftables); fi
command -v dig >/dev/null 2>&1 || need_pkgs+=(dnsutils)
command -v ss >/dev/null 2>&1 || need_pkgs+=(iproute2)
command -v bmon >/dev/null 2>&1 || need_pkgs+=(bmon)
[[ -d /etc/ssl/certs ]] || need_pkgs+=(ca-certificates)

if ((${#need_pkgs[@]})); then
	printf 'installing=%s\n' "${need_pkgs[*]}"
	export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
	apt-get update -qq >/dev/null
	apt-get install -y -qq "${need_pkgs[@]}" >/dev/null || {
		systemctl reset-failed dnsmasq 2>/dev/null || true
	}
fi

for u in nginx; do
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

	for unit in nginx; do
		printf '%s' "$preflight" | grep -qx "unit=$unit" \
			|| die "на сервере $node_ip не удалось подготовить сервис $unit"
	done
	printf '%s' "$preflight" | grep -qx 'tar=yes' \
		|| die "на сервере $node_ip отсутствует tar после автоустановки"

	prepare_local_stage
	[[ $node_role == "pro-worker" ]] && stage_pro_worker_env "$node_name" "$node_secret_env"

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
	if ((is_pro)); then
		local trusted="$PRO_DNS_IP,$PRO_CP_IP,$CLUSTER_PRIMARY"
		ssh "${ssh_opts[@]}" "$target" \
			"$sudo_cmd bash -c 'if [ -f \"$stage/node.$node_role.env\" ]; then cp \"$stage/node.$node_role.env\" \"$stage/node.env\"; fi; bash \"$stage/apply-pro.sh\" \"$stage\" \"$stamp\" \"$node_ip\" \"$PRO_DOMAIN\" \"$node_role\" \"$PRO_DNS_IP\" \"$trusted\" \"$CP_ORIGIN\"'" || apply_rc=$?
	else
		ssh "${ssh_opts[@]}" "$target" \
			"$sudo_cmd bash -c 'if [ -f \"$stage/node.$node_role.env\" ]; then cp \"$stage/node.$node_role.env\" \"$stage/node.env\"; fi; bash \"$stage/apply.sh\" \"$stage\" \"$stamp\" \"$node_ip\" \"$DOMAIN\" \"$node_role\" \"$FREE_DOMAINS\" \"$CP_ORIGIN\" \"$CERT_DOMAINS\"'" || apply_rc=$?
	fi

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

if ((DEPLOY_PRO)); then
	step "Развёртывание Pro: DNS-нода $PRO_DNS_IP, затем воркеры (${#PRO_WORKER_LINES[@]})"
	deploy_node "$PRO_DNS_IP" "$SSH_USER" "$SSH_KEY" "$SSH_PORT" "pro-dns" "pro-dns"
	for wline in "${PRO_WORKER_LINES[@]}"; do
		[[ -z $wline ]] && continue
		IFS='|' read -r w_ip w_name _w_weight w_user w_user_env w_key w_key_env w_port _w_pools w_secret_env <<<"$wline"
		validate_ipv4 "$w_ip"
		eff_user=$(resolve_worker_user "$w_user" "$w_user_env")
		eff_key=$(resolve_worker_key "$w_key" "$w_key_env" "pro-worker $w_name ($w_ip)")
		eff_port=$(resolve_worker_port "$w_port")
		deploy_node "$w_ip" "$eff_user" "$eff_key" "$eff_port" "pro-worker" "$w_name" "$w_secret_env"
	done
elif [[ $ROLE == "pro-worker" ]]; then
	# одиночный воркер: имя и secret_env берём из services.yaml по IP, если он там описан
	pw_name="$ROLE-$SERVER_IP"; pw_secret_env=""
	for wline in "${PRO_WORKER_LINES[@]}"; do
		[[ -z $wline ]] && continue
		IFS='|' read -r w_ip w_name _w_weight w_user w_user_env w_key w_key_env w_port _w_pools w_secret_env <<<"$wline"
		if [[ $w_ip == "$SERVER_IP" ]]; then pw_name="$w_name"; pw_secret_env="$w_secret_env"; break; fi
	done
	deploy_node "$SERVER_IP" "$SSH_USER" "$SSH_KEY" "$SSH_PORT" "pro-worker" "$pw_name" "$pw_secret_env"
elif [[ $ROLE == "pro-dns" ]]; then
	deploy_node "$SERVER_IP" "$SSH_USER" "$SSH_KEY" "$SSH_PORT" "$ROLE" "$ROLE-$SERVER_IP"
else

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
		IFS='|' read -r w_ip w_name _w_weight w_user w_user_env w_key w_key_env w_port _w_pools w_secret_env <<<"$matched_worker_line"
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
		IFS='|' read -r w_ip w_name _w_weight w_user w_user_env w_key w_key_env w_port _w_pools w_secret_env <<<"$wline"
		validate_ipv4 "$w_ip"
		eff_user=$(resolve_worker_user "$w_user" "$w_user_env")
		eff_key=$(resolve_worker_key "$w_key" "$w_key_env" "worker $w_name ($w_ip)")
		eff_port=$(resolve_worker_port "$w_port")
		deploy_node "$w_ip" "$eff_user" "$eff_key" "$eff_port" "worker" "$w_name"
	done
	deploy_node "$SERVER_IP" "$SSH_USER" "$SSH_KEY" "$SSH_PORT" "primary" "primary"
fi

fi

if (( ! DRY_RUN )); then
	step "Готово"
	if ((NEED_PRO)); then
		info "Pro обновлён ($PRO_DOMAIN). Логи: journalctl -u pereval-pro-dns -f | journalctl -u pereval-pro-agent -f"
	else
		info "кластер обновлён ($n_dnsmasq доменов)"
		info "логи: journalctl -u dnsmasq -f  |  journalctl -u pereval-healthcheck -f  |  tail -f /var/log/nginx/sni.log"
	fi
fi
