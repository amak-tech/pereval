#!/usr/bin/env bash
#
# Отключает аутентификацию по паролю в OpenSSH (sshd), если она включена.
# Идемпотентен: если парольная аутентификация уже отключена в эффективной
# конфигурации (sshd -T), ничего не меняет и не перезагружает sshd.
#
# Используется при деплое на все узлы (Free primary/worker, Pro dns/worker)
# и на Control Plane (pereval.top).
#
# Переменные окружения (для тестирования):
#   SSHD_BIN       — путь к бинарнику sshd (по умолчанию ищется в PATH и /usr/sbin)
#   SSHD_CONFIG    — путь к основному конфигу (по умолчанию /etc/ssh/sshd_config)
#   SSHD_CONFIG_D  — каталог drop-in конфигов (по умолчанию /etc/ssh/sshd_config.d)
#   DROPIN_FILE    — путь к drop-in файлу (по умолчанию $SSHD_CONFIG_D/00-pereval-no-password.conf)
#   RELOAD_CMD     — команда перезагрузки sshd вместо systemd/service

set -euo pipefail

SSHD_BIN="${SSHD_BIN:-}"
SSHD_CONFIG="${SSHD_CONFIG:-/etc/ssh/sshd_config}"
SSHD_CONFIG_D="${SSHD_CONFIG_D:-/etc/ssh/sshd_config.d}"
DROPIN_FILE="${DROPIN_FILE:-$SSHD_CONFIG_D/00-pereval-no-password.conf}"
RELOAD_CMD="${RELOAD_CMD:-}"

say()  { printf '    %s\n' "$*"; }
warn() { printf '    внимание: %s\n' "$*" >&2; }
fail() { printf 'ошибка SSH-настройки: %s\n' "$*" >&2; exit 1; }

if [[ -z $SSHD_BIN ]]; then
	SSHD_BIN=$(command -v sshd 2>/dev/null || true)
	if [[ -z $SSHD_BIN ]]; then
		for cand in /usr/sbin/sshd /sbin/sshd; do
			if [[ -x $cand ]]; then
				SSHD_BIN="$cand"
				break
			fi
		done
	fi
fi

if [[ -z $SSHD_BIN || ! -x $SSHD_BIN ]]; then
	warn "sshd не найден — пропускаю проверку аутентификации по паролю"
	exit 0
fi

if [[ ! -f $SSHD_CONFIG ]]; then
	warn "$SSHD_CONFIG не найден — пропускаю проверку аутентификации по паролю"
	exit 0
fi

sshd_effective() {
	"$SSHD_BIN" -f "$SSHD_CONFIG" -T -C user=root,host=localhost,addr=127.0.0.1 2>/dev/null \
		|| "$SSHD_BIN" -f "$SSHD_CONFIG" -T 2>/dev/null
}

password_auth_enabled() {
	local eff="$1"
	printf '%s\n' "$eff" | tr '[:upper:]' '[:lower:]' | grep -qxE '(passwordauthentication|kbdinteractiveauthentication|challengeresponseauthentication)[[:space:]]+yes'
}

has_include_dropin() {
	grep -qiE '^[[:space:]]*Include[[:space:]]+.*sshd_config\.d/\*\.conf([[:space:]]|$)' "$SSHD_CONFIG"
}

reload_sshd() {
	if [[ -n $RELOAD_CMD ]]; then
		( eval "$RELOAD_CMD" )
		return $?
	fi
	if command -v systemctl >/dev/null 2>&1; then
		if systemctl is-active --quiet ssh.service 2>/dev/null; then
			systemctl reload ssh.service
			return $?
		elif systemctl is-active --quiet sshd.service 2>/dev/null; then
			systemctl reload sshd.service
			return $?
		elif systemctl is-active --quiet ssh.socket 2>/dev/null; then
			# Socket activation (Ubuntu 24.04+): новые соединения читают конфиг напрямую.
			return 0
		fi
	fi
	if command -v service >/dev/null 2>&1; then
		if service ssh reload >/dev/null 2>&1 || service sshd reload >/dev/null 2>&1; then
			return 0
		fi
	fi
	local pidfile pid
	for pidfile in /run/sshd.pid /var/run/sshd.pid; do
		if [[ -f $pidfile ]]; then
			pid=$(cat "$pidfile" 2>/dev/null || true)
			if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
				kill -HUP "$pid"
				return 0
			fi
		fi
	done
	return 1
}

eff=$(sshd_effective) || true
if [[ -z $eff ]]; then
	fail "не удалось прочитать эффективную конфигурацию через $SSHD_BIN -T"
fi

