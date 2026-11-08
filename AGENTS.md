# AGENTS.md — Перевал (`sutton`): архитектура и правила для разработчиков и агентов

Документ описывает, как устроен **Перевал** (сайт `https://pereval.top`, репозиторий `sutton` / `pereval`): назначение, топологию, сборку, компоненты, деплой и правила внесения изменений.

---

## 1. Назначение

**Перевал** — Smart DNS и прозрачный SNI/HTTP-прокси без клиента. DNS отдаёт для доменов из фиксированного списка IP прокси-ноды; nginx на ноде читает SNI из `ClientHello` и сращивает TCP-сессию с настоящим origin, **не терминируя TLS**. Всё, чего нет в списке, резолвится и идёт напрямую через провайдера пользователя.

Два продукта:
- **Free** — ИИ-сервисы и инструменты разработки (категории `ai`, `dev` в `services.yaml`), кластер Primary `153.80.200.170` + воркеры, DNS-имена `free.pereval.top` и устаревшее `pereval.portbuddy.tech` (работает бессрочно для старых профилей).
- **Pro** — подписка (lava.top, MONTHLY, RUB/USD): все категории Free + `media`, `social`, `apps`, `games`; отдельная DNS-нода `pro.pereval.top` с персональными токенами и отдельные прокси-воркеры, закрытые nftables-ACL по IP подписчиков. Личный кабинет, биллинг и API — на `pereval.top`.
- **Dedicated** (задел): нода = один арендатор + свои домены; control plane уже хранит `nodes.tenant_user_id`, агент воркера умеет применять `extra_domains` из `/api/internal/v1/node/config`.

Юридическая позиция: не средство обхода блокировок РКН/Мининформа, строго фиксированный allowlist незапрещённых зарубежных платформ; прокси — закрытый релей (неизвестный SNI → `127.0.0.1:9`, неизвестный Host → 403).

---

## 2. Топология

```
Клиент (RU/BY)
 │ DNS: free.pereval.top / pereval.portbuddy.tech (Free)  |  <token>.pro.pereval.top, https://pro.pereval.top/dns/<token>, IP (Pro)
 │ HTTPS/HTTP: к IP воркера своего пула
 ▼
┌─ Free Primary 153.80.200.170 ───────────┐  ┌─ Free worker(s) ────────┐
│ dnsmasq :53 (address=/домен/IP воркера) │  │ nginx stream :443 / :80 │
│ nginx stream :443 (SNI→8443 или origin) │  │ прямой выход на origin  │
│ nginx :8443 /dns-query→doh_proxy :8053  │  │ doh_proxy, stats        │
│ nginx :853 DoT→dnsmasq; страницы→301    │  └─────────────────────────┘
│ healthcheck.py (пулы, failover), stats  │
└─────────────────────────────────────────┘
┌─ pereval.top (control plane, Docker Compose) ─────────────────────────────┐
│ nginx(+certbot) → app (Next.js: лендинг, кабинет, API) → Postgres 16     │
│ jobs (outbox почты, ACL-expiry, DDNS, сверка подписок, certwatch, дайджест)│
│ backup (pg_dump) ; LISTEN/NOTIFY: pereval_policy, pereval_acl              │
└───────────────────────────────────────────────────────────────────────────┘
┌─ pro.pereval.top (pro-dns) ─────────────────┐  ┌─ Pro worker(s) ──────────────────┐
│ pro_dns.py :53 (по IP) / :853 DoT (SNI) /   │  │ nginx stream :443 / :80 (allow-  │
│   DoH 127.0.0.1:8057 за nginx :443 (wildcard)│  │   карты Free+Pro + extra-*.map)  │
│ политика long-poll ← CP; A = IP воркера пула │  │ nftables set pro_clients ←       │
│ dnsmasq 127.0.0.1:53 — кеш + резолвер ноды   │  │   pro_node_agent.py (long-poll ACL)│
└──────────────────────────────────────────────┘  └──────────────────────────────────┘
```

