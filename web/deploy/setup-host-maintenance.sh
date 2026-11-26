#!/usr/bin/env bash
#
# Настраивает ротацию логов и автоматическую очистку файлов, бэкапов и старых
# Docker-образов на хосте Control Plane (pereval.top).
#
# Идемпотентен: перезапускает/перечитывает демоны только при реальном изменении
# соответствующих конфигов. Вызывается при каждом деплое из .github/workflows/web.yml
# (и может запускаться вручную от root на сервере).
#
# Что настраивает:
#   1. systemd-journald (/etc/systemd/journald.conf.d/pereval.conf):
#      лимит 200M, хранение 14 дней, сжатие + немедленный vacuum;
#   2. Docker daemon (/etc/docker/daemon.json):
#      дефолтный json-file с max-size=10m, max-file=5, compress=true (SIGHUP reload без рестарта контейнеров);
#   3. logrotate (/etc/logrotate.d/pereval-cp):
#      ротация /var/log/pereval-*.log и /opt/pereval/dns01/*.log (14 дней, maxsize 10M, сжатие);
#   4. ежедневный systemd-таймер pereval-cp-cleanup.{service,timer} (/usr/local/sbin/pereval-cp-cleanup):
#      удаление старых архивных логов, осиротевших tmp-файлов, дампов старше BACKUP_KEEP_DAYS (14 дней),
#      устаревших артефактов DNS-01, кэша apt и неиспользуемых Docker-образов/кэша сборки старше 24 ч.

set -euo pipefail

PEREVAL_DIR="${PEREVAL_DIR:-/opt/pereval}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/pereval}"
VAR_LOG_DIR="${VAR_LOG_DIR:-/var/log}"
JOURNALD_CONF_D="${JOURNALD_CONF_D:-/etc/systemd/journald.conf.d}"
JOURNALD_DROPIN="${JOURNALD_DROPIN:-$JOURNALD_CONF_D/pereval.conf}"
DOCKER_DAEMON_JSON="${DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}"
LOGROTATE_D="${LOGROTATE_D:-/etc/logrotate.d}"
LOGROTATE_CONF="${LOGROTATE_CONF:-$LOGROTATE_D/pereval-cp}"
CLEANUP_BIN="${CLEANUP_BIN:-/usr/local/sbin/pereval-cp-cleanup}"
BACKUP_BIN="${BACKUP_BIN:-/usr/local/sbin/pereval-cp-backup}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
JOURNAL_MAX_USE="${JOURNAL_MAX_USE:-200M}"
JOURNAL_RETENTION_DAYS="${JOURNAL_RETENTION_DAYS:-14}"
LOG_KEEP_DAYS="${LOG_KEEP_DAYS:-14}"

SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-$(command -v systemctl 2>/dev/null || true)}"
JOURNALCTL_BIN="${JOURNALCTL_BIN:-$(command -v journalctl 2>/dev/null || true)}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 2>/dev/null || true)}"

say()  { printf '    %s\n' "$*"; }
warn() { printf '    внимание: %s\n' "$*" >&2; }

write_if_changed() {
	local dst="$1" mode="$2" content="$3"
	local dir
	dir=$(dirname "$dst")
	mkdir -p "$dir"
	local tmp="$dst.pereval-tmp.$$"
	printf '%s' "$content" >"$tmp"
	chmod "$mode" "$tmp"
	if [[ -f $dst ]] && cmp -s "$tmp" "$dst"; then
		rm -f "$tmp"
		return 1
	fi
	mv -f "$tmp" "$dst"
	return 0
}

# 1. systemd-journald: лимит размера и срока хранения системных логов
JOURNALD_CONTENT="# Managed by Pereval deploy: cap systemd journal size and retention on CP
[Journal]
SystemMaxUse=${JOURNAL_MAX_USE}
SystemKeepFree=1G
SystemMaxFileSize=32M
MaxRetentionSec=${JOURNAL_RETENTION_DAYS}day
Compress=yes
"

if write_if_changed "$JOURNALD_DROPIN" 0644 "$JOURNALD_CONTENT"; then
	say "journald: обновлён $JOURNALD_DROPIN (${JOURNAL_MAX_USE}, ${JOURNAL_RETENTION_DAYS} дн.)"
	if [[ -n $SYSTEMCTL_BIN && -x $SYSTEMCTL_BIN ]]; then
		"$SYSTEMCTL_BIN" restart systemd-journald >/dev/null 2>&1 || true
	fi
