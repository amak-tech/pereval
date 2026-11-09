#!/bin/sh
# app  — миграции + Next.js сервер
# jobs — фоновые задачи
# admin <cmd> — админ-CLI
set -e
case "${1:-app}" in
  app)
    node dist/migrate.mjs
    exec node server.js
    ;;
  jobs)
    exec node dist/index.mjs
    ;;
  migrate)
    exec node dist/migrate.mjs
    ;;
  admin)
    shift
    exec node dist/admin.mjs "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
