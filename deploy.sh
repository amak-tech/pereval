#!/usr/bin/env bash
#
# Раскладывает сгенерированные конфиги на сервер и перезапускает сервисы.
#
#   ./deploy.sh <ip-сервера> <путь-к-ssh-ключу> [пользователь]
#
# Что делает:
#   1. проверяет, что локальные файлы существуют, свежие и собраны для этого IP
#   2. заливает их в staging-каталог на сервере
#   3. проверяет синтаксис ДО подмены рабочих конфигов
#   4. делает резервные копии, устанавливает, перезапускает
#   5. при любой ошибке откатывает и возвращает как было
#
# dnsmasq именно перезапускается: по SIGHUP он перечитывает /etc/hosts и чистит
# кэш, но не конфиг, так что reload не подхватил бы новые address=.
# nginx наоборот перезагружается через reload — restart рвёт все текущие
# соединения, включая длинные SSE-потоки Claude и ChatGPT.

set -euo pipefail

DNSMASQ_CONF="dnsmasq-geoblock.conf"
NGINX_CONF="nginx.conf"
NGINX_MAPS=("nginx-sni-allow.map" "nginx-host-allow.map")
SOURCE_YAML="services.yaml"

SSH_PORT=22
DRY_RUN=0
FORCE=0

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
[[ -t 1 ]] || { RED=; GRN=; YEL=; DIM=; OFF=; }

die()  { printf '%sошибка:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
warn() { printf '%sвнимание:%s %s\n' "$YEL" "$OFF" "$*" >&2; }
step() { printf '%s==>%s %s\n' "$GRN" "$OFF" "$*"; }
info() { printf '    %s%s%s\n' "$DIM" "$*" "$OFF"; }

usage() {
	cat <<'USAGE'
Использование:
  ./deploy.sh <ip-сервера> <путь-к-ssh-ключу> [пользователь]

Аргументы:
  ip-сервера         IPv4-адрес сервера
  путь-к-ssh-ключу   приватный ключ для подключения
  пользователь       по умолчанию root

Опции:
  -p, --port ПОРТ    порт SSH (по умолчанию 22)
  -n, --dry-run      показать, что будет сделано, ничего не менять
  -f, --force        не останавливаться на предупреждениях
  -h, --help         эта справка

Примеры:
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 ubuntu
  ./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 ubuntu --port 2222 --dry-run
USAGE
}

# --------------------------------------------------------------- аргументы

POSITIONAL=()
while (($#)); do
	case "$1" in
		-h|--help)    usage; exit 0 ;;
		-n|--dry-run) DRY_RUN=1; shift ;;
		-f|--force)   FORCE=1; shift ;;
		-p|--port)    SSH_PORT="${2:-}"; [[ -n $SSH_PORT ]] || die "--port без значения"; shift 2 ;;
		--port=*)     SSH_PORT="${1#*=}"; shift ;;
		-*)           die "неизвестная опция: $1 (см. --help)" ;;
		*)            POSITIONAL+=("$1"); shift ;;
	esac
done