fi

if [[ -n $JOURNALCTL_BIN && -x $JOURNALCTL_BIN ]]; then
	"$JOURNALCTL_BIN" --vacuum-time="${JOURNAL_RETENTION_DAYS}d" --vacuum-size="$JOURNAL_MAX_USE" >/dev/null 2>&1 || true
fi

# 2. Docker daemon.json: лимиты логов по умолчанию для любых контейнеров на хосте
if [[ -n $PYTHON_BIN && -x $PYTHON_BIN ]] && { [[ -d $(dirname "$DOCKER_DAEMON_JSON") ]] || command -v docker >/dev/null 2>&1; }; then
	mkdir -p "$(dirname "$DOCKER_DAEMON_JSON")"
	daemon_status=$("$PYTHON_BIN" - "$DOCKER_DAEMON_JSON" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = {}
if path.exists():
    raw = path.read_text(encoding="utf-8").strip()
    if raw:
        try:
            parsed = json.loads(raw)
        except Exception as exc:
            sys.stderr.write(f"skip invalid JSON in {path}: {exc}\n")
            print("skipped")
            sys.exit(0)
        if not isinstance(parsed, dict):
            print("skipped")
            sys.exit(0)
        data = parsed

before = json.dumps(data, sort_keys=True)
driver = data.setdefault("log-driver", "json-file")
if driver == "json-file":
    opts = data.setdefault("log-opts", {})
    if isinstance(opts, dict):
        opts["max-size"] = "10m"
        opts["max-file"] = "5"
        opts["compress"] = "true"

after = json.dumps(data, sort_keys=True)
if before == after and path.exists():
    print("unchanged")
    sys.exit(0)

tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
print("updated")
PY
	) || daemon_status="error"

	if [[ $daemon_status == "updated" ]]; then
		say "docker: обновлён $DOCKER_DAEMON_JSON (json-file 10m×5, compress)"
		if [[ -n $SYSTEMCTL_BIN && -x $SYSTEMCTL_BIN ]]; then
			# SIGHUP перечитывает конфиг dockerd без остановки работающих контейнеров
			"$SYSTEMCTL_BIN" reload docker >/dev/null 2>&1 || true
		fi
	elif [[ $daemon_status == "skipped" ]]; then
		warn "не удалось разобрать $DOCKER_DAEMON_JSON — оставлен без изменений"
	fi
fi

