<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./logos/logo-horizontal-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./logos/logo-horizontal-light.svg">
    <img alt="Перевал — Умный DNS-прокси в Казахстане" src="./logos/logo-horizontal-dark.svg" width="760">
  </picture>
</p>

# Перевал — Smart DNS для доступа к ChatGPT, Claude, Gemini и инструментам разработки без VPN

**Перевал** — это умный DNS-сервер (Smart DNS), который восстанавливает доступ к зарубежным ИИ-сервисам и инструментам разработки, ограничивающим российские и белорусские IP-адреса по геолокации, **без установки VPN-приложений**, без регистрации и без падения скорости интернета. Бесплатная версия покрывает ИИ и инструменты разработки; подписка **Перевал Pro** добавляет стриминги, соцсети, игры и отдельные быстрые серверы.

👉 **Сайт, пошаговые инструкции и личный кабинет:**  
**[https://pereval.top](https://pereval.top/?utm_source=github&utm_medium=readme&utm_campaign=pereval&utm_content=hero)**

💬 **Telegram-чат пользователей (помощь с настройкой и предложения новых доменов):**  
**[https://t.me/pereval_dns](https://t.me/pereval_dns)**

> Старый адрес `pereval.portbuddy.tech` продолжает работать для DNS-over-HTTPS и DNS-over-TLS — ранее установленные профили и настройки менять не нужно. Страницы сайта с него перенаправляются на `pereval.top`.

---

## Зачем нужен Перевал

Многие зарубежные нейросети, облачные платформы и инструменты разработки закрывают доступ по геолокации (ошибки *«Unavailable in your country»*, *«Access denied»*, *«Недоступно в вашем регионе»*).

Обычный VPN перенаправляет весь ваш трафик через чужой сервер — из-за этого падает скорость, растёт пинг, отваливаются локальные контейнеры и корпоративные сети, а российские сайты, банки и Госуслуги перестают открываться.

**Перевал решает эту проблему точечно:**
- **Работают только нужные сайты:** через прокси идут исключительно сервисы из фиксированного списка, которые ограничивают российские и белорусские IP-адреса со своей стороны.
- **Все остальные сайты открываются напрямую:** российские банки, Госуслуги, маркетплейсы, видео и торренты работают на полной скорости вашего провайдера.
- **Без программ и аккаунтов:** настройка занимает одну минуту в стандартных параметрах вашего устройства или роутера.
- **Безопасность данных:** HTTPS не расшифровывается — соединения остаются зашифрованными от вашего устройства до конечного сервиса.

---

## Бесплатная версия (Free)

Адреса бесплатного DNS:

| Способ | Адрес |
| :--- | :--- |
| Обычный DNS (роутер, ПК) | `153.80.200.170` |
| DNS-over-HTTPS (браузеры, Windows 11) | `https://free.pereval.top/dns-query` |
| DNS-over-TLS (Android «Частный DNS») | `free.pereval.top` |
| Профиль для iPhone / iPad / Mac | [pereval.top/dns.mobileconfig](https://pereval.top/dns.mobileconfig) |

Поддерживаются самые востребованные сервисы для работы с ИИ и разработки (список и поиск — на [сайте](https://pereval.top/?utm_source=github&utm_medium=readme&utm_campaign=pereval&utm_content=services)):

- **ИИ и языковые модели:** ChatGPT (OpenAI), Claude (Anthropic), Google Gemini, AI Studio, NotebookLM и Jules, Grok (xAI), Microsoft Copilot, Cursor, Windsurf / Codeium, OpenRouter, Groq, Lambda Labs, Lightning AI, Augment Code, Cline, Trae, Qoder, Manus, Genspark, Langdock, DeepL.
- **Инструменты разработки, SaaS и облака:** JetBrains, HashiCorp, Atlassian, Sentry, MongoDB, Redis, Neo4j, Liquibase, Grafana, Graylog, Snyk, PostHog, Amplitude, Pingdom, Buf, Spacelift, Algolia, GitGuardian, Swagger, Netlify, Heroku, Framer, ngrok, Tailscale, HTTP Toolkit, Oracle, Liberica JDK, Qt, Bitnami, NVIDIA Developer, Mattermost, Outline, ClickUp, Zapier.

---

## Перевал Pro — подписка

**[pereval.top/pro](https://pereval.top/pro)** — платная подписка (месяц, оплата в рублях или долларах через платёжный сервис lava.top):

- **Отдельные быстрые серверы** без вечерних перегрузок, маршрутизация по пулам: ИИ-сервисы — с постоянного IP, «тяжёлые» стриминги и соцсети — через отдельные ноды.
- **Расширенный каталог:** все сервисы Free + Spotify, Netflix, Twitch, Deezer, Tidal, TikTok, Reddit, Pinterest, Canva, Notion, Miro, Trello, Coursera, Duolingo, Supercell, Xbox, PlayStation, GeForce NOW и др.
- **Личный кабинет** ([pereval.top/account](https://pereval.top/account)): персональные адреса DoH (`https://pro.pereval.top/dns/<token>`) и DoT (`<token>.pro.pereval.top`), профиль для Apple в один клик, привязка IP для роутера, DDNS для динамических адресов (опрос имени или DynDNS2-push с роутера), включение и отключение категорий, вход по ссылке на email или через Google.
- **Перевал Dedicated** ([pereval.top/dedicated](https://pereval.top/dedicated)) — выделенный сервер со своим IP и собственными доменами для семьи или команды; сейчас принимаются заявки.

---

## Работа через `/etc/hosts` (`src/update_hosts.py`)

В репозитории доступен скрипт [`src/update_hosts.py`](./src/update_hosts.py), который автоматически прописывает домены бесплатной версии напрямую в системный файл `/etc/hosts` (на macOS и Linux) без изменения настроек DNS.

### Когда это полезно

- **Корпоративный VPN (Cloudflare WARP, Cisco AnyConnect, GlobalProtect и др.):** VPN-клиенты часто перехватывают DNS, но система продолжает учитывать `/etc/hosts`.
- **Кастомный или локальный DNS:** Tailscale MagicDNS, AdGuard, Pi-hole, локальный `dnsmasq` или корпоративный DNS, который нельзя заменять.
- **Быстрое включение и отключение одной командой.**

### Примеры

```bash
sudo python3 src/update_hosts.py            # установить или обновить записи
python3 src/update_hosts.py --dry-run       # показать блок без записи
sudo python3 src/update_hosts.py --remove   # удалить записи Перевала
sudo python3 src/update_hosts.py --ip 153.80.200.170 --services /path/to/services.yaml
```

Скрипт разворачивает домены второго уровня в частые поддомены (`www`, `api`, `auth`, `cdn`, …), держит записи между маркерами `# >>> PEREVAL START` / `# <<< PEREVAL END` и сбрасывает DNS-кэш macOS.

---

## Архитектура и масштабирование

- **Free-кластер:** основной узел `153.80.200.170` (DNS, DoH, DoT, сайт-редирект) + прокси-воркеры. `dnsmasq` отдаёт в ответах IP здоровых воркеров, демон `healthcheck.py` каждые 5 секунд проверяет их и переключает DNS/nginx при отказах (fail-open на основной узел).
- **Пулы воркеров:** в `services.yaml` воркеры объединяются в пулы (`default`, `ai`, `media`), а категориям и сервисам назначается пул. Все домены одного сервиса резолвятся в одну ноду пула (rendezvous-хэш), «тяжёлые» сервисы можно вынести на отдельные машины.
- **Pro:** DNS-нода `pro.pereval.top` (`src/pro_dns.py`: персональные токены, DoH/DoT, политика из control plane) и прокси-воркеры с nftables-ACL, открытым только для IP подписчиков (`src/pro_node_agent.py`).
- **Control plane:** сайт, кабинет, биллинг и API — Next.js + PostgreSQL в `web/` (Docker Compose на `pereval.top`).
- **Деплой:** `deploy.sh` раскатывает конфиги и демоны на DNS/прокси-ноды (`--all` для Free, `--pro` для Pro), автоматически доустанавливая пакеты и откатывая изменения при ошибке. Подробности для разработчиков — в [AGENTS.md](./AGENTS.md).

---

## Предложить новый сервис или задать вопрос

Если нужный вам зарубежный сервис ограничивает доступ по региону, но его ещё нет в списке — напишите в **[Telegram-чат @pereval_dns](https://t.me/pereval_dns)** или создайте обращение в **[Issues](https://github.com/amak-tech/pereval/issues)** и укажите адрес сайта или название приложения.

---

## Лицензия

Исходный код проекта распространяется под лицензией **[Apache License 2.0](./LICENSE)**.

---

> **Правовое примечание:** Сервис не является средством обхода блокировок Роскомнадзора или Мининформа РБ, работает строго по фиксированному списку незапрещённых зарубежных IT-платформ и не предоставляет доступ к ресурсам, ограниченным законодательством РФ и РБ. Используя сервис, вы принимаете [Пользовательское соглашение](https://pereval.top/terms) и [Политику конфиденциальности](https://pereval.top/privacy).
