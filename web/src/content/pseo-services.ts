import type { WizardTabId } from "@/components/home/SetupWizard";
import type { FaqItem } from "@/content/faq";
import { SITE } from "@/content/site";
import { catalog, poolLabel, serviceSlug, type CatalogCategory, type CatalogService } from "@/lib/catalog";

export type ServicePageData = {
  slug: string;
  name: string;
  shortName: string;
  parentSlug?: string;
  parentName?: string;
  tier: "free" | "pro";
  categoryId: string;
  categoryName: string;
  pool: string;
  domains: string[];
  title: string;
  description: string;
  h1: string;
  lead: string;
  errorBadge: string;
  whyBlocked: string;
  howSolved: string;
  caveat?: string;
  defaultWizardTab?: WizardTabId;
  recommendedDevices: string[];
  faq: FaqItem[];
  priority: number;
};

type ServiceOverride = {
  shortName?: string;
  title?: string;
  description?: string;
  h1?: string;
  lead?: string;
  errorBadge?: string;
  whyBlocked?: string;
  howSolved?: string;
  caveat?: string;
  defaultWizardTab?: WizardTabId;
  recommendedDevices?: string[];
  priority?: number;
};

export type SubProductDef = {
  slug: string;
  parentSlug: string;
  name: string;
  shortName: string;
  primaryDomains?: string[];
  override: ServiceOverride;
};