eff_lower=$(printf '%s\n' "$eff" | tr '[:upper:]' '[:lower:]')

if ! password_auth_enabled "$eff_lower"; then
	say "SSH: аутентификация по паролю уже отключена"
	exit 0
fi

if printf '%s\n' "$eff_lower" | grep -qxE 'pubkeyauthentication[[:space:]]+no'; then
	fail "PubkeyAuthentication отключена — не отключаю вход по паролю, чтобы не потерять доступ"
fi

# OpenSSH 8.7+ использует KbdInteractiveAuthentication; более старые — ChallengeResponseAuthentication.
if printf '%s\n' "$eff_lower" | grep -qE '^kbdinteractiveauthentication[[:space:]]+'; then
	INTERACTIVE_KEY="KbdInteractiveAuthentication"
else
	INTERACTIVE_KEY="ChallengeResponseAuthentication"
fi

TMP_DIR=$(mktemp -d)
ORIG_CONFIG="$TMP_DIR/sshd_config.orig"
ORIG_DROPIN="$TMP_DIR/dropin.orig"
HAD_DROPIN=0
cp -a "$SSHD_CONFIG" "$ORIG_CONFIG"
if [[ -f $DROPIN_FILE ]]; then
	HAD_DROPIN=1
	cp -a "$DROPIN_FILE" "$ORIG_DROPIN"
fi

cleanup() {
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

restore_ssh() {
	cp -a "$ORIG_CONFIG" "$SSHD_CONFIG"
	if ((HAD_DROPIN)); then
		cp -a "$ORIG_DROPIN" "$DROPIN_FILE"
	else
		rm -f "$DROPIN_FILE"
	fi
}

# Шаг 1: если подключён sshd_config.d/*.conf, пишем drop-in с префиксом 00- (first match wins).
if has_include_dropin; then
	mkdir -p "$SSHD_CONFIG_D"
	cat >"$DROPIN_FILE" <<EOF
# Managed by Pereval deploy: disable SSH password authentication
PasswordAuthentication no
${INTERACTIVE_KEY} no
PermitEmptyPasswords no
EOF
	chmod 0644 "$DROPIN_FILE"
fi

# Проверяем, сработал ли drop-in; если нет (например, нет Include или в sshd_config
# директивы стоят до Include), правим основной sshd_config до первого блока Match.
eff_after=""
if "$SSHD_BIN" -t -f "$SSHD_CONFIG" >/dev/null 2>&1; then
	eff_after=$(sshd_effective) || true
fi

if [[ -z $eff_after ]] || password_auth_enabled "$eff_after"; then
	awk -v ikey="$INTERACTIVE_KEY" '
		BEGIN {
			in_match = 0
			inserted = 0
			header = "# Managed by Pereval deploy: disable SSH password authentication\nPasswordAuthentication no\n" ikey " no\nPermitEmptyPasswords no\n"
		}
		{
			low = tolower($0)
			if (!in_match && low ~ /^[[:space:]]*match([[:space:]]|$)/) {
				in_match = 1
			}
			if (!in_match && low ~ /^[[:space:]]*(passwordauthentication|kbdinteractiveauthentication|challengeresponseauthentication|permitemptypasswords)([[:space:]]+|=)/) {
				print "# [pereval-disabled] " $0
				next
			}
			if (!inserted) {
				printf "%s", header
				inserted = 1
			}
			print
		}
		END {
			if (!inserted) {
				printf "%s", header
			}
		}
	' "$ORIG_CONFIG" >"$TMP_DIR/sshd_config.new"
	cat "$TMP_DIR/sshd_config.new" >"$SSHD_CONFIG"
fi

if ! "$SSHD_BIN" -t -f "$SSHD_CONFIG" >/dev/null 2>&1; then
	restore_ssh
	fail "sshd -t завершился с ошибкой после изменения конфига — изменения откачены"
fi

eff_final=$(sshd_effective) || true
if [[ -z $eff_final ]] || password_auth_enabled "$eff_final"; then
	restore_ssh
	fail "не удалось отключить аутентификацию по паролю (проверьте $SSHD_CONFIG и $SSHD_CONFIG_D) — изменения откачены"
fi

if printf '%s\n' "$eff_final" | tr '[:upper:]' '[:lower:]' | grep -qxE 'pubkeyauthentication[[:space:]]+no'; then
	restore_ssh
	fail "после изменения конфига PubkeyAuthentication стала no — изменения откачены"
fi

if ! reload_sshd; then
	restore_ssh
	fail "не удалось перезагрузить sshd — изменения откачены"
fi

say "SSH: аутентификация по паролю отключена"