Ключевые решения:
1. **Пулы воркеров** (`src/poolrouting.py`): пул у сервиса > у категории > `default`; нода для сервиса выбирается rendezvous-хэшем по здоровым нодам пула — все домены сервиса идут с одного IP, при отказе ноды пересаживается минимум сервисов. Пустой пул → `fallback` → Primary (Free) / все ноды (Pro).
2. **Pro-доступ на уровне DNS**: токен (DoH-путь / DoT-SNI) или привязанный IP. IP, с которых приходят запросы подписчиков, попадают в динамический ACL (2 ч) и уезжают на воркеры long-poll'ом (<1 с). Истёкшая подписка → `plain` (обычный резолв без прокси), а не отказ: Android strict / iOS-профиль не имеют fallback-DNS.
3. **Один writer состояния — control plane** (Postgres). `pro_dns.py` и агенты — stateless-клиенты CP по HTTPS с bearer-секретом, кешируют политику на диске.
4. **DNS-петля**: nginx и ОС на DNS/прокси-нодах никогда не используют 127.0.0.1 как резолвер (кроме pro-dns, где локальный dnsmasq — чистый кеш без `address=`); `resolver 1.1.1.1 8.8.8.8` в nginx.
5. `filter-AAAA` и `filter-rr=HTTPS,SVCB` в dnsmasq (Free) и NODATA на AAAA/HTTPS/SVCB в `pro_dns.py` — иначе клиенты уйдут по IPv6/ECH мимо прокси. UDP/443 на воркерах — reject (QUIC не проксируется).

---

## 3. Структура репозитория

```
services.yaml          ЕДИНЫЙ ИСТОЧНИК: meta, free, nodes (пулы, воркеры), dnsmasq_options, categories, disabled, passthrough, pro
deploy.sh              деплой DNS/прокси-нод по SSH: роли primary | worker | pro-dns | pro-worker, --all, --pro, --dry-run
src/
  generate.py          сборка build/ из services.yaml и templates/, экспорт web/src/generated/services.json, --check
  poolrouting.py       пулы: rendezvous-хэш, fallback-цепочки, рендер nginx-workers по пулам (stdlib)
  dnscommon.py         общий DNS/HTTP-код: wire-парсер, UdpDnsPool, HTTP/1.1 сервер/клиент, hash_ip (stdlib)
  doh_proxy.py         Free DoH (pereval-doh.service), импортирует dnscommon
  healthcheck.py       Free: пробы воркеров, пулы, переписывание dnsmasq/nginx-workers, fail-open (pereval-healthcheck.service)
  stats_collector.py   телеметрия nginx-логов → node-stats.json / stats.json (pereval-stats.service)
  pro_dns.py           Pro DNS-демон: :53 по IP, DoT :853 (SNI-токен), DoH за nginx, политика из CP (pereval-pro-dns.service)
  pro_node_agent.py    Pro-воркер: nftables set pro_clients ← ACL из CP, extra-домены Dedicated (pereval-pro-agent.service)
  update_hosts.py      клиентская утилита /etc/hosts (macOS/Linux)
templates/
  dnsmasq/dnsmasq.conf           → build/dnsmasq-geoblock.conf (Free)
  dnsmasq/cache-dnsmasq.conf     → build/cache-dnsmasq.conf (pro-dns: кеш на 127.0.0.1:53)
  nginx/nginx.conf               → build/nginx.conf (Free Primary/worker; оба DNS-имени, 301 страниц на сайт)
  nginx/nginx-*-allow.map        → build/nginx-*-allow.map (Free) и build/pro-nginx-*-allow.map (Free+Pro)
  nginx/nginx-workers-*.conf     → build/nginx-workers-*.conf (upstream на пул + map домен→пул)
  nginx/pro-dns-nginx.conf       → build/pro-dns-nginx.conf
  nginx/pro-worker-nginx.conf    → build/pro-worker-nginx.conf
tests/                 unittest: poolrouting/healthcheck, dnscommon, pro_dns, pro_node_agent (python3 -m unittest discover -s tests)
web/                   control plane (Next.js 16, React 19, TypeScript, Tailwind v4, Drizzle + Postgres, Auth.js v5)
  src/app/             страницы (/, /pro, /dedicated, /stats, /terms, /privacy, /account/*), API (/api/*), /nic/update, /dns.mobileconfig
  src/lib/             env, db (schema, client), auth, billing, lava, lava-webhook, policy, acl, account, ddns, leads, mail, ...
  src/jobs/            фоновый процесс (outbox, acl-expire, ddns, reconcile, certwatch, digest, retention)
  src/generated/services.json   каталог из services.yaml (коммитится; свежесть проверяет generate.py --check)
  scripts/             admin.ts (CLI), migrate.ts, lava-mock-webhook.ts
  deploy/              nginx, certbot, backup, docker-entrypoint, .env.example ; compose.yaml ; Dockerfile
build/                 выход generate.py (gitignored)
.github/workflows/     deploy.yml (ноды), web.yml (сайт: lint/test/build → GHCR → compose на pereval.top), release.yml
```