const OVERRIDES: Record<string, ServiceOverride> = {
  chatgpt: {
    shortName: "ChatGPT",
    title: `ChatGPT без VPN в России и Беларуси в 2026 году — Smart DNS ${SITE.name}`,
    description: `Как открыть ChatGPT и API OpenAI из России и Беларуси без VPN за 1 минуту: бесплатный Smart DNS ${SITE.name} убирает ошибку «not available in your country», не замедляя российские сайты.`,
    h1: "Как открыть ChatGPT в России и Беларуси без VPN в 2026 году",
    errorBadge: "HTTP 403 · Not available in your country",
    lead: "При прямом подключении с российских и белорусских IP-адресов OpenAI блокирует вход в веб-версию chatgpt.com, мобильное приложение и API. Бесплатный Smart DNS направляет трафик ChatGPT и Sora через выделенный ИИ-пул с постоянным IP, оставляя все остальные сайты и банки на прямом канале провайдера.",
    recommendedDevices: ["iphone", "android", "windows-11", "macos", "browsers", "corporate-vpn"],
    priority: 0.85,
  },
  claude: {
    shortName: "Claude AI",
    title: `Как открыть Claude AI в России и Беларуси без VPN — ${SITE.name}`,
    description: `Доступ к Anthropic Claude (claude.ai, Claude Code и API) без VPN: бесплатный Smart DNS ${SITE.name} работает на ПК и смартфонах за 1 минуту без сторонних программ.`,
    h1: "Как открыть Claude AI и Anthropic API без VPN в 2026 году",
    errorBadge: "HTTP 403 · App unavailable in region",
    lead: "Anthropic закрывает доступ к веб-чату claude.ai, консольному агенту Claude Code и API для подключений из РФ и РБ. Бесплатный DNS-сервер направляет домены Claude через постоянный зарубежный узел ИИ-пула — без VPN-клиента и разрывов корпоративной сети.",
    recommendedDevices: ["macos", "windows-11", "iphone", "android", "linux", "corporate-vpn"],
    priority: 0.85,
  },
  gemini: {
    shortName: "Google Gemini",
    title: `Google Gemini без VPN в России и Беларуси — настройка DNS за 1 минуту | ${SITE.name}`,
    description: `Почему Google Gemini и AI Studio пишут о недоступности региона и как открыть их без VPN через бесплатный Smart DNS ${SITE.name} на Android, iPhone и компьютере.`,
    h1: "Как включить Google Gemini в России и Беларуси без VPN",
    errorBadge: "Геоблок региона Google",
    lead: "Google перенаправляет российские и белорусские IP-адреса со страниц gemini.google.com, AI Studio и NotebookLM на справку о неподдерживаемых странах. Smart DNS переводит только ИИ-домены Google на проверенный пул узлов, не затрагивая Поиск, YouTube и почту Gmail.",
    recommendedDevices: ["android", "iphone", "windows-11", "macos", "browsers", "keenetic"],
    priority: 0.85,
  },
  "google-flow": {
    shortName: "Google Flow",
    title: `Google Flow (Veo) без VPN в России и Беларуси — бесплатный DNS ${SITE.name}`,
    description: `Как открыть ИИ-видеостудию Google Flow (flow.google, модели Veo и Imagen) из России и Беларуси без VPN: бесплатный Smart DNS ${SITE.name} за 1 минуту.`,
    h1: "Как открыть Google Flow (flow.google) в России и Беларуси без VPN",
    errorBadge: "Геоблок региона Google",
    lead: "ИИ-студия Google Flow (flow.google) для генерации видео и сцен на моделях Veo и Imagen перенаправляет запросы с российских и белорусских IP-адресов на страницу неподдерживаемых стран. Бесплатный Smart DNS направляет домены Flow и песочницы aisandbox через постоянный ИИ-пул, не затрагивая Поиск Google, YouTube и российские сайты.",
    recommendedDevices: ["windows-11", "macos", "browsers", "iphone", "android"],
    priority: 0.8,
  },
  "google-antigravity": {
    shortName: "Google Antigravity",
    title: `Google Antigravity IDE без VPN в России и Беларуси — Smart DNS ${SITE.name}`,
    description: `Как запустить агентную IDE Google Antigravity, десктопный менеджер агентов и CLI из России и Беларуси без системного VPN через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как работать в Google Antigravity IDE без VPN в России и Беларуси",
    errorBadge: "Геоблок региона Google / API",
    lead: "Агентная среда разработки Google Antigravity (antigravity.google), десктопный менеджер агентов и CLI блокируют вход, запросы к облачным моделям и серверы автообновления с IP-адресов РФ и РБ. Бесплатный Smart DNS точечно маршрутизирует домены Antigravity через постоянный ИИ-пул — локальные контейнеры Docker, SSH и корпоративная сеть продолжают работать без конфликтов.",
    recommendedDevices: ["macos", "windows-11", "linux", "corporate-vpn"],
    priority: 0.82,
  },
  cursor: {
    shortName: "Cursor",
    title: `Cursor IDE без VPN в России и Беларуси — работа моделей и API | ${SITE.name}`,
    description: `Как настроить бесперебойную работу ИИ-редактора Cursor (Claude, GPT, автодополнение) без VPN и проксирования всего трафика через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как работать в Cursor IDE из России и Беларуси без VPN",
    errorBadge: "Геоблок моделей / API",
    lead: "В редакторе Cursor запросы к моделям Anthropic и OpenAI, а также обновления и облачный индекс репозитория часто блокируются по региону IP, а обычный системный VPN мешает локальным контейнерам Docker, SSH и корпоративной сети. Smart DNS решает это точечно на уровне доменных имён.",
    recommendedDevices: ["macos", "windows-11", "linux", "corporate-vpn"],
    priority: 0.8,
  },
  grok: {
    shortName: "Grok (xAI)",
    title: `Как открыть Grok (xAI) в России и Беларуси без VPN — ${SITE.name}`,
    description: `Бесплатный доступ к нейросети Grok (grok.com и API x.ai) без установки VPN: настройка Smart DNS ${SITE.name} за 1 минуту на телефоне и компьютере.`,
    h1: "Как открыть Grok (grok.com) без VPN в России и Беларуси",
    errorBadge: "HTTP 403 · Cloudflare Geo",
    recommendedDevices: ["iphone", "android", "windows-11", "macos", "browsers"],
    priority: 0.78,
  },
  windsurf: {
    shortName: "Windsurf",
    title: `Windsurf и Codeium без VPN для разработчиков из РФ и РБ — ${SITE.name}`,
    description: `Как восстановить работу облачных моделей и автодополнения в IDE Windsurf и плагине Codeium без VPN с помощью бесплатного Smart DNS ${SITE.name}.`,
    h1: "Как настроить IDE Windsurf и Codeium без VPN",
    errorBadge: "Ограничение региона API",
    recommendedDevices: ["macos", "windows-11", "linux", "corporate-vpn"],
    priority: 0.75,
  },
  "github-copilot": {
    shortName: "GitHub Copilot",
    title: `GitHub Copilot без VPN в VS Code и JetBrains — Smart DNS ${SITE.name}`,
    description: `Решение ошибок подключения GitHub Copilot Chat и автодополнения в VS Code и IDE JetBrains без системного VPN через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как настроить GitHub Copilot в IDE без VPN",
    errorBadge: "HTTP 403 · Региональный фильтр API",
    recommendedDevices: ["macos", "windows-11", "linux", "corporate-vpn"],
    priority: 0.78,
  },
  "microsoft-copilot": {
    shortName: "Microsoft Copilot",
    title: `Microsoft Copilot без VPN в России и Беларуси — ${SITE.name}`,
    description: `Как убрать сообщение «Microsoft Copilot is not available in your region» и открыть Copilot и Designer без VPN через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как открыть Microsoft Copilot в России и Беларуси без VPN",
    errorBadge: "Not available in your region",
    recommendedDevices: ["windows-11", "browsers", "android", "iphone"],
    priority: 0.75,
  },
  jetbrains: {
    shortName: "JetBrains",
    title: `JetBrains, Toolbox и JetBrains AI без VPN (ошибка 451) — ${SITE.name}`,
    description: `Как скачивать и обновлять IntelliJ IDEA, PyCharm, WebStorm через Toolbox и работать с JetBrains AI / Junie без VPN с бесплатным Smart DNS ${SITE.name}.`,
    h1: "Как открыть JetBrains, Toolbox и JetBrains AI без VPN",
    errorBadge: "HTTP 451 / 403 по IP",
    caveat: "Smart DNS снимает сетевое ограничение по IP-адресу (загрузка дистрибутивов, обновления плагинов, документация, соединение с облаком JetBrains AI), но не влияет на проверку платёжного региона при покупке коммерческих лицензий.",
    recommendedDevices: ["macos", "windows-11", "linux", "corporate-vpn"],
    priority: 0.8,
  },
  deepl: {
    shortName: "DeepL",
    title: `Как открыть переводчик DeepL в России и Беларуси без VPN — ${SITE.name}`,
    description: `Решение ошибки «DeepL is not available in your region»: бесплатный Smart DNS ${SITE.name} возвращает работу сайта, словаря Linguee, приложений и API DeepL без VPN.`,
    h1: "Как открыть DeepL в России и Беларуси без VPN в 2026 году",
    errorBadge: "Unavailable in your region",
    recommendedDevices: ["windows-11", "macos", "iphone", "android", "browsers"],
    priority: 0.8,
  },
  swagger: {
    shortName: "Swagger / SmartBear",
    priority: 0.7,
  },
  "hume-ai": {
    shortName: "Hume AI",
    title: `Hume AI (голосовой API EVI) без VPN в России — бесплатный DNS ${SITE.name}`,
    description: `Как убрать ошибку HTTP 403 при обращении к api.hume.ai из России без VPN: бесплатный Smart DNS ${SITE.name} направляет запросы через постоянный ИИ-пул.`,
    h1: "Как работать с API Hume AI из России без VPN",
    errorBadge: "HTTP 403 на api.hume.ai",
    recommendedDevices: ["macos", "windows-11", "linux", "corporate-vpn"],
    priority: 0.72,
  },
  intel: {
    shortName: "Intel",
    title: `Как скачать драйверы и документацию Intel без VPN в РФ и РБ — ${SITE.name}`,
    description: `Решение региональной заглушки на intel.com: бесплатный Smart DNS ${SITE.name} открывает спецификации Intel ARK, драйверы и SDK без VPN за 1 минуту.`,
    h1: "Как открыть сайт и загрузки Intel в России и Беларуси без VPN",
    errorBadge: "Региональная заглушка РФ и РБ",
    recommendedDevices: ["windows-11", "linux", "macos", "browsers", "corporate-vpn"],
    priority: 0.76,
  },
  cisco: {
    shortName: "Cisco",
    title: `Cisco, Networking Academy и Talos без VPN в РФ и РБ — ${SITE.name}`,
    description: `Как открыть портал software.cisco.com, курсы netacad.com и базу Talos Intelligence из России и Беларуси без VPN через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как открыть порталы Cisco и NetAcad в России и Беларуси без VPN",
    errorBadge: "HTTP 403 · Региональный блок",
    recommendedDevices: ["windows-11", "macos", "linux", "corporate-vpn", "mikrotik"],
    priority: 0.76,
  },
  moltbook: {
    shortName: "Moltbook",
    title: `Как открыть Moltbook (moltbook.com) в России и Беларуси без VPN — ${SITE.name}`,
    description: `Бесплатный доступ к социальной сети ИИ-агентов Moltbook и API для OpenClaw из России и Беларуси без установки VPN через Smart DNS ${SITE.name}.`,
    h1: "Как открыть Moltbook и подключить ИИ-агента без VPN в РФ и РБ",
    errorBadge: "Ограничение доступа по IP",
    lead: "Социальная сеть и каталог автономных ИИ-агентов Moltbook (moltbook.com) ограничивают просмотр сообществ submolts, панель владельца и фоновые запросы API агентов (OpenClaw) с российских и белорусских IP-адресов. С бесплатным Smart DNS лента форума открывается в браузере, а локальные агенты стабильно держат связь с API без туннелирования всего трафика.",
    recommendedDevices: ["macos", "linux", "windows-11", "browsers", "iphone", "corporate-vpn"],
    priority: 0.74,
  },
  triage: {
    shortName: "Hatching Triage",
    title: `Hatching Triage (tria.ge) без VPN в России и Беларуси — Smart DNS ${SITE.name}`,
    description: `Доступ к облачной песочнице анализа вредоносного ПО Hatching Triage (tria.ge, Recorded Future) и API без ошибки 403 и без VPN с бесплатным DNS ${SITE.name}.`,
    h1: "Как открыть песочницу Hatching Triage (tria.ge) без VPN в РФ и РБ",
    errorBadge: "HTTP 403 · Региональный блок",
    lead: "Облачная песочница динамического анализа файлов Hatching Triage (tria.ge, Recorded Future) отклоняет прямые подключения к веб-интерфейсу, публичным отчётам и API автоматизации с IP-адресов России и Беларуси. Бесплатный Smart DNS открывает доступ к песочнице в браузере и из скриптов SOC/ИБ-аналитики без включения системного VPN.",
    recommendedDevices: ["linux", "macos", "windows-11", "browsers", "corporate-vpn"],
    priority: 0.74,
  },
  cerebras: {
    shortName: "Cerebras",
    title: `Cerebras Cloud и API без VPN в России и Беларуси — ${SITE.name}`,
    description: `Как открыть консоль cloud.cerebras.ai и сверхбыстрый LLM API api.cerebras.ai из России и Беларуси без ошибки 403 и без VPN через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как работать с Cerebras Cloud и API без VPN в РФ и РБ",
    errorBadge: "HTTP 403 · Блок региона API",
    lead: "Облачная консоль cloud.cerebras.ai и эндпоинт сверхбыстрого инференса api.cerebras.ai отклоняют прямые подключения с российских и белорусских IP-адресов кодом 403. Бесплатный Smart DNS направляет запросы к Cerebras через закреплённый ИИ-пул с постоянным зарубежным IP — локальные скрипты, агенты и IDE работают без включения системного VPN.",
    recommendedDevices: ["macos", "linux", "windows-11", "corporate-vpn", "browsers"],
    priority: 0.75,
  },
  coreweave: {
    shortName: "CoreWeave",
    title: `CoreWeave GPU Cloud без VPN в России и Беларуси — ${SITE.name}`,
    description: `Доступ к панели управления GPU-облака CoreWeave (console.coreweave.com) и документации из России и Беларуси без ошибки 403 через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как открыть консоль и облако CoreWeave без VPN в РФ и РБ",
    errorBadge: "HTTP 403 · Cloudflare Geo",
    lead: "Специализированное GPU-облако CoreWeave и панель управления console.coreweave.com блокируют подключения с российских и белорусских IP-адресов на уровне периметра (HTTP 403). Бесплатный Smart DNS точечно маршрутизирует домены CoreWeave через постоянный ИИ-пул, не мешая SSH-сессиям, Kubernetes и локальной разработке.",
    recommendedDevices: ["linux", "macos", "windows-11", "corporate-vpn", "browsers"],
    priority: 0.73,
  },
  "inception-labs": {
    shortName: "Inception Labs (Mercury)",
    title: `Inception Labs (Mercury API) без VPN в РФ и РБ — ${SITE.name}`,
    description: `Как убрать ошибку CloudFront 403 при обращении к диффузионным языковым моделям Mercury (api.inceptionlabs.ai) из России и Беларуси без VPN с ${SITE.name}.`,
    h1: "Как работать с моделями Mercury (Inception Labs) без VPN",
    errorBadge: "HTTP 403 · CloudFront Country Block",
    lead: "Платформа диффузионных языковых моделей Mercury от Inception Labs закрывает доступ к api.inceptionlabs.ai для запросов с российских и белорусских IP-адресов на уровне CloudFront (HTTP 403). Бесплатный Smart DNS переводит трафик Inception Labs на постоянный зарубежный узел ИИ-пула для стабильной работы чата, IDE и API.",
    recommendedDevices: ["macos", "linux", "windows-11", "corporate-vpn", "browsers"],
    priority: 0.73,
  },
  monica: {
    shortName: "Monica AI",
    title: `Как открыть ИИ-ассистент Monica (monica.im) без VPN — ${SITE.name}`,
    description: `Бесплатный доступ к веб-чату, браузерному расширению и приложению Monica AI (monica.im) из России и Беларуси без ошибки 403 и без VPN через Smart DNS ${SITE.name}.`,
    h1: "Как пользоваться ИИ-ассистентом Monica в РФ и РБ без VPN",
    errorBadge: "HTTP 403 · CloudFront Geo",
    lead: "Веб-интерфейс и API персонального ИИ-ассистента Monica (monica.im, api.monica.im) возвращают ошибку 403 на уровне CloudFront при подключении с региональных IP-адресов. С бесплатным Smart DNS расширение в браузере, десктопный клиент и мобильное приложение работают без фонового VPN.",
    recommendedDevices: ["browsers", "windows-11", "macos", "iphone", "android"],
    priority: 0.75,
  },
  broadcom: {
    shortName: "Broadcom и VMware",
    title: `Портал Broadcom и загрузки VMware без VPN (ошибка 403) — ${SITE.name}`,
    description: `Как открыть support.broadcom.com, базу знаний и скачивание VMware Workstation / ESXi из России и Беларуси без ошибки 403 через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как открыть портал Broadcom и скачать VMware без VPN в РФ и РБ",
    errorBadge: "HTTP 403 · Access Denied",
    lead: "После переноса продуктов VMware в инфраструктуру Broadcom порталы support.broadcom.com, access.broadcom.com, profile.broadcom.com и база знаний knowledge.broadcom.com отклоняют прямые запросы с IP-адресов РФ и РБ ошибкой 403. Бесплатный Smart DNS открывает вход в личный кабинет, документацию и скачивание дистрибутивов без включения системного VPN.",
    recommendedDevices: ["windows-11", "linux", "macos", "corporate-vpn", "mikrotik"],
    priority: 0.8,
  },
  "n8n-cloud": {
    shortName: "n8n Cloud",
    title: `n8n Cloud (app.n8n.cloud) без VPN в России и Беларуси — ${SITE.name}`,
    description: `Доступ к облачной платформе автоматизации воркфлоу n8n Cloud (n8n.cloud) из России и Беларуси без VPN за 1 минуту через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как открыть панель и воркфлоу n8n Cloud без VPN в РФ и РБ",
    errorBadge: "Региональное ограничение n8n Cloud",
    lead: "Облачный сервис автоматизации n8n Cloud ограничивает доступ к панели управления и облачным инстансам на домене n8n.cloud для подключений с российских и белорусских IP-адресов. Бесплатный Smart DNS возвращает прямой доступ к редактору сценариев в браузере без запуска VPN на рабочей машине.",
    recommendedDevices: ["macos", "windows-11", "linux", "browsers", "corporate-vpn"],
    priority: 0.76,
  },
  tableau: {
    shortName: "Tableau",
    title: `Tableau и Tableau Public без VPN в России и Беларуси — ${SITE.name}`,
    description: `Как убрать ошибку Akamai Access Denied (HTTP 403) на tableau.com и скачивать Tableau Desktop / Public из РФ и РБ без VPN с бесплатным Smart DNS ${SITE.name}.`,
    h1: "Как открыть сайт и загрузки Tableau без VPN в России и Беларуси",
    errorBadge: "HTTP 403 · Akamai Access Denied",
    lead: "Аналитическая BI-платформа Tableau блокирует запросы к порталу www.tableau.com, документации и разделу загрузок с российских и белорусских IP-адресов на уровне CDN Akamai (HTTP 403 Access Denied). Бесплатный Smart DNS снимает геоблок за минуту без установки VPN-клиентов.",
    recommendedDevices: ["windows-11", "macos", "browsers", "corporate-vpn"],
    priority: 0.75,
  },
  dell: {
    shortName: "Dell Support",
    title: `Как скачать драйверы и BIOS с сайта Dell без VPN (403) — ${SITE.name}`,
    description: `Убираем ошибку Access Denied на dell.com и dl.dell.com: бесплатный Smart DNS ${SITE.name} открывает драйверы, прошивки iDRAC/BIOS и документацию Dell из РФ и РБ без VPN.`,
    h1: "Как скачать драйверы и прошивки Dell без VPN в России и Беларуси",
    errorBadge: "HTTP 403 на dell.com / dl.dell.com",
    lead: "Портал технической поддержки dell.com и серверы раздачи файлов dl.dell.com отклоняют подключения с IP-адресов России и Беларуси на уровне Akamai (Access Denied). С бесплатным Smart DNS поиск по Service Tag, скачивание обновлений BIOS, iDRAC и драйверов для ноутбуков и серверов Dell работают напрямую без VPN.",
    recommendedDevices: ["windows-11", "linux", "macos", "corporate-vpn", "keenetic"],
    priority: 0.78,
  },
  netapp: {
    shortName: "NetApp",
    title: `Сайт и портал поддержки NetApp без VPN в РФ и РБ — ${SITE.name}`,
    description: `Доступ к документации netapp.com и порталу mysupport.netapp.com из России и Беларуси без ошибки Akamai 403 и без VPN через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как открыть документацию и поддержку NetApp без VPN в РФ и РБ",
    errorBadge: "HTTP 403 · Akamai Access Denied",
    lead: "Официальный сайт netapp.com и инженерный портал mysupport.netapp.com блокируют запросы с российских и белорусских IP-адресов на уровне CDN Akamai (HTTP 403). Бесплатный Smart DNS открывает базу знаний ONTAP, матрицы совместимости и документацию СХД NetApp без переключения корпоративного VPN.",
    recommendedDevices: ["windows-11", "linux", "macos", "corporate-vpn", "mikrotik"],
    priority: 0.72,
  },
  "texas-instruments": {
    shortName: "Texas Instruments",
    title: `Даташиты и SDK Texas Instruments (ti.com) без VPN — ${SITE.name}`,
    description: `Как открыть каталог микросхем, PDF-даташиты и загрузки SDK на ti.com из России и Беларуси без ошибки Access Denied через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как открыть сайт и даташиты Texas Instruments (ti.com) без VPN",
    errorBadge: "HTTP 403 · Access Denied на ti.com",
    lead: "Портал Texas Instruments (ti.com) блокирует просмотр карточек микросхем, скачивание технической документации (datasheet, reference design) и сред разработки Code Composer Studio с IP-адресов РФ и РБ на уровне Akamai. Бесплатный Smart DNS возвращает инженерам прямой доступ к справочникам и загрузкам без VPN.",
    recommendedDevices: ["windows-11", "linux", "macos", "browsers", "corporate-vpn"],
    priority: 0.75,
  },
  "analog-devices": {
    shortName: "Analog Devices",
    title: `Сайт, LTspice и даташиты Analog Devices без VPN в РФ и РБ — ${SITE.name}`,
    description: `Доступ к каталогу компонентов analog.com, инженерной вики wiki.analog.com, форуму EngineerZone и загрузкам LTspice без VPN через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как открыть документацию и загрузки Analog Devices без VPN",
    errorBadge: "Геоблок экспортного контроля",
    lead: "Портал analog.com, база знаний wiki.analog.com и сообщество EngineerZone (ez.analog.com) блокируют запросы с российских и белорусских IP-адресов заглушкой экспортного контроля. С бесплатным Smart DNS инженеры могут открывать даташиты, справочники и скачивать симулятор LTspice напрямую без VPN.",
    recommendedDevices: ["windows-11", "linux", "macos", "browsers", "corporate-vpn"],
    priority: 0.74,
  },
  microchip: {
    shortName: "Microchip",
    title: `Даташиты микроконтроллеров и MPLAB на Microchip без VPN — ${SITE.name}`,
    description: `Как убрать ошибку Access Denied на microchip.com и скачивать документацию PIC/AVR и среду MPLAB X IDE из РФ и РБ без VPN с бесплатным Smart DNS ${SITE.name}.`,
    h1: "Как открыть сайт и загрузки Microchip (PIC, AVR, MPLAB) без VPN",
    errorBadge: "HTTP 403 · Akamai Access Denied",
    lead: "Сайт microchip.com закрывает доступ к документации микроконтроллеров PIC, AVR и SAM, аппноутам и загрузкам среды разработки MPLAB X с IP-адресов России и Беларуси на уровне Akamai (HTTP 403). Бесплатный Smart DNS снимает ограничение по IP для браузера и утилит разработки без системного VPN.",
    recommendedDevices: ["windows-11", "linux", "macos", "browsers", "corporate-vpn"],
    priority: 0.74,
  },
  digikey: {
    shortName: "DigiKey",
    title: `Каталог компонентов и даташиты DigiKey без VPN в РФ и РБ — ${SITE.name}`,
    description: `Как открыть параметрический поиск радиодеталей и PDF-документацию на digikey.com из России и Беларуси без ошибки 403 через бесплатный Smart DNS ${SITE.name}.`,
    h1: "Как пользоваться каталогом компонентов DigiKey без VPN в РФ и РБ",
    errorBadge: "HTTP 403 на digikey.com",
    lead: "Крупнейший справочник электронных компонентов digikey.com и его серверы документации отклоняют прямые запросы с российских и белорусских IP-адресов кодом 403. С бесплатным Smart DNS параметрический подбор деталей, схемы и PDF-даташиты открываются мгновенно без включения VPN.",
    recommendedDevices: ["windows-11", "linux", "macos", "browsers", "corporate-vpn"],
    priority: 0.75,
  },
  mouser: {
    shortName: "Mouser Electronics",
    title: `Каталог и даташиты Mouser Electronics без VPN в РФ и РБ — ${SITE.name}`,
    description: `Доступ к базе электронных компонентов, ECAD-моделям и техническим описаниям на mouser.com из России и Беларуси без ошибки 403 через бесплатный DNS ${SITE.name}.`,
    h1: "Как открыть каталог компонентов Mouser Electronics без VPN",
    errorBadge: "HTTP 403 · Akamai Access Denied",
    lead: "Каталог электронных компонентов mouser.com блокирует подключения с российских и белорусских IP-адресов на уровне Akamai (HTTP 403 Access Denied). Бесплатный Smart DNS возвращает доступ к поиску по парт-номерам, даташитам и посадочным моделям для САПР без VPN.",
    recommendedDevices: ["windows-11", "linux", "macos", "browsers", "corporate-vpn"],
    priority: 0.74,
  },
  notion: {
    shortName: "Notion",
    title: `Как открыть Notion в России без VPN в 2026 году (ошибка 403) — ${SITE.name} Pro`,
    description: `Возвращаем доступ к рабочим пространствам, базам знаний и приложению Notion на ПК и смартфоне без включения VPN через Smart DNS ${SITE.name} Pro.`,
    h1: "Как открыть Notion в России без VPN в 2026 году",
    errorBadge: "HTTP 403 Forbidden (IP РФ)",
    lead: "С сентября 2024 года Notion отвечает ошибкой 403 при прямом подключении с российских IP-адресов как в браузере, так и в нативных приложениях iOS, Android, macOS и Windows. В подписке Перевал Pro рабочие домены Notion и статики открываются без запуска VPN и без помех для банковских приложений.",
    caveat: "В маршрутизацию включены домены самого приложения и API (notion.so, notion.com, makenotion.com и статика); публичный хостинг пользовательских страниц notion.site не проксируется. У отдельных интернет-провайдеров РФ возможна дополнительная фильтрация трафика на стороне сети оператора.",
    recommendedDevices: ["macos", "windows-11", "iphone", "android", "keenetic"],
    priority: 0.85,
  },
  miro: {
    shortName: "Miro",
    title: `Как открыть Miro в России и Беларуси без VPN в 2026 году — ${SITE.name} Pro`,
    description: `С октября 2026 года Miro заблокировал вход с IP-адресов РФ и РБ. Настройте Smart DNS ${SITE.name} Pro за 1 минуту, чтобы работать с досками Miro без VPN.`,
    h1: "Как открыть Miro в России и Беларуси без VPN в 2026 году",
    errorBadge: "Геоблок IP РФ и РБ (с 15.10.2026)",
    lead: "С 15 октября 2026 года онлайн-доски Miro недоступны при прямом подключении с российских и белорусских IP-адресов — ограничение затронуло в том числе бесплатные аккаунты и публичные ссылки. Smart DNS в тарифе Pro возвращает мгновенную загрузку досок в браузере и десктопном клиенте.",
    recommendedDevices: ["macos", "windows-11", "browsers", "iphone", "keenetic"],
    priority: 0.85,
  },
  adobe: {
    shortName: "Adobe Firefly и Creative Cloud",
    title: `Adobe Firefly, Behance и Creative Cloud без VPN в РФ и РБ — ${SITE.name} Pro`,
    description: `Как убрать Access Denied в Adobe Firefly и открыть сервисы Creative Cloud и Behance (adobe.com, behance.net, adobelogin.com, adobe.io) из РФ и РБ без VPN с ${SITE.name} Pro.`,
    h1: "Как открыть Adobe Firefly и Creative Cloud без VPN",
    errorBadge: "Access Denied / Геоблок IP",
    recommendedDevices: ["macos", "windows-11", "browsers"],
    priority: 0.8,
  },
  coda: {
    shortName: "Coda",
    title: `Как открыть Coda (coda.io) в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `Рабочие документы, реляционные таблицы и API Coda (coda.io) без ошибки 403 и без включения VPN на компьютере и смартфоне с подпиской ${SITE.name} Pro.`,
    h1: "Как работать в Coda (coda.io) из России и Беларуси без VPN",
    errorBadge: "HTTP 403 Forbidden (РФ и РБ)",
    lead: "Серверы Coda блокируют загрузку документов, таблиц и запросы к API coda.io с российских и белорусских IP-адресов. В подписке Перевал Pro командные пространства Coda открываются напрямую в браузере и через API без системного VPN.",
    recommendedDevices: ["macos", "windows-11", "browsers", "iphone", "corporate-vpn"],
    priority: 0.82,
  },
  whimsical: {
    shortName: "Whimsical",
    title: `Whimsical без VPN в России и Беларуси (ошибка 451) — ${SITE.name} Pro`,
    description: `Как убрать заглушку «Whimsical is currently not available in your region» (HTTP 451) и работать со схемами и вайрфреймами без VPN через ${SITE.name} Pro.`,
    h1: "Как открыть доски и схемы Whimsical без VPN в РФ и РБ",
    errorBadge: "HTTP 451 · Not available in region",
    recommendedDevices: ["macos", "windows-11", "browsers", "iphone"],
    priority: 0.78,
  },
  lucidchart: {
    shortName: "Lucidchart и Lucidspark",
    title: `Lucidchart и Lucidspark без VPN в России и Беларуси — ${SITE.name} Pro`,
    description: `Убираем редирект region-not-available в Lucidchart и Lucidspark (lucid.app) из России и Беларуси за 1 минуту без VPN с помощью Smart DNS ${SITE.name} Pro.`,
    h1: "Как открыть Lucidchart и Lucidspark без VPN в РФ и РБ",
    errorBadge: "Region not available (РФ и РБ)",
    recommendedDevices: ["macos", "windows-11", "browsers", "corporate-vpn"],
    priority: 0.8,
  },
  uizard: {
    shortName: "Uizard",
    title: `Как открыть Uizard (uizard.io) в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `ИИ-прототипирование интерфейсов и редактор макетов Uizard (app.uizard.io) без ошибки 403 из России и Беларуси через Smart DNS ${SITE.name} Pro.`,
    h1: "Как работать в редакторе Uizard из России и Беларуси без VPN",
    errorBadge: "HTTP 403 · Геоблок редактора",
    recommendedDevices: ["macos", "windows-11", "browsers"],
    priority: 0.76,
  },
  semrush: {
    shortName: "Semrush",
    title: `Как открыть Semrush в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `Доступ к платформе SEO-аналитики и маркетинга Semrush без ошибки региона (HTTP 448 / 403) и без медленного VPN через быстрые узлы ${SITE.name} Pro.`,
    h1: "Как работать в Semrush из России и Беларуси без VPN",
    errorBadge: "HTTP 448 / 403 · Блок региона",
    recommendedDevices: ["windows-11", "macos", "browsers", "corporate-vpn"],
    priority: 0.82,
  },
  autodesk: {
    shortName: "Autodesk",
    title: `Вход в Autodesk, AutoCAD и Fusion без VPN в РФ и РБ — ${SITE.name} Pro`,
    description: `Как убрать ошибку 403 на accounts.autodesk.com и восстановить вход в аккаунт Autodesk, лицензии AutoCAD и облако Fusion без VPN с ${SITE.name} Pro.`,
    h1: "Как войти в аккаунт Autodesk (AutoCAD, Fusion) без VPN",
    errorBadge: "HTTP 403 на accounts.autodesk.com",
    lead: "При подключении с российских и белорусских IP-адресов портал авторизации accounts.autodesk.com и облачные службы Autodesk возвращают ошибку 403. С персональным Smart DNS Перевал Pro вход в учётную запись, проверка подписки и синхронизация проектов работают штатно на Windows и macOS.",
    recommendedDevices: ["windows-11", "macos", "keenetic", "mikrotik"],
    priority: 0.84,
  },
  sketchup: {
    shortName: "SketchUp",
    title: `SketchUp Web и 3D Warehouse без VPN в России и Беларуси — ${SITE.name} Pro`,
    description: `Как открыть веб-редактор app.sketchup.com, вход Trimble ID и каталог моделей 3D Warehouse без ошибки 403 из РФ и РБ через Smart DNS ${SITE.name} Pro.`,
    h1: "Как открыть SketchUp и 3D Warehouse без VPN в РФ и РБ",
    errorBadge: "HTTP 403 на SketchUp / 3D Warehouse",
    recommendedDevices: ["windows-11", "macos", "browsers", "keenetic"],
    priority: 0.8,
  },
  coursera: {
    shortName: "Coursera",
    title: `Как открыть Coursera в России без VPN в 2026 году — ${SITE.name} Pro`,
    description: `Платформа Coursera разрывает прямое соединение с российских IP. Смотрите лекции и проходите курсы без тормозов VPN с помощью ${SITE.name} Pro.`,
    h1: "Как смотреть курсы Coursera из России без VPN",
    errorBadge: "Обрыв TLS с IP РФ",
    recommendedDevices: ["windows-11", "macos", "iphone", "android", "browsers"],
    priority: 0.78,
  },
  edx: {
    shortName: "edX",
    title: `Как открыть курсы edX (edx.org) в России без VPN — ${SITE.name} Pro`,
    description: `Университетские курсы на платформе edX без ошибки CloudFront 403: доступ к лекциям и заданиям edx.org без VPN с подпиской ${SITE.name} Pro.`,
    h1: "Как проходить курсы на edX из России без VPN",
    errorBadge: "HTTP 403 · CloudFront Geo Block",
    recommendedDevices: ["windows-11", "macos", "iphone", "android", "browsers"],
    priority: 0.76,
  },
  "home-connect": {
    shortName: "Home Connect (Bosch / Siemens)",
    title: `Home Connect (Bosch и Siemens) в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `Как восстановить связь умной бытовой техники Bosch и Siemens с облаком Home Connect и SingleKey ID через роутер и смартфон с DNS ${SITE.name} Pro.`,
    h1: "Как подключить технику Bosch и Siemens (Home Connect) без VPN",
    errorBadge: "HTTP 403 на api.home-connect.com",
    lead: "Облачный сервер api.home-connect.com блокирует прямые подключения из России и Беларуси, из-за чего приложение Home Connect и сами посудомоечные, стиральные и кофейные машины Bosch / Siemens теряют связь с аккаунтом. Пропишите DNS Перевал Pro на домашнем роутере и телефоне — техника снова выйдет в сеть без VPN.",
    defaultWizardTab: "router",
    recommendedDevices: ["keenetic", "mikrotik", "openwrt", "iphone", "android"],
    priority: 0.82,
  },
  dyson: {
    shortName: "Dyson (MyDyson)",
    title: `Приложение MyDyson в России и Беларуси без VPN (ошибка входа) — ${SITE.name} Pro`,
    description: `Как войти в приложение MyDyson и подключить очистители и пылесосы Dyson к облаку из России и Беларуси без VPN через домашний роутер и ${SITE.name} Pro.`,
    h1: "Как настроить приложение MyDyson в России и Беларуси без VPN",
    errorBadge: "HTTP 403 на облаке MyDyson",
    lead: "Серверы авторизации и облачного API приложения MyDyson (appapi.cp.dyson.com) отклоняют запросы с российских и белорусских IP-адресов. С настройкой Smart DNS Перевал Pro на смартфоне и домашнем роутере приложение входит в аккаунт и управляет очистителями воздуха штатно.",
    defaultWizardTab: "router",
    recommendedDevices: ["iphone", "android", "keenetic", "mikrotik", "openwrt"],
    priority: 0.82,
  },
  spotify: {
    shortName: "Spotify",
    title: `Как слушать Spotify в России без VPN на телефоне, ПК и колонках — ${SITE.name} Pro`,
    description: `Музыка и подкасты Spotify без включения VPN на iPhone, Android, компьютере и домашнем роутере: стабильный медиа-пул в подписке ${SITE.name} Pro.`,
    h1: "Как слушать Spotify в России без VPN в 2026 году",
    errorBadge: "Закрыт для IP РФ (why-not-available)",
    lead: "При подключении с российского IP веб-плеер и приложение Spotify не дают войти в аккаунт или выбрасывают из сессии. В Перевал Pro трафик Spotify идёт через отдельный высокоскоростной медиа-пул — приложение работает фоном сутками, а банковские приложения и навигатор не конфликтуют с VPN.",
    caveat: "Если в бесплатном аккаунте Spotify страна профиля не совпадает со страной узла дольше 14 дней, приложение может попросить сменить регион в настройках аккаунта на сайте spotify.com (с включённым DNS это делается за 30 секунд). На подписках Spotify Premium привязка региона фиксируется способом оплаты.",
    recommendedDevices: ["iphone", "android", "windows-11", "macos", "keenetic", "mikrotik"],
    priority: 0.85,
  },
  elevenlabs: {
    shortName: "ElevenLabs",
    title: `Как открыть ElevenLabs и синтез речи в РФ и РБ без VPN — ${SITE.name} Pro`,
    description: `Доступ к озвучке, клонированию голоса, ElevenReader, ElevenMusic и API ElevenLabs из России и Беларуси без VPN на постоянном узле ИИ-пула ${SITE.name} Pro.`,
    h1: "Как работать с ElevenLabs из России и Беларуси без VPN",
    errorBadge: "Geo-restriction РФ и РБ",
    recommendedDevices: ["windows-11", "macos", "browsers", "corporate-vpn"],
    priority: 0.78,
  },
  xbox: {
    shortName: "Xbox",
    title: `Ошибка 0x80a40401 на Xbox в России — рабочий DNS без VPN (2026) | ${SITE.name} Pro`,
    description: `Как убрать региональную ошибку входа 0x80a40401 на Xbox Series X|S и Xbox One за 1 минуту: персональный DNS ${SITE.name} Pro без настройки VPN на роутере.`,
    h1: "Ошибка 0x80a40401 на Xbox — решение через DNS за 1 минуту",
    errorBadge: "Код ошибки 0x80a40401 (Xbox Live)",
    lead: "При входе в учётную запись на консолях Xbox Series X|S и Xbox One с российских IP-адресов возникает ошибка 0x80a40401 («Вы находитесь в регионе, где эта служба недоступна»). Публичные бесплатные DNS для Xbox регулярно перегружаются или блокируются — в Перевал Pro вы привязываете домашний IP в личном кабинете и прописываете чистый DNS-адрес прямо в настройках приставки.",
    caveat: "SNI-прокси обрабатывает TCP-соединения (порты 80/443): вход в профиль Xbox Live, библиотеку Game Pass, магазин и облачные сохранения. Сама загрузка гигабайтных игр с CDN и UDP-пакеты сетевых матчей идут напрямую через вашего провайдера на максимальной скорости без роста пинга.",
    defaultWizardTab: "router",
    recommendedDevices: ["xbox", "keenetic", "mikrotik", "openwrt"],
    priority: 0.88,
  },
  playstation: {
    shortName: "PlayStation Network",
    title: `DNS для PlayStation 5 и PS4 в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `Стабильная авторизация PSN, работа PlayStation Store и сетевых функций на PS5 и PS4 через чистый DNS ${SITE.name} Pro с привязкой домашнего IP.`,
    h1: "Рабочий DNS для PlayStation 5 и PS4 без VPN в 2026 году",
    errorBadge: "Ограничение PSN / Store",
    lead: "На консолях PS5 и PS4 нельзя установить VPN-приложение, а бесплатные публичные DNS часто перестают отвечать вечером. В Перевал Pro достаточно привязать домашний IP-адрес (или настроить DDNS на роутере) и указать DNS-сервер в параметрах сети консоли.",
    caveat: "Через прокси проходят авторизация PSN, магазин PlayStation Store и API сетевых служб (TCP 80/443), а скачивание игр и голосовой/игровой UDP-трафик идут напрямую с минимальной задержкой.",
    defaultWizardTab: "router",
    recommendedDevices: ["playstation", "keenetic", "mikrotik", "openwrt"],
    priority: 0.85,
  },
  supercell: {
    shortName: "Игры Supercell",
    title: `Как зайти в игры Supercell (Brawl Stars, Clash Royale, mo.co) без VPN — ${SITE.name} Pro`,
    description: `Решение ошибки «Ваше текущее местоположение не позволяет выполнить вход» в Brawl Stars, Clash Royale, Clash of Clans и mo.co через частный DNS ${SITE.name} Pro.`,
    h1: "Как зайти в игры Supercell и Supercell ID без VPN",
    errorBadge: "Вход ограничен по местоположению",
    recommendedDevices: ["iphone", "android", "keenetic"],
    priority: 0.82,
  },
  // Карточки сервисов, проходящих проверку в pro.admin_services (публикуются автоматически при переносе в pro.categories)
  canva: {
    shortName: "Canva и Affinity",
    title: `Как открыть Canva и Affinity в России без VPN (ошибка 403) — ${SITE.name} Pro`,
    description: `Возвращаем доступ к графическому редактору Canva, Affinity Studio и сервисам Remove.bg без VPN на компьютере и смартфоне через Smart DNS ${SITE.name} Pro.`,
    h1: "Как работать в Canva и Affinity из России без VPN",
    errorBadge: "HTTP 403 · Регион ограничен",
    lead: "Графический онлайн-редактор Canva закрыл прямой доступ с российских IP-адресов (HTTP 403), затронув веб-редактор, мобильные приложения и экосистему шаблонов. В подписке Перевал Pro домены Canva, Affinity и инструментов удаления фона Remove.bg / Kaleido AI открываются без запуска VPN и потери скорости.",
    recommendedDevices: ["macos", "windows-11", "browsers", "iphone", "android"],
    priority: 0.85,
  },
  chaos: {
    shortName: "Chaos (V-Ray, Corona) и Enscape",
    title: `Лицензии Chaos (V-Ray, Corona) и Enscape без VPN в РФ и РБ — ${SITE.name} Pro`,
    description: `Как войти в аккаунт my.chaos.com и портал Enscape (enscape3d.com) без ошибки 403 из России и Беларуси для работы V-Ray и Corona без VPN с ${SITE.name} Pro.`,
    h1: "Как открыть личный кабинет Chaos (V-Ray, Corona) и Enscape без VPN",
    errorBadge: "HTTP 403 на my.chaos.com / Enscape",
    lead: "Серверы авторизации и управления лицензиями Chaos (my.chaos.com, ssooauth.chaos.com для V-Ray и Corona Renderer) и портал архитектурной визуализации Enscape (enscape3d.com) блокируют запросы с IP-адресов РФ и РБ. С персональным Smart DNS Перевал Pro проверка подписки, библиотеки ассетов и вход в аккаунт работают без системного VPN.",
    recommendedDevices: ["windows-11", "macos", "keenetic", "mikrotik"],
    priority: 0.8,
  },
  basecamp: {
    shortName: "Basecamp",
    title: `Как открыть Basecamp (37signals) в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `Убираем редирект на страницу санкционных ограничений basecamp.com/sanctions и возвращаем работу проектов и приложения Basecamp без VPN с ${SITE.name} Pro.`,
    h1: "Как работать в Basecamp из России и Беларуси без VPN",
    errorBadge: "Редирект basecamp.com/sanctions",
    lead: "Система управления проектами Basecamp (37signals) перенаправляет прямые подключения с российских и белорусских IP-адресов на страницу региональных ограничений basecamp.com/sanctions. В подписке Перевал Pro веб-версия, API и мобильные приложения Basecamp открываются штатно без постоянного VPN.",
    recommendedDevices: ["macos", "windows-11", "iphone", "android", "browsers"],
    priority: 0.78,
  },
  parsec: {
    shortName: "Parsec",
    title: `Как скачать и обновить Parsec в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `Убираем ошибку Cloudflare 403 на сервере загрузок builds.parsec.app: быстрый вход и обновление клиента Parsec без VPN с минимальным пингом P2P через ${SITE.name} Pro.`,
    h1: "Как скачать и запускать Parsec в России и Беларуси без VPN",
    errorBadge: "HTTP 403 на builds.parsec.app",
    lead: "Сервер раздачи дистрибутивов и автообновлений builds.parsec.app блокирует запросы с региональных IP-адресов на уровне Cloudflare (HTTP 403), мешая установке и запуску клиента удалённого рабочего стола Parsec. Smart DNS Перевал Pro открывает загрузку и авторизацию клиента, оставляя сам видеопоток P2P на прямом UDP-канале без задержек VPN.",
    caveat: "Через прокси проходят скачивание дистрибутивов, автообновление и авторизация на серверах Parsec (TCP 443), а сам интерактивный видеопоток удалённого рабочего стола передаётся напрямую между устройствами по UDP (P2P) с минимальной задержкой.",
    recommendedDevices: ["windows-11", "macos", "linux", "keenetic"],
    priority: 0.78,
  },
};

const SUB_PRODUCTS: SubProductDef[] = [
  {
    slug: "brawl-stars",
    parentSlug: "supercell",
    name: "Brawl Stars (Supercell)",
    shortName: "Brawl Stars",
    primaryDomains: ["brawlstarsgame.com", "brawlstars.com", "supercellid.com", "supercell.com", "supercellgames.com"],
    override: {
      title: `Как зайти в Brawl Stars в России и Беларуси без VPN через DNS — ${SITE.name} Pro`,
      description: `Убираем ошибку «Вход не выполнен: ваше текущее местоположение не позволяет выполнить вход» в Brawl Stars на iPhone и Android за 1 минуту с DNS ${SITE.name} Pro.`,
      h1: "Как играть в Brawl Stars в России и Беларуси без VPN",
      errorBadge: "Ошибка входа по геолокации",
      lead: "При запуске Brawl Stars с российских и белорусских IP-адресов игра блокирует авторизацию и привязку Supercell ID. Вместо VPN, который разряжает батарею и повышает пинг в боях, настройте персональный профиль или Частный DNS Перевал Pro — игра запускается сразу, а мессенджеры и банки продолжают работать напрямую.",
      caveat: "Авторизация клиента, магазин и Supercell ID идут через защищённый SNI-прокси (TCP 443), а быстрые UDP-пакеты самого боя идут напрямую до игрового сервера без лишнего крюка через VPN — пинг в матчах остаётся минимальным.",
      recommendedDevices: ["iphone", "android", "keenetic"],
      priority: 0.85,
    },
  },
  {
    slug: "clash-royale",
    parentSlug: "supercell",
    name: "Clash Royale (Supercell)",
    shortName: "Clash Royale",
    primaryDomains: ["clashroyaleapp.com", "clashroyale.com", "supercellid.com", "supercell.com", "supercellgames.com"],
    override: {
      title: `Как зайти в Clash Royale без VPN в России и Беларуси (DNS) — ${SITE.name} Pro`,
      description: `Быстрый вход в Clash Royale и Supercell ID на iOS и Android без VPN и высокого пинга через персональный зашифрованный DNS ${SITE.name} Pro.`,
      h1: "Как открыть Clash Royale в России и Беларуси без VPN",
      errorBadge: "Блокировка входа по IP РФ и РБ",
      lead: "Серверы авторизации Supercell отклоняют подключение к Clash Royale с IP-адресов России и Беларуси. Настройте профиль iOS или Частный DNS на Android в подписке Перевал Pro, чтобы заходить в игру в один тап без включения VPN перед каждой партией.",
      caveat: "Проверка региона при запуске и вход в Supercell ID проходят по HTTPS через узел Перевал Pro, тогда как игровой UDP-трафик арены идёт напрямую без задержек VPN.",
      recommendedDevices: ["iphone", "android", "keenetic"],
      priority: 0.8,
    },
  },
  {
    slug: "clash-of-clans",
    parentSlug: "supercell",
    name: "Clash of Clans (Supercell)",
    shortName: "Clash of Clans",
    primaryDomains: ["clashofclans.com", "supercellid.com", "supercell.com", "supercellgames.com"],
    override: {
      title: `Как играть в Clash of Clans без VPN в России и Беларуси — DNS ${SITE.name} Pro`,
      description: `Обход региональной ошибки входа в Clash of Clans и Supercell ID на iPhone, iPad и Android без установки VPN с помощью Smart DNS ${SITE.name} Pro.`,
      h1: "Как зайти в Clash of Clans в России и Беларуси без VPN",
      errorBadge: "Вход ограничен в вашем регионе",
      recommendedDevices: ["iphone", "android", "keenetic"],
      priority: 0.78,
    },
  },
  {
    slug: "moco",
    parentSlug: "supercell",
    name: "mo.co (Supercell)",
    shortName: "mo.co",
    primaryDomains: ["mocogame.com", "supercellid.com", "supercell.com", "supercellgames.com"],
    override: {
      title: `Как зайти в mo.co (Supercell) в России и Беларуси без VPN — ${SITE.name} Pro`,
      description: `Запуск ролевого экшена mo.co от Supercell и вход в Supercell ID на iPhone и Android из России и Беларуси без VPN и высокого пинга через DNS ${SITE.name} Pro.`,
      h1: "Как играть в mo.co (Supercell) в России и Беларуси без VPN",
      errorBadge: "Ошибка входа по региону IP",
      lead: "Кооперативный экшен mo.co от Supercell проверяет геолокацию при подключении к серверам game.mocogame.com и входе в Supercell ID, отклоняя соединения с российских и белорусских IP-адресов. С профилем iOS или Частным DNS Перевал Pro игра и лобби открываются без включения VPN на телефоне.",
      caveat: "Вход в Supercell ID, загрузка ассетов и TCP-соединение лобби mo.co обрабатываются узлом Перевал Pro, а быстрые UDP-пакеты боевой сессии идут напрямую с минимальным пингом.",
      recommendedDevices: ["iphone", "android", "keenetic"],
      priority: 0.78,
    },
  },
  {
    slug: "notebooklm",
    parentSlug: "gemini",
    name: "Google NotebookLM",
    shortName: "NotebookLM",
    primaryDomains: [
      "notebooklm.google.com",
      "notebooklm.google",
      "notebooklm-pa.googleapis.com",
      "notebooklm.googleapis.com",
      "notebooklm-pa.clients6.google.com",
    ],
    override: {
      title: `Как открыть Google NotebookLM в России и Беларуси без VPN — ${SITE.name}`,
      description: `Бесплатный доступ к ИИ-блокноту Google NotebookLM и аудиообзорам без VPN: настройка Smart DNS ${SITE.name} за 1 минуту на компьютере и смартфоне.`,
      h1: "Как пользоваться Google NotebookLM в России и Беларуси без VPN",
      errorBadge: "Регион не поддерживается Google",
      lead: "ИИ-ассистент для работы с документами notebooklm.google.com перенаправляет пользователей с российскими и белорусскими IP на страницу ограничения региона. В бесплатном тарифе Перевал все домены NotebookLM и его API уже включены в ИИ-пул.",
      recommendedDevices: ["windows-11", "macos", "browsers", "iphone", "android"],
      priority: 0.8,
    },
  },
  {
    slug: "google-ai-studio",
    parentSlug: "gemini",
    name: "Google AI Studio (Gemini API)",
    shortName: "Google AI Studio",
    primaryDomains: [
      "aistudio.google.com",
      "generativelanguage.googleapis.com",
      "ai.google.dev",
      "makersuite.google.com",
      "alkalimakersuite-pa.googleapis.com",
    ],
    override: {
      title: `Google AI Studio и Gemini API без VPN (aistudio.google.com) — ${SITE.name}`,
      description: `Как открыть aistudio.google.com и отправлять запросы к generativelanguage.googleapis.com из РФ и РБ без VPN с помощью бесплатного Smart DNS ${SITE.name}.`,
      h1: "Как открыть Google AI Studio и Gemini API без VPN",
      errorBadge: "User location is not supported",
      lead: "При обращении к веб-песочнице aistudio.google.com или эндпоинту generativelanguage.googleapis.com с локального IP серверы Google возвращают ошибку «User location is not supported for the API use». Бесплатный DNS Перевал решает проблему сразу и для браузера, и для локальных скриптов Python/Node.js.",
      recommendedDevices: ["macos", "windows-11", "linux", "corporate-vpn"],
      priority: 0.8,
    },
  },
  {
    slug: "adobe-firefly",
    parentSlug: "adobe",
    name: "Adobe Firefly",
    shortName: "Adobe Firefly",
    primaryDomains: ["adobe.com", "adobelogin.com", "adobe.io", "adobe.net"],
    override: {
      title: `Как открыть Adobe Firefly в России и Беларуси без VPN — ${SITE.name} Pro`,
      description: `Убираем экран «Access Denied» при генерации изображений в веб-версии Adobe Firefly и Photoshop Generative Fill без VPN с подпиской ${SITE.name} Pro.`,
      h1: "Как работать в Adobe Firefly без VPN в России и Беларуси",
      errorBadge: "Access Denied (Геоблок IP)",
      recommendedDevices: ["macos", "windows-11", "browsers"],
      priority: 0.78,
    },
  },
  {
    slug: "lucidspark",
    parentSlug: "lucidchart",
    name: "Lucidspark",
    shortName: "Lucidspark",
    primaryDomains: ["lucidspark.com", "lucid.app", "lucid.co"],
    override: {
      title: `Онлайн-доски Lucidspark без VPN в России и Беларуси — ${SITE.name} Pro`,
      description: `Как открыть командные доски Lucidspark (lucid.app) без региональной заглушки в России и Беларуси за 1 минуту через Smart DNS ${SITE.name} Pro.`,
      h1: "Как работать на досках Lucidspark без VPN в РФ и РБ",
      errorBadge: "Region not available (РФ и РБ)",
      recommendedDevices: ["macos", "windows-11", "browsers"],
      priority: 0.76,
    },
  },
  {
    slug: "netacad",
    parentSlug: "cisco",
    name: "Cisco Networking Academy (NetAcad)",
    shortName: "Cisco NetAcad",
    primaryDomains: ["netacad.com", "cisco.com"],
    override: {
      title: `Cisco Networking Academy (netacad.com) без VPN в РФ и РБ — ${SITE.name}`,
      description: `Бесплатный доступ к курсам и платформе Cisco Networking Academy (netacad.com) из России и Беларуси без ошибки 403 и без VPN через Smart DNS ${SITE.name}.`,
      h1: "Как открыть курсы Cisco Networking Academy (NetAcad) без VPN",
      errorBadge: "HTTP 403 на netacad.com",
      recommendedDevices: ["windows-11", "macos", "linux", "browsers"],
      priority: 0.76,
    },
  },
  {
    slug: "codeium",
    parentSlug: "windsurf",
    name: "Codeium",
    shortName: "Codeium",
    primaryDomains: ["codeium.com", "windsurf.com"],
    override: {
      title: `Плагин Codeium в VS Code и JetBrains без VPN — бесплатный DNS ${SITE.name}`,
      description: `Бесплатная настройка Smart DNS ${SITE.name} для стабильной работы ИИ-автодополнения Codeium в VS Code, IntelliJ IDEA и PyCharm без отключения рабочего VPN.`,
      h1: "Как настроить плагин Codeium в IDE без VPN",
      errorBadge: "Геоблок серверов моделей",
      recommendedDevices: ["macos", "windows-11", "linux", "corporate-vpn"],
      priority: 0.74,
    },
  },
  {
    slug: "terraform",
    parentSlug: "hashicorp",
    name: "Terraform Registry (HashiCorp)",
    shortName: "Terraform",
    primaryDomains: ["terraform.io", "hashicorp.com", "vagrantcloud.com"],
    override: {
      title: `Terraform init без VPN в России (registry.terraform.io 403/451) — ${SITE.name}`,
      description: `Как скачивать провайдеры и модули с registry.terraform.io и releases.hashicorp.com одной настройкой бесплатного DNS ${SITE.name} без зеркал и VPN.`,
      h1: "Как исправить ошибку 403/451 при terraform init без VPN",
      errorBadge: "HTTP 403 / 451 на registry.terraform.io",
      lead: "Команда terraform init и скачивание бинарных сборок с releases.hashicorp.com завершаются ошибкой доступа 403/451 при подключении с российских и белорусских IP. Бесплатный Smart DNS покрывает домены terraform.io и hashicorp.com — утилита начинает скачивать провайдеры штатно без правки .terraformrc на каждом проекте.",
      recommendedDevices: ["linux", "macos", "windows-11", "corporate-vpn", "mikrotik"],
      priority: 0.8,
    },
  },
  {
    slug: "vmware",
    parentSlug: "broadcom",
    name: "VMware (Broadcom Support)",
    shortName: "VMware",
    primaryDomains: [
      "support.broadcom.com",
      "access.broadcom.com",
      "knowledge.broadcom.com",
      "profile.broadcom.com",
      "broadcom.com",
    ],
    override: {
      title: `Как скачать VMware Workstation и ESXi с Broadcom без VPN — ${SITE.name}`,
      description: `Убираем ошибку HTTP 403 при входе на support.broadcom.com: скачивание VMware Workstation Pro, Fusion и ESXi и чтение KB из РФ и РБ без VPN с бесплатным DNS ${SITE.name}.`,
      h1: "Как скачать VMware с портала Broadcom без VPN в России и Беларуси",
      errorBadge: "HTTP 403 на support.broadcom.com",
      lead: "Для загрузки бесплатного VMware Workstation Pro, VMware Fusion, образов ESXi и чтения статей базы знаний KB теперь используется единый портал support.broadcom.com, который возвращает ошибку 403 при заходе с IP-адресов РФ и РБ. Бесплатный Smart DNS открывает авторизацию и скачивание дистрибутивов без системного VPN.",
      recommendedDevices: ["windows-11", "linux", "macos", "corporate-vpn", "mikrotik"],
      priority: 0.8,
    },
  },
  // Саб-продукты для сервисов из pro.admin_services (публикуются автоматически вместе с родительским сервисом)
  {
    slug: "affinity",
    parentSlug: "canva",
    name: "Affinity Studio (Canva)",
    shortName: "Affinity",
    primaryDomains: ["affinity.studio", "canva.com", "canva-apps.com"],
    override: {
      title: `Affinity Studio (Canva) без VPN в России и Беларуси — ${SITE.name} Pro`,
      description: `Авторизация аккаунта Canva в графическом пакете Affinity Studio и доступ к облачным функциям без VPN через Smart DNS ${SITE.name} Pro.`,
      h1: "Как войти в Affinity Studio через аккаунт Canva без VPN",
      errorBadge: "Геоблок авторизации Canva",
      recommendedDevices: ["macos", "windows-11", "iphone"],
      priority: 0.78,
    },
  },
  {
    slug: "remove-bg",
    parentSlug: "canva",
    name: "Remove.bg (Canva / Kaleido AI)",
    shortName: "Remove.bg",
    primaryDomains: ["remove.bg", "kaleido.ai", "unscreen.com", "designify.com", "canva.com"],
    override: {
      title: `Как открыть Remove.bg в России без VPN — удаление фона онлайн | ${SITE.name} Pro`,
      description: `ИИ-удаление фона на фото и видео в Remove.bg, Unscreen и API Kaleido без VPN из России через Smart DNS ${SITE.name} Pro.`,
      h1: "Как пользоваться Remove.bg в России без VPN",
      errorBadge: "Геоблок экосистемы Canva",
      recommendedDevices: ["macos", "windows-11", "browsers", "iphone", "android"],
      priority: 0.78,
    },
  },
  {
    slug: "enscape",
    parentSlug: "chaos",
    name: "Enscape (Chaos)",
    shortName: "Enscape",
    primaryDomains: ["enscape3d.com", "chaos.com"],
    override: {
      title: `Enscape 3D и библиотека ассетов без VPN в РФ и РБ — ${SITE.name} Pro`,
      description: `Как войти в аккаунт Enscape (enscape3d.com, Chaos) и загружать 3D-ассеты в Revit, SketchUp и Archicad без ошибки 403 и без VPN с ${SITE.name} Pro.`,
      h1: "Как настроить доступ к Enscape 3D и лицензии без VPN",
      errorBadge: "HTTP 403 на enscape3d.com",
      recommendedDevices: ["windows-11", "macos", "keenetic", "mikrotik"],
      priority: 0.78,
    },
  },
];

function cleanShortName(name: string): string {
  const noParens = name.split("(", 1)[0]?.trim() || name;
  if (noParens.includes(" / ")) {
    const parts = noParens.split(" / ").map((p) => p.trim());
    return parts[parts.length - 1] || noParens;
  }
  return noParens;
}

function defaultDevicesForCategory(categoryId: string): string[] {
  switch (categoryId) {
    case "games":
      return ["xbox", "playstation", "keenetic", "iphone", "android"];
    case "dev":
      return ["macos", "linux", "windows-11", "corporate-vpn", "keenetic"];
    case "ai":
      return ["iphone", "android", "macos", "windows-11", "browsers", "corporate-vpn"];
    case "media":
      return ["iphone", "android", "windows-11", "keenetic", "browsers"];
    case "work":
      return ["macos", "windows-11", "browsers", "iphone", "android"];
    default:
      return ["iphone", "android", "windows-11", "macos"];
  }
}

function defaultErrorBadge(categoryId: string, note?: string): string {
  if (note) {
    if (/451/.test(note)) return "HTTP 451 · Геоблок по IP";
    if (/403/.test(note)) return "HTTP 403 · Ограничение региона";
    if (/TLS/i.test(note)) return "Сброс соединения по IP";
    if (/0x80a40401/i.test(note)) return "Код ошибки 0x80a40401";
  }
  switch (categoryId) {
    case "ai":
      return "Ограничение региона ИИ-платформы";
    case "dev":
      return "HTTP 403 / 451 для IP РФ и РБ";
    case "games":
      return "Региональная ошибка входа";
    case "media":
      return "Геоблок или ограничение CDN";
    case "work":
      return "Геоблок по IP-адресу";
    default:
      return "Региональное ограничение IP";
  }
}

function buildDefaultWhyBlocked(shortName: string, categoryId: string, domains: string[], note?: string): string {
  if (note) return note;
  const mainDomain = domains[0] ?? shortName;
  switch (categoryId) {
    case "ai":
      return `Платформа ${shortName} (${mainDomain}) проверяет страну IP-адреса при входе и обращении к API и отклоняет прямые запросы из России и Беларуси сообщением о неподдерживаемом регионе или кодом 403.`;
    case "dev":
      return `Зарубежный сервис ${shortName} (${mainDomain}) ограничивает подключения с российских и белорусских IP-адресов на уровне CDN или балансировщика (коды ответа 403 Forbidden / 451), из-за чего не открываются документация, панель управления, пакеты или CLI-запросы.`;
    case "work":
      return `Рабочее пространство ${shortName} (${mainDomain}) закрывает прямой доступ по геолокации IP-адресов из региона, блокируя загрузку веб-интерфейса и синхронизацию приложений.`;
    case "media":
      return `Сервис ${shortName} (${mainDomain}) ограничивает доступ к контенту или режет качество потока для подключений с региональных IP-адресов.`;
    case "games":
      return `Сетевые службы аутентификации ${shortName} (${mainDomain}) проверяют регион IP-адреса при входе в аккаунт и отклоняют прямые подключения.`;
    default:
      return `Сервис ${shortName} (${mainDomain}) ограничивает прямой доступ по геолокации IP-адреса.`;
  }
}

function buildHowSolved(shortName: string, tier: "free" | "pro", pool: string, domains: string[]): string {
  const poolText =
    pool === "ai"
      ? "закреплённый узел ИИ-пула с постоянным зарубежным IP (без скачков локации и лишних капч)"
      : pool === "media"
        ? "выделенный медиа-пул для потокового трафика без вечерних просадок скорости"
        : "зарубежный узел общего пула с минимальной задержкой";
  const tierText =
    tier === "free"
      ? `Сервис входит в бесплатный каталог ${SITE.name} Free — регистрация и установка программ не нужны.`
      : `Сервис доступен в подписке ${SITE.name} Pro на незагруженных серверах с персональным токеном и привязкой домашнего IP.`;

  return `${SITE.name} отвечает адресом прокси-узла только на запросы к ${domains.length} базовым доменам ${shortName} (и всем их поддоменам), а прозрачный SNI-прокси передаёт зашифрованное TLS-соединение напрямую оригинальному серверу через ${poolText}. ${tierText} Банки, Госуслуги, маркетплейсы и весь остальной интернет продолжают работать напрямую через вашего провайдера.`;
}

function buildServiceFaq(params: {
  shortName: string;
  tier: "free" | "pro";
  categoryId: string;
  domains: string[];
  whyBlocked: string;
  caveat?: string;
}): FaqItem[] {
  const { shortName, tier, categoryId, domains, whyBlocked, caveat } = params;
  const sampleDomains = domains.slice(0, 4).join(", ");
  const items: FaqItem[] = [
    {
      q: `Почему ${shortName} не открывается напрямую из России или Беларуси?`,
      a: `<p>${whyBlocked} Это ограничение со стороны самого зарубежного сервиса или его CDN по геолокации вашего IP-адреса. Как только запросы к доменам ${shortName} идут через Smart DNS «${SITE.name}», сервис видит зарубежный адрес узла и штатно открывается.</p>`,
    },
    {
      q: tier === "free" ? `Доступ к ${shortName} через «${SITE.name}» действительно бесплатный?` : `В какой тариф входит ${shortName} — Free или Pro?`,
      a:
        tier === "free"
          ? `<p>Да. <strong>${shortName}</strong> входит в базовый бесплатный каталог «${SITE.name} Free» (адрес <code>${SITE.free.dot_host}</code> / <code>${SITE.free.dns_ip}</code>). Аккаунт и оплата не требуются. Если вам дополнительно понадобятся Notion, Miro, Coda, Adobe, Autodesk, Spotify, Xbox или максимальная скорость в вечерний прайм-тайм — они доступны в тарифе <a href="/pro">${SITE.name} Pro</a>.</p>`
          : `<p><strong>${shortName}</strong> входит в каталог подписки <a href="/pro#buy">${SITE.name} Pro</a>. Платный кластер использует отдельные незагруженные серверы, закрытые файрволом только для подписчиков, и помимо сервисов Pro включает все ${SITE.counts.free_services} сервисов бесплатного тарифа (ChatGPT, Claude, Gemini, Cursor, JetBrains и др.).</p>`,
    },
    {
      q: `Будут ли одновременно с ${shortName} работать российские банки, Госуслуги и локальная сеть?`,
      a: `<p>Да, без переключений. В отличие от VPN, который заворачивает весь трафик устройства в туннель, «${SITE.name}» срабатывает строго на фиксированный список доменов (${sampleDomains}${domains.length > 4 ? ` и ещё ${domains.length - 4}` : ""}). Российские сайты, банковские приложения, Кинопоиск, маркетплейсы, <code>localhost</code> и внутрикорпоративные ресурсы идут напрямую через вашего провайдера.</p>`,
    },
    {
      q: `Работает ли решение в мобильном приложении и десктопной программе ${shortName}, или только в браузере?`,
      a:
        categoryId === "dev"
          ? `<p>Если прописать DNS на уровне операционной системы (профиль iOS/macOS, «Частный DNS» на Android, настройки сети Windows/Linux или роутера), через него автоматически пойдут и браузер, и терминал (<code>curl</code>, CLI, пакетные менеджеры), и IDE. При включённом корпоративном VPN на ноутбуке можно использовать скрипт <a href="/setup/corporate-vpn">update_hosts.py</a>.</p>`
          : `<p>При настройке на уровне системы (профиль для iPhone/macOS, «Частный DNS» на Android, системный DNS Windows или домашний роутер) работают и сайт в браузере, и официальные приложения ${shortName}: сертификат TLS остаётся подлинным, поэтому приложения с проверкой сертификата (certificate pinning) подключаются без ошибок.</p>`,
    },
  ];

  if (caveat) {
    items.push({
      q: `Какие технические нюансы важно учитывать при работе с ${shortName}?`,
      a: `<p>${caveat}</p>`,
    });
  }

  return items;
}

function buildEntryFromCatalog(category: CatalogCategory, service: CatalogService): ServicePageData {
  const slug = serviceSlug(service);
  const ov = OVERRIDES[slug] ?? {};
  const shortName = ov.shortName ?? cleanShortName(service.name);
  const tier = category.tier;
  const domains = service.domains;
  const mainDomain = domains[0] ?? "";
  const errorBadge = ov.errorBadge ?? defaultErrorBadge(category.id, service.note);
  const whyBlocked = ov.whyBlocked ?? buildDefaultWhyBlocked(shortName, category.id, domains, service.note);
  const howSolved = ov.howSolved ?? buildHowSolved(shortName, tier, service.pool, domains);

  const defaultCaveat =
    category.id === "games"
      ? "Прозрачный SNI-прокси передаёт только TCP-соединения (порты 80 и 443) — авторизацию аккаунта, магазин и сетевые API. Быстрые UDP-пакеты игровых серверов идут напрямую без лишней задержки."
      : undefined;
  const caveat = ov.caveat ?? defaultCaveat;

  const tierSuffix = tier === "free" ? `бесплатный Smart DNS ${SITE.name}` : `Smart DNS ${SITE.name} Pro`;
  const title = ov.title ?? `Как открыть ${shortName} в России и Беларуси без VPN — ${tierSuffix}`;
  const description =
    ov.description ??
    `Доступ к ${shortName}${mainDomain ? ` (${mainDomain})` : ""} из России и Беларуси без установки VPN за 1 минуту через ${tierSuffix}. Сквозное шифрование TLS, российские сайты работают напрямую.`;
  const h1 = ov.h1 ?? `Как открыть ${shortName} в России и Беларуси без VPN`;
  const lead =
    ov.lead ??
    `${whyBlocked} Настройте ${tier === "free" ? `бесплатный Smart DNS «${SITE.name}»` : `Smart DNS «${SITE.name} Pro»`} один раз — ${shortName} будет открываться напрямую без VPN-клиента, расширений и замедления российских сайтов.`;

  const recommendedDevices = ov.recommendedDevices ?? defaultDevicesForCategory(category.id);
  const priority = ov.priority ?? (tier === "pro" ? 0.75 : service.note ? 0.72 : 0.65);

  return {
    slug,
    name: service.name,
    shortName,
    tier,
    categoryId: category.id,
    categoryName: category.name,
    pool: service.pool,
    domains,
    title,
    description,
    h1,
    lead,
    errorBadge,
    whyBlocked,
    howSolved,
    caveat,
    defaultWizardTab: ov.defaultWizardTab,
    recommendedDevices,
    faq: buildServiceFaq({ shortName, tier, categoryId: category.id, domains, whyBlocked, caveat }),
    priority,
  };
}

function buildAllServicePages(): ServicePageData[] {
  const basePages: ServicePageData[] = [];
  const bySlug = new Map<string, ServicePageData>();

  for (const cat of catalog.categories) {
    for (const svc of cat.services) {
      const page = buildEntryFromCatalog(cat, svc);
      basePages.push(page);
      bySlug.set(page.slug, page);
    }
  }

  for (const sub of SUB_PRODUCTS) {
    const parent = bySlug.get(sub.parentSlug);
    if (!parent || bySlug.has(sub.slug)) continue;

    // Поднимаем профильные домены саб-продукта в начало списка, сохраняя полный набор группы
    const primarySet = new Set(sub.primaryDomains ?? []);
    const orderedDomains = [
      ...(sub.primaryDomains?.filter((d) => parent.domains.includes(d)) ?? []),
      ...parent.domains.filter((d) => !primarySet.has(d)),
    ];

    const ov = sub.override;
    const errorBadge = ov.errorBadge ?? parent.errorBadge;
    const whyBlocked = ov.whyBlocked ?? parent.whyBlocked;
    const caveat = ov.caveat ?? parent.caveat;
    const howSolved = ov.howSolved ?? buildHowSolved(sub.shortName, parent.tier, parent.pool, orderedDomains);
    const tierSuffix = parent.tier === "free" ? `бесплатный Smart DNS ${SITE.name}` : `Smart DNS ${SITE.name} Pro`;

    const subPage: ServicePageData = {
      slug: sub.slug,
      name: sub.name,
      shortName: sub.shortName,
      parentSlug: parent.slug,
      parentName: parent.name,
      tier: parent.tier,
      categoryId: parent.categoryId,
      categoryName: parent.categoryName,
      pool: parent.pool,
      domains: orderedDomains,
      title: ov.title ?? `Как открыть ${sub.shortName} в России и Беларуси без VPN — ${tierSuffix}`,
      description:
        ov.description ??
        `Доступ к ${sub.shortName} из России и Беларуси без установки VPN за 1 минуту через ${tierSuffix}. Все российские сайты и банки работают напрямую.`,
      h1: ov.h1 ?? `Как открыть ${sub.shortName} в России и Беларуси без VPN`,
      lead: ov.lead ?? `${whyBlocked} Через «${SITE.name}» ${sub.shortName} работает без установки VPN-программ и без отключения российских сервисов.`,
      errorBadge,
      whyBlocked,
      howSolved,
      caveat,
      defaultWizardTab: ov.defaultWizardTab ?? parent.defaultWizardTab,
      recommendedDevices: ov.recommendedDevices ?? parent.recommendedDevices,
      faq: buildServiceFaq({
        shortName: sub.shortName,
        tier: parent.tier,
        categoryId: parent.categoryId,
        domains: orderedDomains,
        whyBlocked,
        caveat,
      }),
      priority: ov.priority ?? 0.78,
    };

    basePages.push(subPage);
    bySlug.set(subPage.slug, subPage);
  }

  return basePages;
}

const ALL_SERVICE_PAGES: ServicePageData[] = buildAllServicePages();
const SERVICE_MAP = new Map<string, ServicePageData>(ALL_SERVICE_PAGES.map((p) => [p.slug, p]));

export function allServicePages(): ServicePageData[] {
  return ALL_SERVICE_PAGES;
}

export function subProductDefinitions(): readonly SubProductDef[] {
  return SUB_PRODUCTS;
}

export function servicePageBySlug(slug: string): ServicePageData | undefined {
  return SERVICE_MAP.get(slug.toLowerCase());
}

export function relatedServicePages(current: ServicePageData, limit = 6): ServicePageData[] {
  const sameCat = ALL_SERVICE_PAGES.filter(
    (p) => p.categoryId === current.categoryId && p.slug !== current.slug && p.slug !== current.parentSlug,
  );
  // Сначала страницы с более высоким приоритетом (популярные сервисы категории)
  return [...sameCat].sort((a, b) => b.priority - a.priority).slice(0, limit);
}

export function poolSummaryForPage(pool: string): string {
  return poolLabel(pool);
}
