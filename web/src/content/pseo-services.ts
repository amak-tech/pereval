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

type SubProductDef = {
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
    description: `Решение ошибки «DeepL is not available in your region»: бесплатный Smart DNS ${SITE.name} возвращает работу сайта, десктопного приложения и API DeepL без VPN.`,
    h1: "Как открыть DeepL в России и Беларуси без VPN в 2026 году",
    errorBadge: "Unavailable in your region",
    recommendedDevices: ["windows-11", "macos", "iphone", "android", "browsers"],
    priority: 0.8,
  },
  swagger: {
    shortName: "Swagger / SmartBear",
    priority: 0.7,
  },
  notion: {
    shortName: "Notion",
    title: `Как открыть Notion в России без VPN в 2026 году (ошибка 403) — ${SITE.name} Pro`,
    description: `Возвращаем доступ к рабочим пространствам, базам знаний и приложению Notion на ПК и смартфоне без включения VPN через Smart DNS ${SITE.name} Pro.`,
    h1: "Как открыть Notion в России без VPN в 2026 году",
    errorBadge: "HTTP 403 Forbidden (IP РФ)",
    lead: "С сентября 2024 года Notion отвечает ошибкой 403 при прямом подключении с российских IP-адресов как в браузере, так и в нативных приложениях iOS, Android, macOS и Windows. В подписке Перевал Pro все домены Notion и статики открываются без запуска VPN и без помех для банковских приложений.",
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
  canva: {
    shortName: "Canva",
    title: `Как зайти в Canva из России без VPN в 2026 году — ${SITE.name} Pro`,
    description: `Открывайте редактор, шаблоны и общие макеты Canva без постоянных переключений VPN: быстрый доступ через Smart DNS ${SITE.name} Pro на компьютере и телефоне.`,
    h1: "Как открыть Canva в России без VPN в 2026 году",
    errorBadge: "HTTP 403 · Региональная заглушка",
    lead: "Canva закрывает доступ пользователям с российскими IP-адресами на уровне CDN, из-за чего не загружаются ни сам редактор, ни короткие ссылки canva.link. С персональным DNS Перевал Pro сервис работает напрямую в любом браузере и мобильном приложении.",
    recommendedDevices: ["windows-11", "macos", "browsers", "iphone", "android"],
    priority: 0.85,
  },
  adobe: {
    shortName: "Adobe Firefly и Creative Cloud",
    title: `Adobe Firefly и Creative Cloud без VPN в РФ и РБ — ${SITE.name} Pro`,
    description: `Как убрать Access Denied в Adobe Firefly и открыть сервисы Creative Cloud (adobe.com, adobelogin.com) из России и Беларуси без VPN с ${SITE.name} Pro.`,
    h1: "Как открыть Adobe Firefly и Creative Cloud без VPN",
    errorBadge: "Access Denied / Геоблок IP",
    recommendedDevices: ["macos", "windows-11", "browsers"],
    priority: 0.8,
  },
  airtable: {
    shortName: "Airtable",
    title: `Как открыть Airtable в России без VPN (обрыв соединения) — ${SITE.name} Pro`,
    description: `С февраля 2026 года серверы Airtable сбрасывают TLS-соединение с российских IP. Подключите ${SITE.name} Pro для работы с таблицами и API без VPN.`,
    h1: "Как открыть Airtable в России без VPN в 2026 году",
    errorBadge: "Сброс TLS-рукопожатия (IP РФ)",
    recommendedDevices: ["macos", "windows-11", "browsers", "corporate-vpn"],
    priority: 0.8,
  },
  grammarly: {
    shortName: "Grammarly",
    title: `Как включить Grammarly в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `Восстановите работу расширения браузера, редактора и клавиатуры Grammarly (ошибка 451 / обрыв соединения) без VPN через Smart DNS ${SITE.name} Pro.`,
    h1: "Как работать в Grammarly из России и Беларуси без VPN",
    errorBadge: "HTTP 451 (РБ) / Обрыв TLS (РФ)",
    recommendedDevices: ["browsers", "macos", "windows-11", "iphone", "android"],
    priority: 0.78,
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
  tiktok: {
    shortName: "TikTok",
    title: `Новый TikTok в России без VPN и модов на iPhone и Android — ${SITE.name} Pro`,
    description: `Актуальная мировая лента рекомендаций и загрузка видео в официальном приложении TikTok без модов и VPN через Smart DNS ${SITE.name} Pro.`,
    h1: "Как смотреть актуальный TikTok в России без VPN и модов",
    errorBadge: "Урезанный региональный режим с 2022",
    lead: "Для российских IP-адресов TikTok скрывает новые публикации и зарубежных авторов, показывая только старый архив. Через выделенный медиа-пул Перевал Pro открывается полноценная лента в браузере и приложении.",
    caveat: "На смартфонах мобильное приложение TikTok дополнительно считывает код страны SIM-карты (MCC/MNC оператора). На ПК, планшетах Wi-Fi и в мобильном браузере новая лента открывается сразу после настройки DNS; в приложении на телефоне может потребоваться вход через веб-версию или устройство без российской SIM.",
    recommendedDevices: ["iphone", "android", "browsers", "keenetic"],
    priority: 0.82,
  },
  twitch: {
    shortName: "Twitch 1080p",
    title: `Twitch 1080p60 без лагов и VPN в России — ${SITE.name} Pro`,
    description: `Как вернуть качество 1080p60 на стримах Twitch на ПК, Smart TV и телефоне без просадок скорости и системного VPN с помощью медиа-пула ${SITE.name} Pro.`,
    h1: "Как смотреть Twitch в 1080p60 из России без VPN",
    errorBadge: "Ограничение 720p на прямом маршруте",
    lead: "При прямом подключении от российских провайдеров трансляции Twitch часто ограничиваются разрешением 720p или страдают от буферизации вечером. Медиа-пул Перевал Pro маршрутизирует домены плеера и видео-CDN (ttvnw.net), возвращая поток 1080p60 на ПК, смартфонах и телевизорах через роутер.",
    recommendedDevices: ["windows-11", "keenetic", "mikrotik", "android", "iphone"],
    priority: 0.8,
  },
  elevenlabs: {
    shortName: "ElevenLabs",
    title: `Как открыть ElevenLabs и синтез речи в РФ и РБ без VPN — ${SITE.name} Pro`,
    description: `Доступ к озвучке, клонированию голоса и API ElevenLabs из России и Беларуси без VPN на постоянном узле ИИ-пула ${SITE.name} Pro.`,
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
    title: `Как зайти в игры Supercell (Brawl Stars, Clash Royale) без VPN — ${SITE.name} Pro`,
    description: `Решение ошибки «Ваше текущее местоположение не позволяет выполнить вход» в Brawl Stars, Clash Royale и Clash of Clans через частный DNS ${SITE.name} Pro.`,
    h1: "Как зайти в игры Supercell и Supercell ID без VPN",
    errorBadge: "Вход ограничен по местоположению",
    recommendedDevices: ["iphone", "android", "keenetic"],
    priority: 0.82,
  },
  "geforce-now": {
    shortName: "GeForce NOW",
    title: `NVIDIA GeForce NOW (GFN) из России и Беларуси через DNS — ${SITE.name} Pro`,
    description: `Как открыть авторизацию и каталог игр NVIDIA GeForce NOW из неподдерживаемого региона (РФ и РБ) и какие ограничения есть у UDP-стриминга.`,
    h1: "Доступ к NVIDIA GeForce NOW из России и Беларуси",
    errorBadge: "Регион вне списка GFN",
    caveat: "Важно: Smart DNS проксирует только TCP-соединения (вход в аккаунт NVIDIA, выбор сервера и запуск сессии по HTTPS), но НЕ туннелирует видеопоток облачного гейминга по протоколу UDP/WebRTC. Если выбранный альянс-сервер GFN проверяет IP и на UDP-потоке самой игры, для стриминга потребуется полноценный UDP-туннель.",
    recommendedDevices: ["windows-11", "macos", "keenetic"],
    priority: 0.72,
  },
};

const SUB_PRODUCTS: SubProductDef[] = [
  {
    slug: "brawl-stars",
    parentSlug: "supercell",
    name: "Brawl Stars (Supercell)",
    shortName: "Brawl Stars",
    primaryDomains: ["brawlstarsgame.com", "supercellid.com", "supercell.com", "supercellgames.com"],
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
    primaryDomains: ["clashroyale.com", "supercellid.com", "supercell.com", "supercellgames.com"],
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
    slug: "suno",
    parentSlug: "elevenlabs",
    name: "Suno AI",
    shortName: "Suno AI",
    primaryDomains: ["suno.com", "suno.ai"],
    override: {
      title: `Как открыть Suno AI в России и Беларуси без VPN — генерация музыки | ${SITE.name} Pro`,
      description: `Создавайте песни и треки в нейросети Suno AI (suno.com) без тормозов VPN: стабильный доступ через ИИ-пул с постоянным IP в ${SITE.name} Pro.`,
      h1: "Как пользоваться Suno AI в России и Беларуси без VPN",
      errorBadge: "Региональное ограничение IP",
      recommendedDevices: ["windows-11", "macos", "iphone", "android", "browsers"],
      priority: 0.8,
    },
  },
  {
    slug: "adobe-firefly",
    parentSlug: "adobe",
    name: "Adobe Firefly",
    shortName: "Adobe Firefly",
    primaryDomains: ["adobe.com", "adobelogin.com", "adobe.io"],
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
          ? `<p>Да. <strong>${shortName}</strong> входит в базовый бесплатный каталог «${SITE.name} Free» (адрес <code>${SITE.free.dot_host}</code> / <code>${SITE.free.dns_ip}</code>). Аккаунт и оплата не требуются. Если вам дополнительно понадобятся Notion, Miro, Canva, Spotify, TikTok, Xbox или максимальная скорость в вечерний прайм-тайм — они доступны в тарифе <a href="/pro">${SITE.name} Pro</a>.</p>`
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
