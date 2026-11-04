<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./logos/logo-horizontal-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./logos/logo-horizontal-light.svg">
    <img alt="Перевал — Умный DNS-прокси в Казахстане" src="./logos/logo-horizontal-dark.svg" width="760">
  </picture>
</p>

# Перевал — бесплатный DNS-прокси для доступа к ChatGPT, Claude, Gemini и инструментам разработки

**Перевал** — это бесплатный умный DNS-сервер (Smart DNS), который восстанавливает доступ к зарубежным ИИ и инструментам разработки, ограничивающим российские и белорусские IP-адреса по геолокации, **без установки VPN-приложений**, без регистрации и без падения скорости интернета.

👉 **Пошаговая инструкция по подключению и актуальные настройки:**  
**[https://pereval.portbuddy.tech](https://pereval.portbuddy.tech/?utm_source=github&utm_medium=readme&utm_campaign=pereval&utm_content=hero)**

---

## Зачем нужен Перевал

Многие зарубежные нейросети, облачные платформы и инструменты разработки закрывают доступ по геолокации (ошибки *«Unavailable in your country»*, *«Access denied»*, *«Недоступно в вашем регионе»*).

Обычный VPN перенаправляет весь ваш трафик через чужой сервер — из-за этого падает скорость, растёт пинг, отваливаются локальные контейнеры и корпоративные сети, а российские сайты, банки и Госуслуги перестают открываться.

**Перевал решает эту проблему точечно:**
- **Работают только нужные сайты:** через прокси идут исключительно популярные зарубежные AI-сервисы и инструменты для разработчиков, которые ограничивают российские и белорусские IP-адреса по геолокации со своей стороны.
- **Все остальные сайты открываются напрямую:** российские банки, Госуслуги, маркетплейсы, видео и торренты работают на полной скорости вашего провайдера.
- **Без программ и аккаунтов:** настройка занимает одну минуту в стандартных параметрах вашего устройства или роутера.
- **Безопасность данных:** ваши соединения по HTTPS остаются зашифрованными от вашего браузера или приложения до конечного сервиса.

---

## Какие сервисы работают через Перевал

На сайте **[pereval.portbuddy.tech](https://pereval.portbuddy.tech/?utm_source=github&utm_medium=readme&utm_campaign=pereval&utm_content=services)** поддерживаются самые востребованные сервисы для работы с ИИ и разработки (132 домена) с удобным поиском и проверкой:

- **ИИ и языковые модели:** ChatGPT (OpenAI), Claude (Anthropic), Google Gemini, AI Studio, NotebookLM и Jules, Grok (xAI), Microsoft Copilot, Cursor, Windsurf / Codeium, OpenRouter, Groq, Lambda Labs, Lightning AI, Augment Code, Cline, Trae, Qoder, Manus, Genspark, Langdock, DeepL.
- **Инструменты разработки, SaaS и облака:** JetBrains (IDE, AI Assistant, Toolbox, YouTrack, Qodana), HashiCorp (Terraform, Vagrant), Atlassian (Jira, Confluence), Sentry, MongoDB, Redis, Neo4j, Liquibase, Grafana, Graylog, Snyk, PostHog, Amplitude, Pingdom, Buf, Spacelift, Algolia, GitGuardian, Swagger, Netlify, Heroku, Framer, Ngrok, Tailscale, HTTP Toolkit, Oracle, Liberica JDK, Qt, Bitnami, NVIDIA Developer, Mattermost, Outline, ClickUp, Zapier.

> Полный и всегда актуальный список поддерживаемых сайтов и доменных зон доступен на сайте: **[pereval.portbuddy.tech](https://pereval.portbuddy.tech/?utm_source=github&utm_medium=readme&utm_campaign=pereval&utm_content=services_footer)**.

---

## На каких устройствах работает

Подключить **Перевал** можно практически на любом устройстве:

- **Браузеры (Firefox, Chrome, Brave, Edge, Яндекс.Браузер)** — через встроенный «DNS через HTTPS» (DNS-over-HTTPS / DoH) по адресу `https://pereval.portbuddy.tech/dns-query`, без изменения системных настроек ОС.
- **iPhone и iPad (iOS / iPadOS)** — через готовый профиль конфигурации (работает и в Wi-Fi, и в мобильной сети).
- **Android** — через встроенную функцию «Частный DNS» (Private DNS) в настройках системы.
- **Компьютеры и ноутбуки** — macOS, Windows 10/11, Linux.
- **Домашние роутеры (Keenetic, MikroTik, ASUS, TP-Link и др.)** — достаточно прописать DNS один раз на роутере, чтобы сервисы заработали сразу на всех устройствах в сети.

---

## Как подключиться

Перейдите на официальный сайт **[https://pereval.portbuddy.tech](https://pereval.portbuddy.tech/?utm_source=github&utm_medium=readme&utm_campaign=pereval&utm_content=setup)** — там вы найдёте:

1. **Актуальный адрес DNS-сервера** и кнопку установки профиля для iOS в один клик.
2. **Подробные пошаговые инструкции** для каждой операционной системы (iOS, Android, macOS, Windows, Linux).
3. **Интерактивный поиск по списку сервисов** — чтобы быстро проверить, поддерживается ли нужный вам сайт или приложение.
4. **Ответы на частые вопросы (FAQ)** — как проверить работу, что делать, если сайт не открывается, и как при необходимости отключить DNS.

---

## Работа через `/etc/hosts` (`update_hosts.py`)

В репозитории доступен скрипт [`update_hosts.py`](./update_hosts.py), который автоматически прописывает домены Перевала напрямую в системный файл `/etc/hosts` (на macOS и Linux) без изменения настроек DNS.

### Когда это полезно (Use Cases)

- **Корпоративный VPN (Cloudflare WARP, Cisco AnyConnect, GlobalProtect и др.):** корпоративные VPN-клиенты часто перехватывают весь DNS-трафик или блокируют ручное изменение системных DNS-серверов, но при этом система продолжает учитывать локальный файл `/etc/hosts`. Если у вас есть права администратора (`sudo`), скрипт позволяет использовать Перевал одновременно с включённым корпоративным VPN.
- **Кастомный или локальный DNS:** если на устройстве уже настроен собственный DNS-резолвер (например, Tailscale MagicDNS, AdGuard, Pi-hole, `dnsmasq` или корпоративный DNS для внутренних доменов), который нельзя заменять сторонним DNS-сервером.
- **Быстрое включение и отключение одной командой:** когда нужно временно включить маршрутизацию через Перевал для работы с AI-инструментами или быстро откатить изменения без перенастройки сетевых профилей.

### Как работает скрипт

- Загружает актуальный список доменов из `services.yaml` (с автоматическим фолбэком на `dnsmasq-geoblock.conf` или встроенный парсер, поэтому **не требует установки сторонних Python-пакетов** при запуске через `sudo`).
- Поскольку `/etc/hosts` не поддерживает wildcard-домены (`*.example.com`), скрипт автоматически разворачивает корневые домены второго уровня (например, `claude.ai`) в список часто используемых поддоменов (`www`, `api`, `auth`, `cdn`, `platform`, `chat`, `ab`, `accounts`, `app`, `static`, `assets`).
- Группирует до 9 хостов в одну строку внутри маркеров `# >>> PEREVAL START` и `# <<< PEREVAL END`, не затрагивая ваши собственные записи в `/etc/hosts`.
- На macOS автоматически сбрасывает системный DNS-кэш (`dscacheutil -flushcache` и `mDNSResponder`), чтобы изменения вступили в силу мгновенно.

### Примеры использования

**1. Установить или обновить записи Перевала в `/etc/hosts`:**
```bash
sudo python3 update_hosts.py
```
Повторный запуск команды безопасно обновит существующий блок между маркерами `# >>> PEREVAL START` и `# <<< PEREVAL END` без дублирования строк.

**2. Посмотреть сгенерированный блок без изменения `/etc/hosts` (режим `--dry-run`):**
```bash
python3 update_hosts.py --dry-run
```

**3. Удалить все записи Перевала из `/etc/hosts`:**
```bash
sudo python3 update_hosts.py --remove
```

**4. Дополнительные параметры (кастомный IP, путь к списку сервисов или файлу hosts):**
```bash
# Указать другой IP-адрес сервера Перевала
sudo python3 update_hosts.py --ip 153.80.200.170

# Использовать альтернативный файл services.yaml
sudo python3 update_hosts.py --services /path/to/services.yaml

# Записать результат в другой файл вместо /etc/hosts
python3 update_hosts.py --hosts-file ./hosts.preview
```

### Параметры командной строки

| Параметр | По умолчанию | Описание |
| :--- | :--- | :--- |
| `--ip <IP>` | `153.80.200.170` | IP-адрес прокси-сервера Перевала |
| `--services <PATH>` | `./services.yaml` | Путь к YAML-файлу со списком сервисов и доменов |
| `--hosts-file <PATH>` | `/etc/hosts` | Путь к целевому файлу `hosts` |
| `--remove` | — | Удалить блок записей Перевала из файла `hosts` |
| `--dry-run` | — | Вывести сгенерированный блок в консоль без записи в файл |

---

## Предложить новый сервис

Если нужный вам зарубежный сервис ограничивает доступ по региону (выдаёт ошибку региональной недоступности), но его ещё нет в списке на **[pereval.portbuddy.tech](https://pereval.portbuddy.tech/?utm_source=github&utm_medium=readme&utm_campaign=pereval&utm_content=request)** — создайте обращение в разделе **[Issues](https://github.com/amak-tech/pereval/issues)** репозитория **[github.com/amak-tech/pereval](https://github.com/amak-tech/pereval)** и укажите адрес сайта или название приложения.

---

> **Правовое примечание:** Сервис не является средством обхода блокировок Роскомнадзора или Мининформа РБ, работает строго по фиксированному списку незапрещённых зарубежных IT-платформ и не предоставляет доступ к ресурсам, ограниченным законодательством РФ и РБ. Используя сервис, вы принимаете [Пользовательское соглашение](https://pereval.portbuddy.tech/terms.html) и [Политику конфиденциальности](https://pereval.portbuddy.tech/privacy.html).
