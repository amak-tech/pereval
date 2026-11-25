#!/bin/sh
# Ежедневный pg_dump в /backups (том /var/backups/pereval на хосте), хранение BACKUP_KEEP_DAYS дней
# (и не более BACKUP_MAX_FILES файлов). При рестарте контейнера не создаёт дубликат, если свежий дамп уже есть.
# Оффсайт-копию (rsync --delete на Primary) делает хостовый cron — см. deploy/backup-offsite.sh.
BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
MAX_FILES="${BACKUP_MAX_FILES:-20}"
INTERVAL="${BACKUP_INTERVAL_SEC:-86400}"
MIN_INTERVAL="${BACKUP_MIN_INTERVAL_SEC:-72000}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"

prune_backups() {
  rm -f "$BACKUP_DIR"/pereval-*.dump.tmp
  mtime_arg=$((KEEP > 0 ? KEEP - 1 : 0))
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'pereval-*.dump' -mtime +"$mtime_arg" -delete 2>/dev/null || true
  if [ "$MAX_FILES" -gt 0 ] 2>/dev/null; then
    idx=0
    for f in $(ls -1t "$BACKUP_DIR"/pereval-*.dump 2>/dev/null); do
      idx=$((idx + 1))
      if [ "$idx" -gt "$MAX_FILES" ]; then
        rm -f "$f"
      fi
    done
  fi
}

trap 'exit 0' TERM INT
mkdir -p "$BACKUP_DIR"
rm -f "$BACKUP_DIR"/pereval-*.dump.tmp

while :; do
  latest=$(ls -1t "$BACKUP_DIR"/pereval-*.dump 2>/dev/null | head -n 1 || true)
  now=$(date +%s)
  sleep_sec="$INTERVAL"
  skip=0
  if [ -n "$latest" ] && [ -s "$latest" ]; then
    mtime=$(stat -c %Y "$latest" 2>/dev/null || stat -f %m "$latest" 2>/dev/null || echo 0)
    age=$((now - mtime))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$MIN_INTERVAL" ]; then
      skip=1
      sleep_sec=$((INTERVAL - age))
      echo "[backup] свежий дамп уже есть ($latest, ${age}s назад), следующий через ${sleep_sec}s"
    fi
  fi

  if [ "$skip" -eq 0 ]; then
    ts=$(date -u +%Y%m%d-%H%M%S)
    if "$PG_DUMP_BIN" -h "${PGHOST:-postgres}" -U "${PGUSER:-pereval}" -d "${PGDATABASE:-pereval}" -Fc -f "$BACKUP_DIR/pereval-$ts.dump.tmp"; then
      mv "$BACKUP_DIR/pereval-$ts.dump.tmp" "$BACKUP_DIR/pereval-$ts.dump"
      echo "[backup] ok $BACKUP_DIR/pereval-$ts.dump"
    else
      rm -f "$BACKUP_DIR/pereval-$ts.dump.tmp"
      echo "[backup] pg_dump failed"
    fi
  fi

  prune_backups
  [ "${BACKUP_ONCE:-0}" = "1" ] && exit 0
  sleep "$sleep_sec" & wait $!
done
