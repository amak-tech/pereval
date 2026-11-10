#!/usr/bin/env bash
# Хостовый cron на VPS pereval.top: копирует дампы Postgres на Free Primary (или любой другой хост).
#   0 5 * * * /opt/pereval/deploy/backup-offsite.sh >> /var/log/pereval-backup.log 2>&1
# Требует ключ без пароля для пользователя на целевом хосте и каталог /var/backups/pereval-offsite там.
set -euo pipefail
TARGET="${BACKUP_TARGET:-root@153.80.200.170:/var/backups/pereval-offsite/}"
SRC="/var/backups/pereval/"
rsync -az --delete --include 'pereval-*.dump' --exclude '*' "$SRC" "$TARGET"
echo "[$(date -u +%FT%TZ)] offsite ok -> $TARGET"