Старые статические страницы (`templates/web/*`) удалены: лендинг и профили Apple теперь отдаёт `web/`.

---

## 4. `services.yaml` и `src/generate.py`

### 4.1. Модель
- `meta.name`, `meta.origin` (`https://pereval.top` — сайт/кабинет/API).
- `free.domain` (`free.pereval.top`) и `free.legacy_domains` (`pereval.portbuddy.tech`): все имена попадают в `server_name`, в SNI-map (→ 8443) и в `certbot -d` на Primary.
- `nodes`: `primary`, `include_primary_in_dns`, `probe_sni`, `pools` (`{name: {note, fallback, strict_allowlist}}`), `workers` (`ip, name, weight, pools[], ssh_*`).
- `dnsmasq_options`: строки опций dnsmasq для Free.
- `categories[]`: `id` (slug), `name`, `pool`, `services[]` (`name`, `pool?`, `domains[]`). Поддомены покрываются автоматически.
- `disabled[]`, `passthrough`: как раньше (закомментированные домены; российские домены, которые нельзя проксировать).
- `pro`: `domain`, `dns_ip`, `cp_ip`, `pools`, `workers`, `categories[]` (тот же формат, tier=pro). Адреса из `203.0.113.0/24` считаются заглушками (предупреждение).

### 4.2. Валидация (`validate`)
Ошибки: невалидные домены/IP, дубли доменов (включая между Free и Pro), пересечения с `passthrough`, неизвестный пул у категории/сервиса/воркера, пул без воркеров, цикл `fallback`, дубль `id` категории, `pro` без `domain/dns_ip/workers`. Предупреждения: IP-подобные домены, покрытые поддомены, пустые категории, адреса-заглушки.

### 4.3. Выходы
`build/`: `dnsmasq-geoblock.conf`, `nginx.conf`, `nginx-sni-allow.map`, `nginx-host-allow.map`, `nginx-workers-stream.conf`, `nginx-workers-http.conf`, `service-map.json` (домен → service/category/category_id/tier/pool), `cluster-nodes.json` (+ `free_domains`, `site_origin`, `pools`), `pro-dns-nginx.conf`, `pro-worker-nginx.conf`, `pro-nginx-sni-allow.map`, `pro-nginx-host-allow.map`, `cache-dnsmasq.conf`, `pro-policy-map.json`, `pro-nodes.json`, `pro-service-map.json`, опционально `nginx-*-allow.<pool>.map` для пулов со `strict_allowlist`. Плюс `web/src/generated/services.json`.

```bash
python3 src/generate.py services.yaml 153.80.200.170 --check   # данные, шаблоны, свежесть services.json
python3 src/generate.py services.yaml 153.80.200.170           # полная сборка
python3 -m unittest discover -s tests
```