# 3. logrotate для хостовых логов Перевала (оффсайт-бэкапы, выпуск сертификата и обслуживание)
LOGROTATE_CONTENT="# Managed by Pereval deploy
${VAR_LOG_DIR}/pereval-*.log ${PEREVAL_DIR}/dns01/*.log {
    daily
    rotate ${LOG_KEEP_DAYS}
    maxsize 10M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
}
"

if write_if_changed "$LOGROTATE_CONF" 0644 "$LOGROTATE_CONTENT"; then
	say "logrotate: обновлён $LOGROTATE_CONF (${LOG_KEEP_DAYS} дн.)"
fi

# 4. Скрипт и ежедневный systemd-таймер очистки файлов, бэкапов и старых Docker-образов
CLEANUP_CONTENT="#!/usr/bin/env bash
# Автоматическая очистка логов, временных файлов, бэкапов и неиспользуемых Docker-артефактов на CP.
set -euo pipefail

MODE=\"\${1:---deploy}\"
PEREVAL_DIR=\"\${PEREVAL_DIR:-${PEREVAL_DIR}}\"
BACKUP_DIR=\"\${BACKUP_DIR:-${BACKUP_DIR}}\"
VAR_LOG_DIR=\"\${VAR_LOG_DIR:-${VAR_LOG_DIR}}\"
LOGROTATE_CONF=\"\${LOGROTATE_CONF:-${LOGROTATE_CONF}}\"
LOG_KEEP_DAYS=\"\${LOG_KEEP_DAYS:-${LOG_KEEP_DAYS}}\"
JOURNAL_MAX_USE=\"\${JOURNAL_MAX_USE:-${JOURNAL_MAX_USE}}\"

BACKUP_KEEP_DAYS=14
BACKUP_MAX_FILES=20
BACKUP_KEEP_COUNT=7
if [[ -f \"\$PEREVAL_DIR/.env\" ]]; then
	val=\$(grep -E '^BACKUP_KEEP_DAYS=[0-9]+\$' \"\$PEREVAL_DIR/.env\" | tail -n 1 | cut -d= -f2 || true)
	[[ -n \$val ]] && BACKUP_KEEP_DAYS=\"\$val\"
	val=\$(grep -E '^BACKUP_MAX_FILES=[0-9]+\$' \"\$PEREVAL_DIR/.env\" | tail -n 1 | cut -d= -f2 || true)
	[[ -n \$val ]] && BACKUP_MAX_FILES=\"\$val\"
	val=\$(grep -E '^BACKUP_KEEP_COUNT=[0-9]+\$' \"\$PEREVAL_DIR/.env\" | tail -n 1 | cut -d= -f2 || true)
	[[ -n \$val ]] && BACKUP_KEEP_COUNT=\"\$val\"
fi

# 1) Журнал systemd и ротация текстовых логов
if command -v journalctl >/dev/null 2>&1; then
	journalctl --vacuum-time=\"\${LOG_KEEP_DAYS}d\" --vacuum-size=\"\$JOURNAL_MAX_USE\" >/dev/null 2>&1 || true
fi
if command -v logrotate >/dev/null 2>&1 && [[ -f \"\$LOGROTATE_CONF\" ]]; then
	logrotate \"\$LOGROTATE_CONF\" >/dev/null 2>&1 || true
fi
log_mtime=\$((LOG_KEEP_DAYS > 0 ? LOG_KEEP_DAYS - 1 : 0))
if [[ -d \"\$VAR_LOG_DIR\" ]]; then
	find \"\$VAR_LOG_DIR\" -maxdepth 2 -type f \\( -name '*.gz' -o -name '*.[0-9]' -o -name '*.[0-9][0-9]' -o -name '*.old' \\) -mtime +\"\$log_mtime\" -delete 2>/dev/null || true
fi

# 2) Локальные бэкапы (/var/backups/pereval): осиротевшие tmp, полные архивы сверх BACKUP_KEEP_COUNT и устаревшие дампы
if [[ -d \"\$BACKUP_DIR\" ]]; then
	find \"\$BACKUP_DIR\" -maxdepth 1 -type f \\( -name '*.tmp' -o -name '*.tmp.*' \\) -mmin +120 -delete 2>/dev/null || true
	if [[ \"\$BACKUP_KEEP_COUNT\" -gt 0 ]]; then
		idx=0
		for f in \$(ls -1 \"\$BACKUP_DIR\"/pereval-cp-*.tar.gz 2>/dev/null | sort -r); do
			idx=\$((idx + 1))
			if [[ \"\$idx\" -gt \"\$BACKUP_KEEP_COUNT\" ]]; then
				rm -f \"\$f\"
			fi
		done
	fi
	bkp_mtime=\$((BACKUP_KEEP_DAYS > 0 ? BACKUP_KEEP_DAYS - 1 : 0))
	find \"\$BACKUP_DIR\" -maxdepth 1 -type f -name 'pereval-*.dump' -mtime +\"\$bkp_mtime\" -delete 2>/dev/null || true
	if [[ \"\$BACKUP_MAX_FILES\" -gt 0 ]]; then
		idx=0
		for f in \$(ls -1t \"\$BACKUP_DIR\"/pereval-*.dump 2>/dev/null); do
			idx=\$((idx + 1))
			if [[ \"\$idx\" -gt \"\$BACKUP_MAX_FILES\" ]]; then
				rm -f \"\$f\"
			fi
		done
	fi
fi

# 3) Временные файлы деплоя и DNS-01 в /opt/pereval
if [[ -d \"\$PEREVAL_DIR\" ]]; then
	find \"\$PEREVAL_DIR\" -maxdepth 1 -type f -name '.env.tmp*' -mmin +60 -delete 2>/dev/null || true
	if [[ -d \"\$PEREVAL_DIR/dns01\" ]]; then
		# records.txt нужен не дольше ожидания certbot (48 ч)
		find \"\$PEREVAL_DIR/dns01\" -maxdepth 1 -type f -name 'records.txt' -mtime +2 -delete 2>/dev/null || true
		find \"\$PEREVAL_DIR/dns01\" -maxdepth 1 -type f -mtime +\"\$log_mtime\" -delete 2>/dev/null || true
	fi
fi

# 4) Системные временные файлы и кэш пакетов (только в реальном окружении без переопределённого PEREVAL_DIR или по расписанию)
if [[ \"\$MODE\" == \"--scheduled\" ]]; then
	if command -v systemd-tmpfiles >/dev/null 2>&1; then
		systemd-tmpfiles --clean >/dev/null 2>&1 || true
	fi
	if command -v apt-get >/dev/null 2>&1; then
		apt-get clean >/dev/null 2>&1 || true
	fi
	if command -v docker >/dev/null 2>&1; then
		docker container prune -f --filter \"until=24h\" >/dev/null 2>&1 || true
		docker image prune -af --filter \"until=24h\" >/dev/null 2>&1 || true
		docker builder prune -af --filter \"until=24h\" >/dev/null 2>&1 || true
	fi
fi
"

write_if_changed "$CLEANUP_BIN" 0755 "$CLEANUP_CONTENT" || true

BACKUP_WRAPPER_CONTENT="#!/usr/bin/env bash
set -euo pipefail
exec ${PYTHON_BIN:-python3} ${PEREVAL_DIR}/deploy/cp_backup.py --pereval-dir \"${PEREVAL_DIR}\" --backup-dir \"${BACKUP_DIR}\" backup \"\$@\"
"
write_if_changed "$BACKUP_BIN" 0755 "$BACKUP_WRAPPER_CONTENT" || true

SERVICE_CONTENT="[Unit]
Description=Pereval CP disk & log cleanup
After=network.target

[Service]
Type=oneshot
ExecStart=${CLEANUP_BIN} --scheduled
"

TIMER_CONTENT="[Unit]
Description=Daily Pereval CP disk & log cleanup

[Timer]
OnCalendar=daily
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
"

BACKUP_SERVICE_CONTENT="[Unit]
Description=Pereval CP full backup & S3 upload
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${BACKUP_BIN}
"

BACKUP_TIMER_CONTENT="[Unit]
Description=Daily Pereval CP backup to S3

[Timer]
OnCalendar=daily
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
"

unit_changed=0
if write_if_changed "$SYSTEMD_UNIT_DIR/pereval-cp-cleanup.service" 0644 "$SERVICE_CONTENT"; then
	unit_changed=1
fi
if write_if_changed "$SYSTEMD_UNIT_DIR/pereval-cp-cleanup.timer" 0644 "$TIMER_CONTENT"; then
	unit_changed=1
fi
if write_if_changed "$SYSTEMD_UNIT_DIR/pereval-cp-backup.service" 0644 "$BACKUP_SERVICE_CONTENT"; then
	unit_changed=1
fi
if write_if_changed "$SYSTEMD_UNIT_DIR/pereval-cp-backup.timer" 0644 "$BACKUP_TIMER_CONTENT"; then
	unit_changed=1
fi

if [[ -n $SYSTEMCTL_BIN && -x $SYSTEMCTL_BIN ]] && { [[ -d /run/systemd/system ]] || [[ ${PEREVAL_FORCE_SYSTEMCTL:-0} == 1 ]]; }; then
	if ((unit_changed)); then
		"$SYSTEMCTL_BIN" daemon-reload >/dev/null 2>&1 || true
	fi
	"$SYSTEMCTL_BIN" enable --now pereval-cp-cleanup.timer >/dev/null 2>&1 || true
	if ! "$SYSTEMCTL_BIN" is-enabled pereval-cp-backup.timer >/dev/null 2>&1 || ! "$SYSTEMCTL_BIN" is-active pereval-cp-backup.timer >/dev/null 2>&1; then
		warn "pereval-cp-backup.timer не включён или не активен — включаем автоматически"
		"$SYSTEMCTL_BIN" enable --now pereval-cp-backup.timer >/dev/null 2>&1 || true
	fi
fi

# Выполняем безопасную очистку файлов/логов/бэкапов сразу при деплое
"$CLEANUP_BIN" --deploy
say "CP maintenance: cleanup и backup-таймеры настроены (pereval-cp-cleanup.timer, pereval-cp-backup.timer)"