((${#POSITIONAL[@]} >= 2)) || { usage >&2; exit 1; }
((${#POSITIONAL[@]} <= 3)) || die "лишние аргументы: ${POSITIONAL[*]:3}"

SERVER_IP="${POSITIONAL[0]}"
SSH_KEY="${POSITIONAL[1]}"
SSH_USER="${POSITIONAL[2]:-root}"

[[ $SERVER_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "«${SERVER_IP}» не похож на IPv4-адрес"
for octet in ${SERVER_IP//./ }; do
	((octet <= 255)) || die "«${SERVER_IP}» не похож на IPv4-адрес: октет ${octet} больше 255"
done
[[ $SSH_PORT =~ ^[0-9]+$ ]] && ((SSH_PORT > 0 && SSH_PORT < 65536)) || die "некорректный порт SSH: $SSH_PORT"

SSH_KEY="${SSH_KEY/#\~/$HOME}"
[[ -f $SSH_KEY ]] || die "ключ не найден: $SSH_KEY"
[[ -r $SSH_KEY ]] || die "ключ недоступен для чтения: $SSH_KEY"

perms=$(stat -f '%Lp' "$SSH_KEY" 2>/dev/null || stat -c '%a' "$SSH_KEY" 2>/dev/null || echo "")
if [[ -n $perms && $perms != 400 && $perms != 600 ]]; then
	warn "права на ключ $perms, ssh может отказаться его использовать: chmod 600 $SSH_KEY"
fi

cd "$(dirname "${BASH_SOURCE[0]}")"

# ------------------------------------------------------- локальные проверки

step "Проверяю локальные файлы"

LOCAL_FILES=("$DNSMASQ_CONF" "$NGINX_CONF" "${NGINX_MAPS[@]}")
missing=()
for f in "${LOCAL_FILES[@]}"; do
	[[ -f $f ]] || missing+=("$f")
done
if ((${#missing[@]})); then
	die "не хватает файлов: ${missing[*]}
    соберите их: python3 generate.py $SOURCE_YAML $SERVER_IP"
fi

# конфиги собраны для другого адреса — самая дорогая ошибка, ловим сразу
if ! grep -q "/$SERVER_IP\$" "$DNSMASQ_CONF"; then
	baked=$(grep -m1 '^address=' "$DNSMASQ_CONF" | sed 's|.*/||')
	die "$DNSMASQ_CONF собран для адреса ${baked:-неизвестного}, а разворачивается на $SERVER_IP
    пересоберите: python3 generate.py $SOURCE_YAML $SERVER_IP"
fi

# несведённые подстановки означают, что генератор падал на середине
for f in "${LOCAL_FILES[@]}"; do
	if grep -q '{{[a-z_]*}}' "$f"; then
		die "в $f остались подстановки {{...}} — генератор не доработал"
	fi
done

# списки должны совпадать, иначе nginx отвергнет то, что резолвит dnsmasq
n_dnsmasq=$(grep -c '^address=' "$DNSMASQ_CONF" || true)
for m in "${NGINX_MAPS[@]}"; do
	n_map=$(grep -c '^\.' "$m" || true)
	((n_dnsmasq == n_map)) || die "в $DNSMASQ_CONF $n_dnsmasq доменов, а в $m — $n_map
    пересоберите оба файла одним запуском generate.py"
done
info "$n_dnsmasq доменов, списки dnsmasq и nginx совпадают"

if [[ -f $SOURCE_YAML ]]; then
	for f in "${LOCAL_FILES[@]}"; do
		if [[ $SOURCE_YAML -nt $f ]]; then
			warn "$SOURCE_YAML новее, чем $f — возможно, забыли пересобрать"
			((FORCE)) || die "перезапустите generate.py или добавьте --force"
			break
		fi
	done
fi

# ------------------------------------------------------------------- ssh

TARGET="$SSH_USER@$SERVER_IP"

# Все обращения к серверу идут через один мастер-канал. Без этого скрипт
# открывал бы около десяти отдельных TCP-соединений за пару секунд и упирался
# в «ufw limit 22/tcp» (шесть подключений за 30 секунд, дальше REJECT) или
# в fail2ban — с сообщением «Connection refused» посреди работы.
# Путь к сокету короткий: на macOS длина пути к unix-сокету ограничена.
CTL="/tmp/.geoblock-cm-$$"
SSH_OPTS=(-i "$SSH_KEY" -p "$SSH_PORT"
          -o IdentitiesOnly=yes
          -o BatchMode=yes
          -o ConnectTimeout=10
          -o StrictHostKeyChecking=accept-new
          -o LogLevel=ERROR
          -o ControlMaster=auto
          -o "ControlPath=$CTL"
          -o ControlPersist=120)

close_master() {
	ssh -o "ControlPath=$CTL" -O exit "$TARGET" 2>/dev/null || true
	rm -f "$CTL"
}

step "Подключаюсь к $TARGET:$SSH_PORT"
ssh "${SSH_OPTS[@]}" "$TARGET" true 2>/dev/null \
	|| die "не удалось подключиться по SSH.
    Проверьте адрес, порт, пользователя и что ключ добавлен в authorized_keys.
    Если раньше подключение работало, возможно сработало ограничение частоты
    (ufw limit 22/tcp или fail2ban) — подождите 30 секунд и повторите.
    Для подробностей: ssh -vv -i $SSH_KEY -p $SSH_PORT $TARGET"
trap close_master EXIT

if [[ $SSH_USER == root ]]; then
	SUDO=""
else
	ssh "${SSH_OPTS[@]}" "$TARGET" "sudo -n true" 2>/dev/null \
		|| die "пользователю $SSH_USER нужен sudo без пароля.
    Добавьте на сервере: echo '$SSH_USER ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/$SSH_USER"
	SUDO="sudo"
	info "команды выполняются через sudo"
fi

# Одна сессия вместо четырёх: версия ОС, наличие юнитов и tar сразу.
PREFLIGHT=$(ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'PRE'
if . /etc/os-release 2>/dev/null; then printf 'os=%s\n' "$PRETTY_NAME"; fi
for u in dnsmasq nginx; do
	if systemctl cat "$u" >/dev/null 2>&1; then printf 'unit=%s\n' "$u"; fi
done
if command -v tar >/dev/null 2>&1; then printf 'tar=yes\n'; fi
exit 0
PRE
)

info "сервер: $(printf '%s' "$PREFLIGHT" | sed -n 's/^os=//p' | head -1)"

for unit in dnsmasq nginx; do
	printf '%s' "$PREFLIGHT" | grep -qx "unit=$unit" \
		|| die "на сервере нет сервиса $unit — установите его перед развёртыванием"
done
printf '%s' "$PREFLIGHT" | grep -qx 'tar=yes' \
	|| die "на сервере нет tar — он нужен для передачи файлов: apt install -y tar"

if ((DRY_RUN)); then
	step "Пробный запуск, изменений не будет"
	printf '    %-24s -> %s\n' "$DNSMASQ_CONF" "/etc/dnsmasq.conf"
	printf '    %-24s -> %s\n' "$NGINX_CONF" "/etc/nginx/nginx.conf"
	for m in "${NGINX_MAPS[@]}"; do
		printf '    %-24s -> %s\n' "$m" "/etc/nginx/geoblock/$m"
	done
	printf '    затем: dnsmasq --test, nginx -t, restart dnsmasq, reload nginx\n'
	exit 0
fi

# --------------------------------------------------------------- заливка

STAMP=$(date +%Y%m%d-%H%M%S)
STAGE="/tmp/geoblock-$STAMP"

cleanup() {
	if [[ -n ${LOCAL_STAGE:-} ]]; then rm -rf "$LOCAL_STAGE"; fi
	ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf '$STAGE'" 2>/dev/null || true
	close_master
	return 0
}
trap cleanup EXIT

step "Готовлю файлы для передачи"

LOCAL_STAGE=$(mktemp -d)
cp "${LOCAL_FILES[@]}" "$LOCAL_STAGE/"
for f in "${LOCAL_FILES[@]}"; do
	info "$f ($(wc -c <"$f" | tr -d ' ') байт)"
done

# ------------------------------------------------ применение на сервере

cat >"$LOCAL_STAGE/apply.sh" <<'REMOTE'
#!/usr/bin/env bash
set -euo pipefail

STAGE="$1"; STAMP="$2"; SERVER_IP="$3"
BACKUP="/var/backups/geoblock/$STAMP"
DNSMASQ_DST="/etc/dnsmasq.conf"
DNSMASQ_OLD="/etc/dnsmasq.d/dnsmasq-geoblock.conf"
NGINX_DST="/etc/nginx/nginx.conf"
MAP_DIR="/etc/nginx/geoblock"

say()  { printf '    %s\n' "$*"; }
fail() { printf 'ошибка на сервере: %s\n' "$*" >&2; exit 1; }

mkdir -p "$BACKUP" "$MAP_DIR"

# --- всё ли доехало -------------------------------------------------------
for f in dnsmasq-geoblock.conf nginx.conf nginx-sni-allow.map nginx-host-allow.map; do
	[[ -s "$STAGE/$f" ]] || fail "файл $f не доехал или пустой — передача оборвалась"
done
say "получено 4 файла"

# --- проверка синтаксиса ДО того, как что-то тронуто -----------------------
dnsmasq --test -C "$STAGE/dnsmasq-geoblock.conf" \
	|| fail "dnsmasq не принимает новый конфиг, ничего не менял"
say "синтаксис dnsmasq в порядке"

# --- резервные копии ------------------------------------------------------
backup_one() {  # <источник> <имя-в-бэкапе>
	if [[ -f $1 ]]; then
		cp -a "$1" "$BACKUP/$2"
	fi
}
backup_one "$DNSMASQ_DST"                  dnsmasq.conf
backup_one "$NGINX_DST"                    nginx.conf
backup_one "$MAP_DIR/nginx-sni-allow.map"  nginx-sni-allow.map
backup_one "$MAP_DIR/nginx-host-allow.map" nginx-host-allow.map
say "резервные копии: $BACKUP"

restore() {
	printf 'откатываю изменения\n' >&2
	for name in dnsmasq.conf nginx.conf nginx-sni-allow.map nginx-host-allow.map; do
		if [[ -f "$BACKUP/$name" ]]; then
			case "$name" in
				dnsmasq.conf) cp -a "$BACKUP/$name" "$DNSMASQ_DST" ;;
				nginx.conf)   cp -a "$BACKUP/$name" "$NGINX_DST" ;;
				*)            cp -a "$BACKUP/$name" "$MAP_DIR/$name" ;;
			esac
		fi
	done
	systemctl restart dnsmasq 2>/dev/null || true
	systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
}

# --- nginx: сначала установить, потом проверить, при провале откатить ------
# nginx -t умеет тестировать только реальный /etc/nginx/nginx.conf, поэтому
# порядок именно такой.
install -m 0644 "$STAGE/nginx-sni-allow.map"  "$MAP_DIR/nginx-sni-allow.map"
install -m 0644 "$STAGE/nginx-host-allow.map" "$MAP_DIR/nginx-host-allow.map"
install -m 0644 "$STAGE/nginx.conf"           "$NGINX_DST"

if ! nginx -t 2>/tmp/nginx-test.log; then
	cat /tmp/nginx-test.log >&2
	restore
	fail "nginx -t не прошёл, откатился на предыдущий конфиг"
fi
say "синтаксис nginx в порядке"

# --- установка dnsmasq ----------------------------------------------------
install -m 0644 "$STAGE/dnsmasq-geoblock.conf" "$DNSMASQ_DST"

# Раньше конфиг раскладывался в /etc/dnsmasq.d/. Файл оттуда нужно убрать:
# сам по себе он теперь инертен (conf-dir в новом конфиге нет), но при любой
# правке dnsmasq.conf может неожиданно ожить и продублировать опции.
if [[ -f $DNSMASQ_OLD ]]; then
	cp -a "$DNSMASQ_OLD" "$BACKUP/dnsmasq.d-dnsmasq-geoblock.conf"
	rm -f "$DNSMASQ_OLD"
	say "убрал устаревший $DNSMASQ_OLD (копия в бэкапе)"
fi

# --- перезапуск -----------------------------------------------------------
# dnsmasq по SIGHUP конфиг не перечитывает, нужен именно restart
if ! systemctl restart dnsmasq; then
	journalctl -u dnsmasq -n 20 --no-pager >&2 || true
	restore
	fail "dnsmasq не поднялся"
fi
say "dnsmasq перезапущен"

# nginx перезагружается плавно: restart оборвал бы активные SSE-потоки
if ! systemctl reload nginx; then
	journalctl -u nginx -n 20 --no-pager >&2 || true
	restore
	fail "nginx не перезагрузился"
fi
say "nginx перезагружен"

# --- проверка результата --------------------------------------------------
sleep 1
for unit in dnsmasq nginx; do
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
elif [[ $got == "$SERVER_IP" ]]; then
	say "проверка: claude.ai -> $got, подмена работает"
else
	say "ВНИМАНИЕ: claude.ai -> ${got:-пусто}, ожидался $SERVER_IP"
fi

for port in 80 443; do
	if ss -tlnH "sport = :$port" | grep -q .; then
		say "порт $port слушается"
	else
		say "ВНИМАНИЕ: на порту $port никто не слушает"
	fi
done

# --- чистка старых бэкапов, оставляем последние 10 ------------------------
# без || true pipefail уронил бы скрипт здесь, уже после успешного развёртывания
{ ls -1dt /var/backups/geoblock/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf; } || true

exit 0
REMOTE

step "Передаю файлы в $STAGE"

# Передача идёт через tar, а не scp. scp в OpenSSH 9+ работает по протоколу
# SFTP, и если на сервере не включена подсистема sftp, он падает с невнятным
# «Connection closed» — при полностью рабочем ssh. tar использует тот же
# канал, что и обычная команда по ssh, поэтому работает всегда.
# COPYFILE_DISABLE не даёт bsdtar на macOS положить рядом файлы ._*
if ! COPYFILE_DISABLE=1 tar -cf - -C "$LOCAL_STAGE" . \
	| ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$STAGE' && tar -xf - -C '$STAGE'"; then
	die "не удалось передать файлы на сервер"
fi

step "Применяю на сервере"
if ssh "${SSH_OPTS[@]}" "$TARGET" \
	"$SUDO bash '$STAGE/apply.sh' '$STAGE' '$STAMP' '$SERVER_IP'"; then
	step "Готово"
	info "сервер $SERVER_IP обновлён, $n_dnsmasq доменов"
	info "логи: journalctl -u dnsmasq -f  |  tail -f /var/log/nginx/sni.log"
else
	die "развёртывание не удалось, конфиги на сервере откачены на предыдущие"
fi