Плейсхолдеры шаблонов: `{{name}} {{ip}} {{origin}} {{site_domain}} {{domain}} {{free_domain}} {{free_domains}} {{free_server_names}} {{free_sni_targets}} {{certbot_domains}} {{pro_domain}} {{pro_dns_ip}} {{cp_ip}} {{date}} {{source}} {{total}} {{category_count}} {{service_count}} {{options}} {{body}} {{disabled}} {{passthrough_note}} {{passthrough}} {{sni_entries}} {{host_entries}} {{workers_stream_body}} {{workers_http_body}}`; для Pro-шаблонов дополнительно `{{pro_worker_ips}} {{pro_worker_ips_nft}} {{trusted_probe_ips_nft}}`. Новый плейсхолдер → добавить в `build_values()` / `pro_values()`.

---

## 5. Демоны и утилиты (Python, только stdlib)

- **`doh_proxy.py`** (`pereval-doh.service`, 127.0.0.1:8053): RFC 8484 DoH за nginx, fork-пул воркеров, `UdpDnsPool` к dnsmasq с TCP-fallback. Общий код — в `dnscommon.py` (должен лежать в `/usr/local/lib/pereval/`).
- **`healthcheck.py`** (`pereval-healthcheck.service`, Primary): пробы воркеров (TLS ClientHello + `/healthz`), гистерезис 2/2; переписывает `/etc/dnsmasq.conf` по пулам (`render_dnsmasq_conf_pooled`, домен → пул из `service-map.json`) и `nginx-workers-*.conf` (upstream на пул), `cluster-health.json`; все воркеры мертвы → fail-open на Primary.
- **`stats_collector.py`** (`pereval-stats.service`): без изменений формата; `service-map.json` теперь содержит `pool`.
- **`pro_dns.py`** (`pereval-pro-dns.service`, пользователь `pereval-dns` + `CAP_NET_BIND_SERVICE`): см. docstring файла. Режимы по политике: `proxy` (синтез A с IP воркера пула, NODATA на AAAA/HTTPS/SVCB, остальное — в dnsmasq), `plain` (всё в upstream с лимитом qps), `deny`. Новые IP → `POST /api/internal/v1/dns/activity` немедленно; активность — батчем с суточными хэшами IP. SIGHUP перечитывает сертификат и policy-map.
- **`pro_node_agent.py`** (`pereval-pro-agent.service`, root): гарантирует таблицу `inet pereval_pro` (set `pro_clients`, `iif lo accept`, trusted IPs, drop 80/443, reject udp/443), long-poll `GET /api/internal/v1/node/acl`, diff → одна транзакция `nft -f -`; CP недоступен >10 мин — ничего не удаляет; `node/config.extra_domains` → `extra-*-allow.map` + `nginx -s reload`.
- **`update_hosts.py`**: клиентская утилита, без изменений.

Правило: регэкспы логов в `stats_collector.py` связаны с `log_format sni/hostproxy` во всех nginx-шаблонах.

---

## 6. Control plane (`web/`)

