#!/bin/sh
# Ежедневный pg_dump в /backups (том /var/backups/pereval на хосте), хранение BACKUP_KEEP_DAYS дней.
# Оффсайт-копию (rsync на Primary) делает хостовый cron — см. deploy/backup-offsite.sh.
KEEP="${BACKUP_KEEP_DAYS:-30}"
trap 'exit 0' TERM INT
while :; do
  ts=$(date -u +%Y%m%d-%H%M%S)
  if pg_dump -h postgres -U pereval -d pereval -Fc -f "/backups/pereval-$ts.dump.tmp"; then
    mv "/backups/pereval-$ts.dump.tmp" "/backups/pereval-$ts.dump"
    echo "[backup] ok /backups/pereval-$ts.dump"
  else
    rm -f "/backups/pereval-$ts.dump.tmp"
    echo "[backup] pg_dump failed"
  fi
  find /backups -name 'pereval-*.dump' -mtime +"$KEEP" -delete
  sleep 86400 & wait $!
done
