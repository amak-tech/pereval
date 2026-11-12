# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Подробная архитектура, модель `services.yaml`, контракт нод ↔ control plane и правила правок — в **AGENTS.md** (загружается вместе с этим файлом; не дублируется здесь). Ниже — то, что нужно для быстрого старта и что легко сломать.

## Что это

Два слоя в одном репозитории:

- **Корень (`services.yaml`, `src/*.py`, `templates/`, `deploy.sh`)** — Smart DNS + SNI-прокси для Free/Pro нод. Python только stdlib (3.9+), генератор конфигов `src/generate.py` собирает `build/` (gitignored) из единого источника `services.yaml`.
- **`web/`** — control plane `pereval.top`: Next.js 16 App Router (лендинг, кабинет `/account`, админка `/admin`, API), Drizzle + Postgres 16, Auth.js v5, биллинг lava.top, фоновый процесс `jobs`. Docker Compose на сервере.

## Команды

### Ноды (корень)

```bash
python3 src/generate.py services.yaml 153.80.200.170 --check   # валидация данных и шаблонов
python3 src/generate.py services.yaml 153.80.200.170           # полная сборка build/ + web/src/generated/services.json
python3 -m unittest discover -s tests                          # все тесты
python3 -m unittest tests.test_pro_dns                         # один модуль
python3 -m unittest tests.test_poolrouting.RendezvousTests.test_minimal_reshuffle_when_node_dies   # один тест
./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 root [--pro | --role pro-worker | --dry-run]
```

После любой правки `services.yaml` или `templates/` — `--check` (в CI `web.yml` каталог `web/src/generated/services.json` генерируется автоматически).

### Control plane (`web/`, pnpm 12, Node 22)

```bash
pnpm dev                       # localhost:3000; .env из deploy/.env.example (LAVA_MOCK=1 — без lava.top)
pnpm typecheck && pnpm lint && pnpm test   # обязательно перед коммитом
pnpm exec vitest run tests/admin.test.ts   # один файл тестов
pnpm exec vitest run -t "grantPeriodEnd"   # по имени теста
pnpm build                     # next build + esbuild-бандлы jobs/admin/migrate в dist/
pnpm build:jobs                # только бандлы (быстрая проверка, что lib-модули не тянут next)
pnpm db:generate               # миграция после правки src/lib/db/schema.ts (SQL руками не править)
pnpm admin <cmd>               # CLI: users | subs | grant | revoke | node add/list | resend-link | webhook replay | cert | policy | acl
pnpm lava:mock payment.success <invoiceId> <email>   # эмуляция вебхука на локальный сервер
```

Тесты — vitest, `tests/*.test.ts`, окружение задаётся в `vitest.config.mts` (без БД: тестируются чистые функции).

### Релиз и деплой

- Push тега → `release.yml` создаёт релиз → `deploy.yml` раскатывает Free-ноды (`deploy_pro=true` — и Pro).
- Push в `main`/`pro` с изменениями в `web/` → `web.yml`: lint/test/build → образ в GHCR → `docker compose pull && up -d` на CP. Секреты приложения живут в GitHub Secrets и переписываются в `/opt/pereval/.env` при каждом деплое.

## Неочевидное, что легко сломать

- **`build/` и `web/src/generated/services.json` не править** — оба gitignored и собираются `src/generate.py`.
- **Бандлы для чистого Node** (`src/jobs/index.ts`, `scripts/admin.ts`, `scripts/migrate.ts`) собираются esbuild'ом: всё, что они импортируют из `src/lib/*`, не должно тянуть `next/*` или `next-auth`. Поэтому пары `auth.ts` / `auth-core.ts`, `admin-auth.ts` / `admin.ts`, `http.ts` без `next/server`. Проверка — `pnpm build:jobs` плюс `node dist/admin.mjs`.
- **Клиентские компоненты** (`"use client"`) не импортируют модули с БД (`@/lib/db/client`, `@/lib/admin`, `@/lib/billing`) — Turbopack затащит postgres в браузерный бандл. Константы для клиента — в отдельных модулях (`admin-constants.ts`); типы — через `import type`.
- **Мутации API**: `assertSameOrigin(req)` + `requireUser()` / `requireAdmin()`, IP клиента только через `clientIp()`; письма только через `enqueueMail` (outbox). Админ-действия — одна точка `POST /api/admin/action` с записью в `audit_log`.
- **Контракт нод ↔ CP** (`web/src/app/api/internal/v1/*` ↔ `src/pro_dns.py`, `src/pro_node_agent.py`, `src/cert_sync.py`) меняется синхронно с обеих сторон и с тестами.
- **Регэкспы логов** в `src/stats_collector.py` привязаны к `log_format sni/hostproxy` во всех nginx-шаблонах.
- **DNS-петля**: nginx и ОС на нодах никогда не используют `127.0.0.1` как резолвер; `filter-AAAA`/`HTTPS`/`SVCB` обязательны, иначе клиенты уйдут мимо прокси по IPv6/ECH.
- Новый плейсхолдер `{{...}}` в шаблоне → добавить в `build_values()` / `pro_values()` в `generate.py`; каждый объявленный пул должен иметь воркера.
- Адреса из `203.0.113.0/24` в `services.yaml` — заглушки (генератор предупреждает).