- **Стек**: Next.js 16 App Router (`output: standalone`), React 19, TypeScript, Tailwind v4 (`@tailwindcss/turbopack`), Drizzle ORM + postgres.js, Auth.js v5 (`next-auth@beta`, Google + Nodemailer magic-link, database-сессии), zod, nodemailer, recharts, vitest. Node 22, pnpm 12.
- **Данные**: схема в `src/lib/db/schema.ts` (таблицы Auth.js + `users_meta`, `subscriptions` (чистый `period_end`, grace только при `past_due`), `invoices`, `webhook_events` (дедуп по sha256 тела), `access_tokens` (ротация с перекрытием 48 ч), `bound_ips` (`static | ddns_host | ddns_push`), `ddns_keys`, `user_policy`, `settings`, `token_activity`, `acl_dynamic`, `nodes`, `mail_outbox`, `leads`, `audit_log`). Миграции: `pnpm db:generate` → `src/lib/db/migrations`, применяются при старте контейнера (`scripts/migrate.ts`).
- **Биллинг** (`src/lib/billing.ts`, `lava.ts`, `lava-webhook.ts`): `POST /api/billing/checkout` → `POST /api/v2/invoice` lava.top (RUB→BANK131, USD→`LAVA_USD_METHOD`), return-URL `/account/pay?ref=`; вебхук `POST /api/billing/lava/webhook` (`X-Api-Key` = `LAVA_WEBHOOK_KEY`, IP allowlist `158.160.60.174` в режиме `log|enforce`), события `payment.success|failed`, `subscription.recurring.payment.success|failed`, `subscription.cancelled`, envelope `refund.success|chargeback.initiated`; письмо админу на каждое. Сверка `GET /api/v1/invoices/{id}` (jobs каждые 6 ч), отмена `DELETE /api/v1/subscriptions`. `LAVA_MOCK=1` — локальная эмуляция (`scripts/lava-mock-webhook.ts`, `POST /api/billing/mock/pay`).
- **Политика/ACL для нод** (`policy.ts`, `acl.ts`, `bus.ts`): версии в `settings`, уведомления Postgres `LISTEN/NOTIFY`; `GET /api/internal/v1/policy?version&wait=25`, `GET /api/internal/v1/node/acl?version&wait=25` (long-poll, 304 без изменений), `GET /api/internal/v1/node/config`, `POST /api/internal/v1/dns/activity`. Аутентификация нод — `Authorization: Bearer <secret>` (`nodes.secret_hash`), секрет выдаёт `pnpm admin node add <name> <kind> [ip]`.
- **Кабинет** (`/account`, `src/lib/account.ts`): статус подписки, персональные адреса, профиль Apple (`/api/account/dns.mobileconfig`, DoH), привязка IP/DDNS (`/api/account/ips`, DynDNS2 push `GET /nic/update` с Basic-auth email + DDNS-ключ), категории, ротация токена, отмена/продление.
- **Почта**: outbox в Postgres (`mail_outbox`), отправка из `jobs` с ретраями; шаблоны в `mail-templates.ts`.
- **Jobs** (`src/jobs/index.ts`): outbox 15 с, acl-expire 30 с, ddns 60 с, reconcile 6 ч, certwatch 12 ч (напоминания за 25/14/7/3 дня о wildcard-сертификате `*.pro.pereval.top`), digest ежедневно 08:00 МСК, retention сутки.
- **Безопасность**: реальный IP только из `X-Real-IP` от nginx compose; CSRF — проверка `Origin`; rate-limit в nginx (`limit_req`) и в приложении; кабинет и API `noindex`.
- **Команды**: `pnpm dev | build | typecheck | lint | test | db:generate | admin <cmd> | lava:mock`. Docker: `web/Dockerfile` (стадии deps → build → runner; `dist/*.mjs` для jobs/admin/migrate), `web/compose.yaml` (nginx, certbot, app, jobs, postgres, backup). Деплой — `.github/workflows/web.yml` (образ в GHCR → SSH → `docker compose pull && up -d`), секреты `CP_HOST`, `CP_SSH_USER`, `CP_SSH_KEY`; `.env` на сервере из `web/deploy/.env.example`.

---

## 7. Деплой нод (`deploy.sh`)

```bash
./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 root            # Free: воркеры, затем primary
./deploy.sh 153.80.200.170 ~/.ssh/id_ed25519 root --pro      # Pro: pro-dns (pro.dns_ip), затем pro-воркеры
./deploy.sh <ip> ~/.ssh/id_ed25519 root --role pro-worker    # одна нода
```

- Манифесты файлов по ролям (`LIB_FILES`, `FREE_FILES`, `PRO_DNS_FILES`, `PRO_WORKER_FILES`); домены — из `cluster-nodes.json` / `pro-nodes.json`.
- Primary/worker (`apply.sh`): пакеты, sysctl, `poolrouting.py`/`dnscommon.py` в `/usr/local/lib/pereval/`, удаление старой статики сайта и `pereval-leads.service`, certbot с `-d` на все имена Free (`--expand`), проверки портов 80/443/853/8053.
- pro-dns (`apply-pro.sh`): пользователь `pereval-dns`, `/etc/pereval/{node.env,pro-policy-map.json,ssl/}`, dnsmasq-кеш на 127.0.0.1:53 и `/etc/resolv.conf → 127.0.0.1`, nginx (DoH), `pereval-pro-dns.service`; сертификат — копия из `/etc/letsencrypt/live/pro.pereval.top` (deploy-hook `/etc/letsencrypt/renewal-hooks/deploy/pereval-pro-dns.sh`) или временный самоподписанный. **Wildcard выпускается вручную**: `certbot certonly --manual --preferred-challenges dns -d pro.pereval.top -d '*.pro.pereval.top' --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/pereval-pro-dns.sh`; `certbot.timer` отключён.
- pro-worker: карты → `/etc/nginx/geoblock/nginx-*-allow.map` (+ пустые `extra-*-allow.map`), `cluster-nodes.json` для stats, nftables `/etc/nftables.d/pereval-pro.nft` (include в `/etc/nftables.conf`), `pereval-pro-agent.service`, `pereval-stats.service`.
- Секреты нод: `PRO_DNS_SECRET`, `PRO_WORKER_SECRET` в окружении → `/etc/pereval/node.env` (`CP_ORIGIN`, `NODE_SECRET`, `PRO_DNS_IP`, `PRO_DOMAIN`, `TRUSTED_IPS`).
- CI: `.github/workflows/deploy.yml` (release → Free; `deploy_pro=true` → и Pro).

### Ручные шаги при вводе инфраструктуры
1. DNS-записи: `pereval.top`, `www.pereval.top` → CP VPS; `free.pereval.top` → 153.80.200.170; `pro.pereval.top` и `*.pro.pereval.top` → pro-dns VPS.
2. lava.top: продукт-подписка «Перевал Pro» с ценами MONTHLY в RUB и USD → `LAVA_OFFER_ID_PRO`, `LAVA_PRODUCT_ID_PRO`; API-ключ → `LAVA_API_KEY`; вебхук на `https://pereval.top/api/billing/lava/webhook` с методом «API key» → `LAVA_WEBHOOK_KEY`.
3. Google Cloud Console: OAuth-клиент с redirect `https://pereval.top/api/auth/callback/google` → `AUTH_GOOGLE_ID/SECRET`.
4. На CP VPS: `/opt/pereval/.env` из `web/deploy/.env.example`, `docker compose up -d`; `pnpm admin node add pro-dns pro_dns <ip>` и `... pro-worker-1 pro_worker <ip>` → секреты в GitHub Secrets.
5. Wildcard-сертификат на pro-dns (см. выше), затем `./deploy.sh ... --pro`.
6. Search Console: добавить `pereval.top`, отправить `https://pereval.top/sitemap.xml`.

---

## 8. Правила для агентов и контрибьюторов

1. **Не править `build/`** — только `services.yaml`, `templates/`, `src/`, затем `generate.py`. `web/src/generated/services.json` тоже генерируется (но коммитится).
2. **Домены**: проверять покрытие родительским доменом; не добавлять широкие общие домены (`google.com`, `googleapis.com`, `cloudflare.com`); числовые домены — в кавычках; после правок — `--check` и полная сборка; Pro-домены — в `pro.categories`, с пулом.
3. **Пулы**: новый воркер — в `nodes.workers`/`pro.workers` с `pools`; новая категория/сервис — с `pool` при необходимости; каждый объявленный пул должен иметь воркера (иначе ошибка сборки).
4. **Шаблоны**: `{{placeholder}}`; новый плейсхолдер → `build_values()`; шаблоны самодостаточны.
5. **Python-демоны**: только stdlib, Python 3.9+; `dnscommon.py`/`poolrouting.py` ищутся рядом с файлом и в `/usr/local/lib/pereval`; файлы, читаемые nginx, писать атомарно (`Path.replace`).
6. **web/**: перед коммитом `pnpm typecheck && pnpm lint && pnpm test`; миграции через `pnpm db:generate` (не править SQL руками); секреты только через env; письма — через `mail_outbox`; все мутации с проверкой `Origin`; IP клиента — только `clientIp()`.
7. **Контракт нод ↔ CP** (`/api/internal/v1/*`) менять синхронно в `web/src/app/api/internal` и `src/pro_dns.py` / `src/pro_node_agent.py` с тестами.
