import type { ReactNode } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { CopyField } from "@/components/CopyButton";
import type { FaqItem } from "@/content/faq";
import { SITE } from "@/content/site";

export type DeviceGroup = "personal" | "routers" | "consoles" | "developers";

export type DeviceGuideData = {
  slug: string;
  name: string;
  shortName: string;
  group: DeviceGroup;
  groupLabel: string;
  protocolBadge: string;
  tierNote: "free_and_pro" | "pro_recommended";
  title: string;
  description: string;
  h1: string;
  lead: string;
  summary: string;
  howToSteps: { name: string; text: string }[];
  content: ReactNode;
  troubleshooting: { symptom: string; fix: string }[];
  popularServiceSlugs: string[];
  faq: FaqItem[];
  priority: number;
};

function Steps({ children }: { children: ReactNode }) {
  return <ol className="m-0 grid list-none gap-4 p-0 [counter-reset:step]">{children}</ol>;
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="card flex gap-3.5 [counter-increment:step]">
      <span
        aria-hidden
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent before:content-[counter(step)]"
      />
      <div className="min-w-0 flex-1 text-[15px] leading-relaxed">
        <h3 className="m-0 mb-1.5 text-[16px] font-semibold text-ink">{title}</h3>
        <div className="grid gap-3 text-mute [&_strong]:text-ink">{children}</div>
      </div>
    </li>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="m-0 overflow-x-auto rounded-lg bg-code p-3.5 text-[13px] leading-relaxed text-ink">
      <code>{children}</code>
    </pre>
  );
}

const FREE_IP = SITE.free.dns_ip;
const FREE_DOH = SITE.free.doh_url;
const FREE_DOT = SITE.free.dot_host;
const PRO_IP = SITE.pro?.dns_ip ?? "85.209.148.147";
const PRO_DOMAIN = SITE.pro?.domain ?? "pro.pereval.top";

const GUIDES: DeviceGuideData[] = [
  {
    slug: "iphone",
    name: "iPhone и iPad (iOS / iPadOS)",
    shortName: "iPhone и iPad",
    group: "personal",
    groupLabel: "Смартфоны и компьютеры",
    protocolBadge: "Профиль DNS-over-HTTPS (.mobileconfig)",
    tierNote: "free_and_pro",
    title: `Настройка Smart DNS на iPhone и iPad без VPN (профиль iOS) — ${SITE.name}`,
    description: `Пошаговая установка зашифрованного DNS ${SITE.name} на iPhone и iPad за 30 секунд: готовый профиль .mobileconfig для ChatGPT, Claude, Gemini, Notion, Spotify и Brawl Stars без VPN.`,
    h1: "Как настроить Smart DNS на iPhone и iPad без VPN",
    lead: "В iOS 14 и новее встроена системная поддержка зашифрованных профилей DNS. Один лёгкий конфигурационный файл .mobileconfig включает доступ к зарубежным сервисам сразу и по домашнему Wi-Fi, и в мобильной сети LTE/5G — без фонового VPN-туннеля и лишнего расхода батареи.",
    summary: "Официальный профиль .mobileconfig для Wi-Fi и сотовой сети за 30 секунд в Safari.",
    howToSteps: [
      { name: "Скачайте профиль в Safari", text: `Откройте страницу в браузере Safari, нажмите «Скачать профиль для iOS» и разрешите загрузку конфигурационного файла.` },
      { name: "Установите профиль в Настройках", text: "Откройте приложение «Настройки», нажмите «Профиль загружен» под вашим именем и подтвердите установку кодом-паролем." },
      { name: "Проверьте выбранный DNS", text: `Убедитесь, что в разделе «Настройки → Основные → VPN и управление устройством → DNS» отмечен профиль «${SITE.name} DNS».` },
    ],
    content: (
      <div className="grid gap-5">
        <Steps>
          <Step title="Скачайте конфигурационный профиль через Safari">
            <p className="m-0">
              Откройте эту страницу именно в <strong>Safari</strong> (сторонние браузеры на iOS сохраняют файл в «Загрузки» вместо передачи в системные настройки). Во всплывающем окне нажмите <strong>«Разрешить»</strong>.
            </p>
            <div className="flex flex-wrap gap-2.5 pt-1">
              <a className="btn-primary" href={SITE.appleProfilePath} download={`${FREE_DOT}.mobileconfig`}>
                <Download className="h-4 w-4" aria-hidden /> Скачать бесплатный профиль iOS
              </a>
              <Link className="btn-secondary" href="/account">
                Персональный профиль Pro (в кабинете)
              </Link>
            </div>
          </Step>
          <Step title="Подтвердите установку в системных настройках">
            <p className="m-0">
              Откройте системное приложение <strong>«Настройки»</strong> — сразу под вашим Apple ID появится строка <strong>«Профиль загружен»</strong>. Нажмите на неё, затем дважды нажмите «Установить» в правом верхнем углу и введите код-пароль разблокировки экрана.
            </p>
          </Step>
          <Step title="Убедитесь, что профиль активен">
            <p className="m-0">
              Перейдите в <strong>«Настройки» → «Основные» → «VPN и управление устройством» → «DNS»</strong> и проверьте, что галочка стоит напротив <strong>{SITE.name} DNS</strong>. Начиная с этого момента Safari и все установленные приложения используют зашифрованный DNS-over-HTTPS.
            </p>
          </Step>
        </Steps>

        <div className="card">
          <h3 className="m-0 text-[16px] font-semibold">Альтернатива: вручную только для одной сети Wi-Fi</h3>
          <p className="m-0 mt-1.5 text-sm text-mute">
            Если вы не хотите ставить системный профиль, укажите IPv4-адрес сервера в свойствах домашнего Wi-Fi («Настройки» → «Wi-Fi» → значок <strong>ⓘ</strong> → «Настройка DNS» → «Вручную», удалите старые записи и добавьте адрес ниже):
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <CopyField label={`DNS IPv4 (${SITE.name} Free)`} value={FREE_IP} />
            <CopyField label={`DNS IPv4 (${SITE.name} Pro — после привязки IP)`} value={PRO_IP} />
          </div>
        </div>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "В «Настройках» не появился пункт «Профиль загружен»",
        fix: "Скорее всего файл скачали через Chrome, Telegram или Яндекс.Браузер. Откройте приложение «Файлы» → «Загрузки», нажмите на файл .mobileconfig либо скачайте его заново через стандартный Safari.",
      },
      {
        symptom: "Включён «Частный узел iCloud» (iCloud Private Relay) и сайты не видят подмену DNS",
        fix: "В Safari функция iCloud Private Relay использует собственные прокси Apple и игнорирует профили DNS. Если она активна в подписке iCloud+, отключите её для конкретного сайта или временно в «Настройки → Apple ID → iCloud → Частный узел».",
      },
      {
        symptom: "Как быстро выключить или удалить профиль?",
        fix: `Перейдите в «Настройки → Основные → VPN и управление устройством → DNS» и переключите на «Автоматически», либо удалите профиль «${SITE.name} DNS» одной кнопкой.`,
      },
    ],
    popularServiceSlugs: ["chatgpt", "claude", "gemini", "spotify", "notion", "brawl-stars", "dyson", "home-connect"],
    faq: [
      {
        q: "Безопасно ли устанавливать профиль .mobileconfig на iPhone?",
        a: `<p>Да. Профиль представляет собой открытый текстовый XML-файл со стандартной секцией <code>com.apple.dnsSettings.managed</code>: в нём указан только адрес DNS-сервера (<code>${FREE_DOT}</code> или ваш персональный поддомен Pro). В нём нет корневых сертификатов, VPN-конфигураций или прав на управление устройством (MDM).</p>`,
      },
      {
        q: "Сажает ли такой профиль аккумулятор, как обычный VPN?",
        a: "<p>Нет. iOS не держит постоянный фоновый туннель для видео и мессенджеров — система просто отправляет стандартные DNS-запросы по защищённому соединению TLS, как к любому облачному резолверу.</p>",
      },
      {
        q: "Будут ли работать приложения банков, такси и Apple CarPlay?",
        a: "<p>Да, в полном объёме. Российские домены не входят в список перенаправления и разрешаются напрямую в обычные IP-адреса, а локальное беспроводное соединение CarPlay вообще не затрагивается.</p>",
      },
    ],
    priority: 0.82,
  },
  {
    slug: "android",
    name: "Android (Samsung, Xiaomi, Pixel и др.)",
    shortName: "Android",
    group: "personal",
    groupLabel: "Смартфоны и компьютеры",
    protocolBadge: "Встроенный «Частный DNS» (DoT)",
    tierNote: "free_and_pro",
    title: `Частный DNS на Android для ChatGPT, Gemini и игр без VPN — ${SITE.name}`,
    description: `Как прописать Частный DNS (Private DNS) ${SITE.name} на Android, Samsung One UI и Xiaomi HyperOS за 30 секунд без приложений: доступ к ИИ, Spotify и Brawl Stars.`,
    h1: "Как настроить Частный DNS на Android без VPN",
    lead: "На всех смартфонах с Android 9 и новее есть штатная функция «Частный DNS» (Private DNS / DNS-over-TLS). Достаточно вставить одну строчку с именем сервера — настройка работает сразу и в мобильной сети оператора, и в любой сети Wi-Fi без установки сторонних APK.",
    summary: "Штатная функция «Частный DNS» в настройках сети Android 9+ без установки приложений.",
    howToSteps: [
      { name: "Откройте раздел Частный DNS", text: "Зайдите в «Настройки → Сеть и интернет → Частный DNS» (на Samsung — «Подключения → Другие настройки», на Xiaomi — «Подключение и общий доступ»)." },
      { name: "Выберите ручной ввод имени хоста", text: "Переключите режим на «Имя хоста поставщика частного DNS» (Private DNS provider hostname)." },
      { name: "Вставьте адрес сервера и сохраните", text: `Укажите ${FREE_DOT} (или персональный адрес <токен>.${PRO_DOMAIN} из кабинета Pro) и нажмите «Сохранить».` },
    ],
    content: (
      <div className="grid gap-5">
        <Steps>
          <Step title="Откройте системную настройку «Частный DNS»">
            <p className="m-0">Путь в меню немного отличается в зависимости от оболочки производителя (удобнее всего набрать слово «DNS» в поиске по настройкам):</p>
            <ul className="m-0 list-disc pl-5 text-sm">
              <li><strong>Чистый Android (Pixel, Motorola, Nothing):</strong> «Настройки» → «Сеть и интернет» → «Частный DNS».</li>
              <li><strong>Samsung (One UI):</strong> «Настройки» → «Подключения» → «Другие настройки подключения» → «Частный DNS-сервер».</li>
              <li><strong>Xiaomi, Redmi, POCO (HyperOS / MIUI):</strong> «Настройки» → «Подключение и общий доступ» → «Частный DNS-сервер».</li>
              <li><strong>Honor, Huawei, Realme, OnePlus:</strong> «Настройки» → «Мобильная сеть» (или «Подключения») → «Частный DNS».</li>
            </ul>
          </Step>
          <Step title="Укажите имя хоста провайдера частного DNS">
            <p className="m-0">
              Выберите пункт <strong>«Имя хоста поставщика частного DNS»</strong> (в поле нельзя вводить цифры IP — только текстовое доменное имя):
            </p>
            <CopyField label={`Имя хоста DoT (${SITE.name} Free)`} value={FREE_DOT} />
            <CopyField label={`Шаблон для ${SITE.name} Pro (токен берётся в кабинете)`} value={`<ваш-токен>.${PRO_DOMAIN}`} />
          </Step>
          <Step title="Сохраните и проверьте работу">
            <p className="m-0">
              Нажмите <strong>«Сохранить»</strong>. Если под пунктом написано имя хоста (без сообщения «Не удаётся подключиться»), смартфон успешно установил TLS-сессию с сервером на порту 853.
            </p>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "Android пишет «Не удаётся подключиться» к частному DNS",
        fix: "Проверьте, что в поле нет лишних пробелов, префикса https:// и косой черты / в конце — должно быть только доменное имя. Также убедитесь, что публичная гостевая Wi-Fi сеть (в кафе или метро) не блокирует TCP-порт 853.",
      },
      {
        symptom: "В браузере Chrome на Android сервис всё равно недоступен в регионе",
        fix: "Chrome на Android может использовать собственный «Безопасный DNS» (Google/Cloudflare) поверх системного. Зайдите в настройки самого Chrome → «Конфиденциальность и безопасность» → «Безопасный DNS» и выключите его или выберите «Использовать текущего поставщика услуг».",
      },
      {
        symptom: "Конфликт с приложением AdGuard или рабочим VPN",
        fix: "Если на телефоне запущен локальный блокировщик рекламы в режиме VPN, укажите наш DoH/DoT-сервер прямо внутри настроек DNS самого AdGuard.",
      },
    ],
    popularServiceSlugs: ["gemini", "chatgpt", "claude", "spotify", "brawl-stars", "clash-royale", "notion", "dyson"],
    faq: [
      {
        q: "Почему в поле «Частный DNS» на Android нельзя ввести IP-адрес цифрами?",
        a: `<p>Стандарт Android Private DNS работает строго по протоколу DNS-over-TLS (RFC 7858) и проверяет TLS-сертификат по доменному имени. Поэтому туда вводится домен <code>${FREE_DOT}</code> (для бесплатного тарифа) или ваш персональный поддомен <code>&lt;токен&gt;.${PRO_DOMAIN}</code> (для подписки Pro).</p>`,
      },
      {
        q: "Работает ли Частный DNS в мобильном интернете 4G/LTE?",
        a: "<p>Да. В отличие от ручной настройки DNS в параметрах Wi-Fi, системный «Частный DNS» действует глобально и для всех сетей Wi-Fi, и для мобильной передачи данных любых операторов.</p>",
      },
    ],
    priority: 0.85,
  },
  {
    slug: "windows-11",
    name: "Windows 11 и Windows 10",
    shortName: "Windows 11 / 10",
    group: "personal",
    groupLabel: "Смартфоны и компьютеры",
    protocolBadge: "DNS-over-HTTPS (DoH) и IPv4",
    tierNote: "free_and_pro",
    title: `Настройка Smart DNS и DoH в Windows 11 и Windows 10 без VPN — ${SITE.name}`,
    description: `Пошаговая инструкция по настройке зашифрованного DNS (DoH) ${SITE.name} в Windows 11 и Windows 10 через Параметры или PowerShell для ChatGPT, Cursor, Miro и игр.`,
    h1: "Как настроить Smart DNS в Windows 11 и Windows 10 без VPN",
    lead: "В Windows 11 встроена нативная поддержка зашифрованного протокола DNS-over-HTTPS (DoH) на уровне всей системы — запросы шифруются даже если провайдер перехватывает обычный порт 53. В Windows 10 можно прописать IPv4-адрес сервера в свойствах адаптера или включить DoH в браузере.",
    summary: "Штатный шифрованный DNS-over-HTTPS в Windows 11, настройка Windows 10 и готовый скрипт PowerShell.",
    howToSteps: [
      { name: "Откройте параметры сетевого адаптера", text: "Зайдите в «Параметры → Сеть и Интернет → Wi-Fi (или Ethernet) → Свойства оборудования»." },
      { name: "Пропишите адрес предпочтительного DNS IPv4", text: `Нажмите «Изменить» напротив «Назначение DNS-сервера», выберите «Вручную», включите IPv4 и введите ${FREE_IP}.` },
      { name: "Включите шифрование DNS через HTTPS (Windows 11)", text: `Выберите «Вкл. (ручной шаблон)», вставьте ${FREE_DOH}, оставьте IPv6 выключенным и нажмите «Сохранить».` },
    ],
    content: (
      <div className="grid gap-5">
        <Steps>
          <Step title="Откройте настройки активного подключения">
            <p className="m-0">
              Нажмите <strong>Win + I</strong> → <strong>«Сеть и Интернет»</strong> → выберите активное подключение (<strong>«Wi-Fi»</strong> или <strong>«Ethernet»</strong>) → <strong>«Свойства оборудования»</strong>.
            </p>
          </Step>
          <Step title="Укажите IPv4-адрес и шаблон DoH (для тарифа Free или Pro)">
            <p className="m-0">
              Рядом с пунктом «Назначение DNS-сервера» нажмите <strong>«Изменить»</strong> → переключите на <strong>«Вручную»</strong> → включите тумблер <strong>IPv4</strong>:
            </p>
            <CopyField label={`Предпочтительный DNS IPv4 (${SITE.name} Free)`} value={FREE_IP} />
            <CopyField label={`Шаблон DNS через HTTPS в Windows 11 (${SITE.name} Free)`} value={FREE_DOH} />
            <p className="m-0 text-sm">
              <strong>Для подписчиков {SITE.name} Pro:</strong> привяжите текущий домашний IP в <Link href="/account">личном кабинете</Link>, укажите в IPv4 адрес <code>{PRO_IP}</code>, а в поле шаблона DoH — персональную ссылку <code>https://{PRO_DOMAIN}/dns/&lt;ваш-токен&gt;</code>.
            </p>
          </Step>
          <Step title="Отключите IPv6 для DNS и сохраните">
            <p className="m-0">
              Тумблер <strong>IPv6</strong> в этом окне оставьте выключенным, альтернативный DNS — пустым, и нажмите <strong>«Сохранить»</strong>. В Windows 10 поля «DNS через HTTPS» нет — достаточно сохранить IPv4-адрес.
            </p>
          </Step>
        </Steps>

        <div className="card">
          <h3 className="m-0 text-[16px] font-semibold">Быстрая настройка через PowerShell (от имени администратора)</h3>
          <p className="m-0 mt-1.5 text-sm text-mute">
            Замените <code>&quot;Wi-Fi&quot;</code> на <code>&quot;Ethernet&quot;</code>, если компьютер подключён кабелем (список адаптеров покажет <code>Get-NetAdapter</code>):
          </p>
          <div className="mt-3">
            <CodeBlock>{`Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ${FREE_IP}
# Windows 11: зарегистрировать и включить шаблон DNS-over-HTTPS
Add-DnsClientDohServerAddress -ServerAddress ${FREE_IP} -DohTemplate "${FREE_DOH}" -AllowFallbackToUdp $false -AutoUpgrade $true
Clear-DnsClientCache

# Как вернуть стандартные настройки провайдера (DHCP):
# Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ResetServerAddresses`}</CodeBlock>
          </div>
        </div>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "В терминале и приложениях всё работает, а в Chrome / Edge сайт пишет о недоступности региона",
        fix: `Браузеры на движке Chromium часто используют собственный встроенный DoH-резолвер в обход Windows. Зайдите в настройки безопасности браузера и укажите там ${FREE_DOH} (или персональную ссылку Pro), либо отключите встроенный «Безопасный DNS».`,
      },
      {
        symptom: "В Windows 10 провайдер подменяет обычные DNS-запросы на порту 53",
        fix: "Если интернет-провайдер принудительно заворачивает UDP/53 на свой резолвер, настройте шифрованный DNS-over-HTTPS в браузере (/setup/browsers) или на домашнем роутере Keenetic / MikroTik.",
      },
    ],
    popularServiceSlugs: ["chatgpt", "cursor", "jetbrains", "miro", "notion", "spotify", "autodesk", "github-copilot"],
    faq: [
      {
        q: "Нужно ли перезагружать Windows после смены DNS?",
        a: "<p>Нет, настройки применяются мгновенно. Если сервис уже был открыт в браузере до настройки, достаточно сбросить кэш командой <code>ipconfig /flushdns</code> и обновить вкладку через <code>Ctrl + F5</code>.</p>",
      },
      {
        q: "Не мешает ли настройка онлайн-играм (Steam, CS2, Dota 2, Valorant)?",
        a: "<p>Абсолютно не мешает. Домены Steam и игровых серверов не входят в список перенаправления, поэтому разрешаются в ближайшие локальные CDN-узлы с вашим обычным пингом и полной скоростью тарифа.</p>",
      },
    ],
    priority: 0.85,
  },
  {
    slug: "macos",
    name: "macOS (Sonoma, Sequoia, Ventura)",
    shortName: "macOS",
    group: "personal",
    groupLabel: "Смартфоны и компьютеры",
    protocolBadge: "Профиль .mobileconfig или networksetup",
    tierNote: "free_and_pro",
    title: `Настройка Smart DNS на Mac (macOS) без VPN для разработки и работы — ${SITE.name}`,
    description: `Как настроить зашифрованный DNS ${SITE.name} на MacBook и Mac mini за 1 минуту: системный профиль .mobileconfig и терминал для Claude Code, Cursor, JetBrains, Notion и Miro.`,
    h1: "Как настроить Smart DNS на macOS без VPN",
    lead: "На компьютерах Mac (macOS 11 Big Sur и новее, включая Sonoma и Sequoia) удобнее всего установить системный профиль зашифрованного DNS: он работает сразу для Wi-Fi, док-станции Ethernet и режима модема с iPhone, охватывая Safari, Chrome, IDE и утилиты в терминале.",
    summary: "Системный профиль для всех сетевых интерфейсов Mac или команды networksetup в терминале.",
    howToSteps: [
      { name: "Скачайте файл .mobileconfig", text: "Загрузите профиль конфигурации для macOS и дважды щёлкните по файлу в папке «Загрузки»." },
      { name: "Откройте раздел Управление устройством", text: "Перейдите в «Системные настройки → Основные → Управление устройством» (на Ventura: «Конфиденциальность и безопасность → Профили»)." },
      { name: "Установите профиль", text: `Дважды нажмите на профиль «${SITE.name} DNS», выберите «Установить» и введите пароль учётной записи Mac.` },
    ],
    content: (
      <div className="grid gap-5">
        <Steps>
          <Step title="Скачайте профиль конфигурации macOS">
            <p className="m-0">
              Нажмите кнопку ниже, чтобы скачать готовый профиль DNS-over-HTTPS (если браузер сохранил файл с расширением <code>.xml</code> или <code>.txt</code>, переименуйте его так, чтобы он оканчивался на <code>.mobileconfig</code>):
            </p>
            <div className="flex flex-wrap gap-2.5 pt-1">
              <a className="btn-primary" href={SITE.appleProfilePath} download={`${FREE_DOT}.mobileconfig`}>
                <Download className="h-4 w-4" aria-hidden /> Скачать бесплатный профиль macOS
              </a>
              <Link className="btn-secondary" href="/account">
                Персональный профиль Pro (в кабинете)
              </Link>
            </div>
          </Step>
          <Step title="Активируйте профиль в Системных настройках">
            <p className="m-0">
              Дважды щёлкните скачанный файл, затем откройте <strong>«Системные настройки» → «Основные» → «Управление устройством»</strong>, дважды нажмите на <strong>{SITE.name} DNS</strong> → «Установить» и подтвердите паролем администратора или Touch ID.
            </p>
          </Step>
          <Step title="Альтернатива для разработчиков: через терминал (IPv4)">
            <p className="m-0">Если удобнее привязать DNS только к Wi-Fi без профиля, выполните команды:</p>
            <CodeBlock>{`networksetup -setdnsservers Wi-Fi ${FREE_IP}
dscacheutil -flushcache && sudo killall -HUP mDNSResponder

# Проверить текущие серверы:
networksetup -getdnsservers Wi-Fi
# Вернуть автоматический DNS от роутера:
networksetup -setdnsservers Wi-Fi empty`}</CodeBlock>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "Пометка «Не проверен» (Unverified) рядом с профилем в macOS",
        fix: "Это стандартное уведомление macOS для конфигурационных файлов, не подписанных корпоративным MDM-сертификатом. Содержимое файла открыто — вы можете открыть .mobileconfig любым текстовым редактором и убедиться, что там указан только адрес DNS.",
      },
      {
        symptom: "На рабочем MacBook включён Cloudflare WARP, Cisco AnyConnect или корпоративный WireGuard",
        fix: "Корпоративные VPN перехватывают системный резолвер macOS. Чтобы Claude, Cursor и ChatGPT работали одновременно с рабочим VPN, используйте штатный скрипт update_hosts.py — см. инструкцию «Корпоративный VPN».",
      },
    ],
    popularServiceSlugs: ["claude", "cursor", "chatgpt", "jetbrains", "notion", "miro", "adobe", "terraform"],
    faq: [
      {
        q: "Где быстро выключить и снова включить профиль в macOS Sonoma / Sequoia?",
        a: `<p>Удалять профиль не обязательно: в «Системные настройки → Сеть → VPN и фильтры» можно временно переключить фильтр DNS «${SITE.name} DNS» в положение «Неактивно» и включить обратно в один клик.</p>`,
      },
      {
        q: "Подхватывают ли эту настройку Node.js, Python, curl и Docker на Mac?",
        a: "<p>Консольные утилиты на самом хосте (<code>curl</code>, <code>python</code>, <code>node</code>, Claude Code, Cursor) используют системный резолвер macOS и работают сразу. Внутри изолированных контейнеров Docker Desktop при необходимости можно указать <code>--dns 153.80.200.170</code>.</p>",
      },
    ],
    priority: 0.82,
  },
  {
    slug: "linux",
    name: "Linux (Ubuntu, Fedora, Debian, Arch)",
    shortName: "Linux",
    group: "developers",
    groupLabel: "Для разработчиков и ОС",
    protocolBadge: "NetworkManager / systemd-resolved",
    tierNote: "free_and_pro",
    title: `Настройка Smart DNS в Linux (Ubuntu, Fedora, systemd-resolved) — ${SITE.name}`,
    description: `Команды настройки DNS и DNS-over-TLS ${SITE.name} в Linux через nmcli и systemd-resolved для работы CLI, Docker, Terraform, Claude Code и JetBrains без VPN.`,
    h1: "Как настроить Smart DNS в Linux без VPN",
    lead: "В современных дистрибутивах Linux (Ubuntu, Debian, Fedora, Arch, Mint) настройка занимает три команды в NetworkManager или systemd-resolved — включая полноценное шифрование DNS-over-TLS без сторонних демонов.",
    summary: "Настройка через nmcli, systemd-resolved (включая DoT) и проверка через resolvectl / dig.",
    howToSteps: [
      { name: "Определите активное соединение", text: "Выполните nmcli con show, чтобы узнать имя сетевого профиля Wi-Fi или проводного подключения." },
      { name: "Задайте сервер DNS и отключите авто-DNS от DHCP", text: `Выполните nmcli con mod "<имя>" ipv4.dns "${FREE_IP}" ipv4.ignore-auto-dns yes ipv6.ignore-auto-dns yes.` },
      { name: "Примените профиль и сбросьте кэш", text: "Переподключите интерфейс командой nmcli con up \"<имя>\" и проверьте статус через resolvectl status." },
    ],
    content: (
      <div className="grid gap-5">
        <Steps>
          <Step title="Через NetworkManager (Ubuntu, Fedora, Linux Mint)">
            <p className="m-0">Откройте терминал и привяжите DNS к вашему подключению (также отключаем автополучение IPv6-DNS от роутера):</p>
            <CodeBlock>{`nmcli con show
# подставьте имя вашего активного подключения вместо "Wired connection 1"
nmcli con mod "Wired connection 1" ipv4.dns "${FREE_IP}"
nmcli con mod "Wired connection 1" ipv4.ignore-auto-dns yes
nmcli con mod "Wired connection 1" ipv6.ignore-auto-dns yes
nmcli con up "Wired connection 1"`}</CodeBlock>
          </Step>
          <Step title="Шифрованный DNS-over-TLS через systemd-resolved">
            <p className="m-0">
              Если провайдер перехватывает обычный UDP/53, включите проверку TLS по имени хоста в <code>/etc/systemd/resolved.conf.d/pereval.conf</code>:
            </p>
            <CodeBlock>{`sudo mkdir -p /etc/systemd/resolved.conf.d
sudo tee /etc/systemd/resolved.conf.d/pereval.conf >/dev/null <<'EOF'
[Resolve]
DNS=${FREE_IP}#${FREE_DOT}
DNSOverTLS=yes
Domains=~.
EOF
sudo systemctl restart systemd-resolved
resolvectl status`}</CodeBlock>
            <p className="m-0 text-sm">
              Для подписки <strong>{SITE.name} Pro</strong> подставьте <code>DNS={PRO_IP}#&lt;ваш-токен&gt;.{PRO_DOMAIN}</code> — в этом режиме авторизация идёт сразу по SNI-токену даже с динамического IP!
            </p>
          </Step>
          <Step title="Проверка резолвинга в терминале">
            <CodeBlock>{`resolvectl query claude.ai
curl -I https://claude.ai`}</CodeBlock>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "В resolvectl status всё ещё отображаются DNS-серверы провайдера (192.168.1.1 или IPv6)",
        fix: "Убедитесь, что выставлены оба параметра ipv4.ignore-auto-dns yes и ipv6.ignore-auto-dns yes, а также добавлен маршрут Domains=~. в systemd-resolved.",
      },
      {
        symptom: "Контейнеры Docker на Linux не видят хостовый 127.0.0.53",
        fix: `Добавьте "dns": ["${FREE_IP}"] в /etc/docker/daemon.json и перезапустите демон docker, чтобы сборки и контейнеры тоже разрешали реестры и API через Smart DNS.`,
      },
    ],
    popularServiceSlugs: ["claude", "chatgpt", "cursor", "jetbrains", "terraform", "hashicorp", "mongodb", "sentry"],
    faq: [
      {
        q: "Как авторизоваться в Перевал Pro на Linux-сервере без привязки IP?",
        a: `<p>Используйте <code>systemd-resolved</code> с записью вида <code>DNS=${PRO_IP}#&lt;ваш-токен&gt;.${PRO_DOMAIN}</code> и <code>DNSOverTLS=yes</code>: демон передаёт ваш токен в SNI на порт 853 и автоматически открывает доступ для текущего IP узла.</p>`,
      },
    ],
    priority: 0.75,
  },
  {
    slug: "browsers",
    name: "Браузеры (Chrome, Яндекс, Edge, Firefox)",
    shortName: "Браузеры (DoH)",
    group: "personal",
    groupLabel: "Смартфоны и компьютеры",
    protocolBadge: "DNS-over-HTTPS только в браузере",
    tierNote: "free_and_pro",
    title: `Настройка безопасного DNS (DoH) в Chrome, Яндекс.Браузере и Firefox — ${SITE.name}`,
    description: `Как включить Smart DNS ${SITE.name} только внутри браузера Chrome, Edge, Brave, Яндекс.Браузера или Firefox без прав администратора за 30 секунд.`,
    h1: "Как настроить Smart DNS только в браузере (Chrome, Яндекс, Firefox)",
    lead: "Если у вас рабочий компьютер без прав администратора или вы хотите открывать зарубежные веб-сервисы только в одном конкретном браузере, пропишите адрес DNS-over-HTTPS (DoH) прямо в настройках приватности браузера.",
    summary: "Работает без прав администратора и действует исключительно внутри выбранного браузера.",
    howToSteps: [
      { name: "Скопируйте адрес сервера DoH", text: `Скопируйте ${FREE_DOH} (для Free) или персональный URL https://${PRO_DOMAIN}/dns/<токен> (для Pro).` },
      { name: "Откройте раздел Безопасный DNS в браузере", text: "В Chrome/Яндексе/Edge перейдите в «Настройки → Безопасность → Использовать безопасный DNS»; в Firefox — «Приватность и защита → DNS через HTTPS»." },
      { name: "Укажите пользовательский провайдер", text: "Выберите ручной ввод поставщика, вставьте скопированный URL и сохраните." },
    ],
    content: (
      <div className="grid gap-5">
        <div className="card grid gap-3">
          <CopyField label={`URL сервера DNS-over-HTTPS (${SITE.name} Free)`} value={FREE_DOH} />
          <CopyField label={`Шаблон URL для ${SITE.name} Pro (в кабинете /account)`} value={`https://${PRO_DOMAIN}/dns/<ваш-токен>`} />
        </div>
        <Steps>
          <Step title="Google Chrome, Яндекс.Браузер, Brave, Opera, Vivaldi">
            <p className="m-0">
              Откройте <strong>«Настройки» → «Конфиденциальность и безопасность» → «Безопасность»</strong> (в адресной строке Chrome можно сразу ввести <code>chrome://settings/security</code>). Включите <strong>«Использовать безопасный DNS»</strong>, выберите «Указать другой провайдер» и вставьте скопированный URL DoH.
            </p>
          </Step>
          <Step title="Microsoft Edge">
            <p className="m-0">
              Перейдите по адресу <code>edge://settings/privacy</code> → раздел «Безопасность» → включите «Использовать безопасный DNS для указания способа поиска сетевого адреса для веб-сайтов» → «Выберите поставщика услуг» → вставьте адрес DoH.
            </p>
          </Step>
          <Step title="Mozilla Firefox">
            <p className="m-0">
              Откройте «Настройки» → <strong>«Приватность и защита»</strong> → прокрутите вниз до блока <strong>«DNS через HTTPS»</strong> → выберите режим <strong>«Максимальная защита»</strong> (чтобы Firefox не откатывался на провайдерский DNS) → поставщик «Пользовательский» → вставьте URL и нажмите Enter.
            </p>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "Пункт «Безопасный DNS» в Chrome неактивен: «Эта настройка контролируется вашей организацией»",
        fix: "Групповые политики или антивирус на ПК заблокировали управление DoH в Chromium. Попробуйте портативный Firefox (в нём свой независимый стек DoH) или системную настройку DNS.",
      },
      {
        symptom: "Где настроить DoH в браузере Safari?",
        fix: "В Safari нет отдельной настройки DNS: он всегда использует системный профиль Apple — установите его по инструкции для iPhone или macOS.",
      },
    ],
    popularServiceSlugs: ["chatgpt", "claude", "gemini", "miro", "notion", "coda", "semrush", "deepl"],
    faq: [
      {
        q: "Повлияет ли настройка в браузере на остальные программы на компьютере?",
        a: "<p>Нет. Если указать DoH внутри Firefox или отдельного профиля Chrome, остальная операционная система, корпоративные клиенты и другие браузеры вообще не заметят изменений.</p>",
      },
    ],
    priority: 0.78,
  },
  {
    slug: "keenetic",
    name: "Роутеры Keenetic (KeeneticOS)",
    shortName: "Keenetic",
    group: "routers",
    groupLabel: "Домашние и офисные роутеры",
    protocolBadge: "DoH / DoT на весь дом + DynDNS",
    tierNote: "free_and_pro",
    title: `Настройка DoH и DoT на роутере Keenetic без VPN (KeeneticOS) — ${SITE.name}`,
    description: `Как настроить DNS-over-HTTPS / DNS-over-TLS ${SITE.name} на роутере Keenetic за 2 минуты: доступ к ChatGPT, Gemini, Spotify, Xbox, PlayStation и Smart TV на всех устройствах дома.`,
    h1: "Как настроить Smart DNS (DoH / DoT) на роутере Keenetic",
    lead: "Роутеры Keenetic умеют шифровать все DNS-запросы домашней сети по протоколам DNS-over-HTTPS и DNS-over-TLS из коробки — без Entware и сложных VPN-туннелей. Достаточно добавить один сервер в разделе «Интернет-фильтр», и все телефоны, ноутбуки, телевизоры и приставки дома начнут открывать сервисы автоматически.",
    summary: "Шифрованный DoH/DoT в KeeneticOS на все устройства дома + автообновление IP по DynDNS для Pro.",
    howToSteps: [
      { name: "Установите компоненты DoT/DoH в KeeneticOS", text: "В веб-интерфейсе my.keenetic.net проверьте наличие компонентов «Прокси-сервер DNS-over-TLS» и «Прокси-сервер DNS-over-HTTPS» в «Общие настройки системы → Изменить набор компонентов»." },
      { name: "Включите игнорирование DNS провайдера", text: "В разделе «Интернет → Проводной» поставьте галочку «Игнорировать DNS провайдера» и отключите IPv6 на внешнем подключении." },
      { name: "Добавьте сервер DoH или DoT", text: `Перейдите в «Сетевые правила → Интернет-фильтр → Настройка DNS», добавьте сервер DNS-over-HTTPS ${FREE_DOH} (или персональную ссылку Pro) и сохраните.` },
    ],
    content: (
      <div className="grid gap-5">
        <Steps>
          <Step title="Проверьте установленные компоненты KeeneticOS">
            <p className="m-0">
              Откройте веб-панель роутера (<code>http://my.keenetic.net</code> или <code>192.168.1.1</code>) → <strong>«Управление» → «Параметры системы» → «Изменить набор компонентов»</strong>. В разделе «Сетевые функции» убедитесь, что отмечены <strong>«Прокси-сервер DNS-over-HTTPS»</strong> и/или <strong>«Прокси-сервер DNS-over-TLS»</strong>.
            </p>
          </Step>
          <Step title="Отключите DNS провайдера и IPv6">
            <p className="m-0">
              Перейдите в <strong>«Интернет» → «Проводной»</strong> (ваше WAN-подключение) и поставьте галочку <strong>«Игнорировать DNS от провайдера»</strong>. Если провайдер выдаёт IPv6, выключите компонент/тумблер IPv6, чтобы телевизоры и смартфоны не уходили к сервисам в обход роутера.
            </p>
          </Step>
          <Step title="Добавьте зашифрованный сервер DoH или DoT">
            <p className="m-0">
              Откройте <strong>«Сетевые правила» → «Интернет-фильтр» → вкладка «Настройка DNS»</strong> → нажмите <strong>«Добавить сервер»</strong>, выберите тип <strong>DNS-over-HTTPS</strong> (рекомендуется) или <strong>DNS-over-TLS</strong>:
            </p>
            <CopyField label={`Адрес DNS-over-HTTPS (${SITE.name} Free)`} value={FREE_DOH} />
            <CopyField label={`Имя сервера DNS-over-TLS (${SITE.name} Free)`} value={FREE_DOT} />
            <p className="m-0 text-sm">
              <strong>Для подписки {SITE.name} Pro:</strong> вставьте персональную ссылку DoH <code>https://{PRO_DOMAIN}/dns/&lt;ваш-токен&gt;</code> из <Link href="/account">личного кабинета</Link> — роутер будет передавать токен при каждом запросе и автоматически продлевать пропуск для вашего домашнего IP (даже если провайдер меняет внешний IP!).
            </p>
          </Step>
        </Steps>

        <div className="card">
          <h3 className="m-0 text-[16px] font-semibold">Дополнительно для Pro: автообновление динамического IP (DynDNS)</h3>
          <p className="m-0 mt-1.5 text-sm text-mute">
            Если вы используете на роутере обычный IPv4 DNS (<code>{PRO_IP}</code>) вместо DoH, в KeeneticOS можно включить стандартный клиент DynDNS («Сетевые правила → Доменное имя → Другой профиль DynDNS»): сервер обновлений <code>pereval.top</code>, логин — email кабинета, пароль — DDNS-ключ из раздела «IP и DDNS» в <Link href="/account">кабинете</Link>.
          </p>
        </div>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "В списке DNS осталась резервная запись 8.8.8.8 или 1.1.1.1, и сервисы открываются через раз",
        fix: "Роутер опрашивает все добавленные серверы параллельно или по очереди! Удалите из таблицы «Настройка DNS» сторонние публичные серверы (Google, Cloudflare, Яндекс) — наш DNS сам быстро разрешает все обычные сайты.",
      },
      {
        symptom: "Активен встроенный фильтр SkyDNS / Яндекс.DNS / AdGuard DNS в Keenetic",
        fix: "На вкладке «Контент-фильтрация» режим фильтрации по умолчанию должен стоять «Без фильтрации» (Системный), чтобы Keenetic использовал именно добавленные вами серверы DoH/DoT.",
      },
    ],
    popularServiceSlugs: ["xbox", "playstation", "spotify", "home-connect", "dyson", "chatgpt", "gemini", "miro"],
    faq: [
      {
        q: "Что лучше указать на Keenetic для тарифа Pro — обычный IPv4 или ссылку DoH?",
        a: `<p>Однозначно <strong>DNS-over-HTTPS</strong> (<code>https://${PRO_DOMAIN}/dns/&lt;токен&gt;</code>): во-первых, интернет-провайдер не сможет перехватить запросы на 53 порту, а во-вторых, токен в URL автоматически обновляет ваш внешний IP в списке доступа Pro без настройки DDNS.</p>`,
      },
      {
        q: "Хватит ли одной подписки Pro или нужен тариф Dedicated для домашнего Keenetic?",
        a: "<p>Для одного домохозяйства (все устройства за одним домашним роутером выходят с одного внешнего IP) отлично подходит стандартная подписка <a href=\"/pro\">Pro</a>. Выделенный сервер <a href=\"/dedicated\">Dedicated</a> нужен, когда требуется подключить несколько квартир/дачу одновременно или добавлять собственные редкие домены.</p>",
      },
    ],
    priority: 0.86,
  },
  {
    slug: "mikrotik",
    name: "Роутеры MikroTik (RouterOS v7)",
    shortName: "MikroTik",
    group: "routers",
    groupLabel: "Домашние и офисные роутеры",
    protocolBadge: "RouterOS use-doh-server / CLI",
    tierNote: "free_and_pro",
    title: `Настройка Smart DNS и DoH на MikroTik (RouterOS v7) — ${SITE.name}`,
    description: `Готовые команды терминала MikroTik RouterOS для настройки DNS-over-HTTPS ${SITE.name}, импорта сертификата Let's Encrypt и автоматического обновления DynDNS в Pro.`,
    h1: "Как настроить Smart DNS и DoH на роутере MikroTik (RouterOS)",
    lead: "В MikroTik RouterOS (v6.47+ и v7) встроен полноценный клиент DNS-over-HTTPS в разделе /ip dns. Четыре команды в терминале WinBox или SSH переводят всю локальную сеть дома или офиса на защищённый Smart DNS без создания маршрутов BGP и списков адресов.",
    summary: "Готовый конфиг /ip dns с проверкой сертификата ISRG Root X1 и перехватом порта 53 в локальной сети.",
    howToSteps: [
      { name: "Импортируйте корневой сертификат ISRG Root X1", text: "Скачайте и импортируйте корневой сертификат Let's Encrypt, чтобы RouterOS проверял подлинность TLS-соединения с DoH-сервером." },
      { name: "Отключите use-peer-dns на DHCP/PPPoE-клиенте", text: "Запретите получение провайдерских DNS-серверов на внешнем WAN-интерфейсе." },
      { name: "Укажите use-doh-server в /ip dns", text: `Пропишите адрес ${FREE_DOH} (или персональную ссылку Pro) и очистите кэш командой /ip dns cache flush.` },
    ],
    content: (
      <div className="grid gap-5">
        <Steps>
          <Step title="Импортируйте корневой сертификат Let's Encrypt и настройте DoH">
            <p className="m-0">
              Откройте <strong>New Terminal</strong> в WinBox или подключитесь по SSH и выполните команды (подходит для RouterOS v7):
            </p>
            <CodeBlock>{`# 1. Корневой сертификат ISRG Root X1 для проверки HTTPS
/tool fetch url="https://letsencrypt.org/certs/isrgrootx1.pem" dst-path=isrgrootx1.pem
/certificate import file-name=isrgrootx1.pem passphrase=""

# 2. Игнорировать DNS от провайдера на WAN (пример для dhcp-client)
/ip dhcp-client set [find] use-peer-dns=no

# 3. Указать сервер Bootstrap и включить DNS-over-HTTPS (вариант Free)
/ip dns static remove [find where name="${FREE_DOT}"]
/ip dns static add name="${FREE_DOT}" address=${FREE_IP} type=A
/ip dns set servers="" use-doh-server="${FREE_DOH}" verify-doh-cert=yes allow-remote-requests=yes
/ip dns cache flush`}</CodeBlock>
            <p className="m-0 text-sm">
              <strong>Для подписки {SITE.name} Pro:</strong> добавьте статическую запись <code>/ip dns static add name=&quot;{PRO_DOMAIN}&quot; address={PRO_IP} type=A</code> и укажите в <code>use-doh-server</code> вашу персональную ссылку <code>https://{PRO_DOMAIN}/dns/&lt;ваш-токен&gt;</code>.
            </p>
          </Step>
          <Step title="Перенаправьте жёстко прошитые DNS-запросы умных ТВ и приставок (опционально)">
            <p className="m-0">
              Некоторые Smart TV и Android-приставки игнорируют DHCP и стучатся напрямую на <code>8.8.8.8:53</code>. Одно правило DST-NAT аккуратно заворачивает их в локальный кэш самого MikroTik:
            </p>
            <CodeBlock>{`/ip firewall nat add chain=dstnat in-interface-list=LAN protocol=udp dst-port=53 action=redirect to-ports=53 comment="Force LAN DNS to MikroTik"
/ip firewall nat add chain=dstnat in-interface-list=LAN protocol=tcp dst-port=53 action=redirect to-ports=53 comment="Force LAN DNS TCP"`}</CodeBlock>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "В логах MikroTik ошибка «DoH server connection error: SSL: handshake failed»",
        fix: "Проверьте системное время роутера (/system clock print — при сбившемся годе проверка сертификата не пройдёт) и убедитесь, что файл isrgrootx1.pem импортирован в /certificate print.",
      },
      {
        symptom: "На компьютерах в сети по-прежнему срабатывает IPv6 провайдера",
        fix: "В /ipv6 nd отключите флаг advertise-dns=no (или отключите пакет/приём префикса IPv6 на WAN, если он не используется).",
      },
    ],
    popularServiceSlugs: ["claude", "chatgpt", "cursor", "terraform", "jetbrains", "miro", "xbox", "playstation"],
    faq: [
      {
        q: "Нужно ли в MikroTik настраивать списки доменов (FWD static regex) только на зарубежные сайты?",
        a: "<p>В этом нет необходимости: DNS-сервер «Перевал» уже является Smart DNS — он возвращает IP прокси-воркера исключительно для фиксированного списка сервисов, а все остальные домены интернета отдаёт с их настоящими адресами и кэширует у себя.</p>",
      },
    ],
    priority: 0.8,
  },
  {
    slug: "openwrt",
    name: "OpenWrt, ASUS и TP-Link (домашние роутеры)",
    shortName: "OpenWrt / ASUS / TP-Link",
    group: "routers",
    groupLabel: "Домашние и офисные роутеры",
    protocolBadge: "WAN DNS / https-dns-proxy",
    tierNote: "free_and_pro",
    title: `Настройка Smart DNS на роутерах OpenWrt, ASUS и TP-Link — ${SITE.name}`,
    description: `Как прописать DNS ${SITE.name} на домашних роутерах OpenWrt (https-dns-proxy), ASUSWRT (DNS-over-TLS) и TP-Link Archer для всех устройств и консолей в квартире.`,
    h1: "Как настроить Smart DNS на роутерах OpenWrt, ASUS и TP-Link",
    lead: "Настройка DNS на домашнем роутере закрывает задачу сразу для всех устройств в квартире: телевизоров, колонок, ноутбуков и игровых консолей. На прошивках OpenWrt и ASUSWRT дополнительно можно включить шифрование DoH/DoT.",
    summary: "Конфигурация https-dns-proxy в OpenWrt, нативного DoT в ASUSWRT и классического WAN DNS в TP-Link.",
    howToSteps: [
      { name: "Зайдите в веб-интерфейс роутера", text: "Откройте 192.168.1.1 или 192.168.0.1 и перейдите в настройки внешнего подключения WAN / Интернет." },
      { name: "Отключите автоматический DNS провайдера и IPv6", text: "Переключите получение DNS в ручной режим и выключите раздачу IPv6 в локальную сеть." },
      { name: "Пропишите адрес сервера или DoT/DoH", text: `Укажите ${FREE_IP} (в ASUS/OpenWrt — также DoT ${FREE_DOT} или DoH ${FREE_DOH}) и перезапустите подключение.` },
    ],
    content: (
      <div className="grid gap-5">
        <div className="card grid gap-2 sm:grid-cols-2">
          <CopyField label={`IPv4 DNS (${SITE.name} Free)`} value={FREE_IP} />
          <CopyField label={`DoH URL (${SITE.name} Free)`} value={FREE_DOH} />
        </div>
        <Steps>
          <Step title="OpenWrt (через пакет https-dns-proxy или dnsmasq)">
            <p className="m-0">Для защиты от подмены UDP/53 установите лёгкий пакет <code>https-dns-proxy</code> и укажите наш DoH-эндпоинт:</p>
            <CodeBlock>{`opkg update && opkg install https-dns-proxy
uci -q delete https-dns-proxy.@https-dns-proxy[0]
uci set https-dns-proxy.pereval="https-dns-proxy"
uci set https-dns-proxy.pereval.bootstrap_dns="${FREE_IP}"
uci set https-dns-proxy.pereval.resolver_url="${FREE_DOH}"
uci set https-dns-proxy.pereval.listen_addr="127.0.0.1"
uci set https-dns-proxy.pereval.listen_port="5053"
uci commit https-dns-proxy
/etc/init.d/https-dns-proxy restart`}</CodeBlock>
          </Step>
          <Step title="Роутеры ASUS (ASUSWRT / Merlin)">
            <p className="m-0">
              Перейдите в раздел <strong>«Интернет (WAN)»</strong> → «Подключаться к DNS-серверу автоматически: <strong>Нет</strong>». В новых прошивках ASUS ниже доступен блок <strong>«DNS-over-TLS (DoT)»</strong>: выберите режим Strict, нажмите добавить сервер — адрес <code>{FREE_IP}</code>, TLS Hostname <code>{FREE_DOT}</code>, порт <code>853</code> (для тарифа Pro: адрес <code>{PRO_IP}</code> и <code>&lt;ваш-токен&gt;.{PRO_DOMAIN}</code>).
            </p>
          </Step>
          <Step title="Роутеры TP-Link (Archer / Deco)">
            <p className="m-0">
              Откройте <strong>«Дополнительные настройки» → «Сеть» → «Интернет» → «Расширенные настройки»</strong> → выберите «Использовать следующие адреса DNS»: в поле «Предпочитаемый DNS» вставьте <code>{FREE_IP}</code> (или <code>{PRO_IP}</code> после привязки вашего внешнего IP в <Link href="/account">кабинете Pro</Link>), поле «Альтернативный DNS» оставьте пустым.
            </p>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "На роутере TP-Link прописан IPv4, но сайты открываются как через обычного провайдера",
        fix: "Ряд кабельных провайдеров прозрачно перехватывает незашифрованный трафик на порту 53. Проверьте команду nslookup claude.ai — если возвращается обычный заблокированный IP вместо узла прокси, используйте роутер с поддержкой DoH/DoT или настройте зашифрованный профиль прямо на телефоне/ПК.",
      },
    ],
    popularServiceSlugs: ["xbox", "playstation", "spotify", "home-connect", "dyson", "chatgpt", "gemini"],
    faq: [
      {
        q: "Что вписывать во второе поле «Альтернативный DNS» на роутере, если роутер требует оба поля?",
        a: `<p>Не вписывайте туда <code>8.8.8.8</code> или <code>1.1.1.1</code>, иначе половина запросов пойдёт мимо прокси! Если прошивка TP-Link не даёт оставить второе поле пустым, проверьте: многие модели позволяют указать основной адрес в первом поле, а при подписке Pro привязать IP и использовать адрес ноды.</p>`,
      },
    ],
    priority: 0.76,
  },
  {
    slug: "xbox",
    name: "Xbox Series X|S и Xbox One",
    shortName: "Xbox Series X|S / One",
    group: "consoles",
    groupLabel: "Игровые консоли",
    protocolBadge: "Перевал Pro · Привязка IP + DNS",
    tierNote: "pro_recommended",
    title: `Как настроить DNS на Xbox Series X|S и убрать ошибку 0x80a40401 — ${SITE.name} Pro`,
    description: `Пошаговая настройка рабочего DNS ${SITE.name} Pro на Xbox Series X, Series S и Xbox One за 2 минуты: вход в профиль без ошибки региона 0x80a40401 и скачивание игр на полной скорости.`,
    h1: "Как настроить DNS на Xbox Series X|S и Xbox One (ошибка 0x80a40401)",
    lead: "При попытке войти в профиль на консолях Xbox с российских IP-адресов появляется экран «Вы находитесь в регионе, где эта служба недоступна (0x80a40401)». В подписке Перевал Pro вы привязываете свой домашний IP в один клик и прописываете закрытый незагруженный DNS прямо в меню приставки — без раздачи VPN с ноутбука.",
    summary: "Устранение ошибки входа 0x80a40401 на Xbox Series X|S и One с полной скоростью загрузки игр.",
    howToSteps: [
      { name: "Привяжите домашний IP в кабинете Перевал Pro", text: "Оформите подписку Pro, откройте личный кабинет с телефона или ПК в той же домашней сети Wi-Fi и нажмите «Привязать мой текущий IP»." },
      { name: "Откройте параметры DNS на консоли Xbox", text: "На приставке перейдите в «Параметры → Общие → Параметры сети → Дополнительные параметры → Параметры DNS → Вручную»." },
      { name: "Введите адрес DNS Pro и перезагрузите консоль", text: `Укажите основной DNS ${PRO_IP} (дополнительный 0.0.0.0 или тот же), сохраните и перезагрузите Xbox.` },
    ],
    content: (
      <div className="grid gap-5">
        <div className="note [&_p]:m-0" role="note">
          <p>
            <strong>Домены Xbox Live входят в каталог <Link href="/pro">{SITE.name} Pro</Link>.</strong> Поскольку приставка Xbox общается с DNS только по классическому протоколу IPv4 (порт 53 без токенов), перед вводом адреса на консоли обязательно привяжите внешний IP вашей домашней сети в <Link href="/account">личном кабинете</Link>.
          </p>
        </div>
        <Steps>
          <Step title="Привяжите внешний IP вашей домашней сети в кабинете Pro">
            <p className="m-0">
              После оформления <Link href="/pro#buy">подписки {SITE.name} Pro</Link> зайдите в <Link href="/account">личный кабинет</Link> со смартфона или компьютера, подключённого к <strong>тому же домашнему Wi-Fi</strong>, что и Xbox, и в разделе «Привязанные IP и DDNS» нажмите кнопку добавления текущего IP (если у провайдера динамический IP — настройте там же бесплатный DDNS на роутере).
            </p>
          </Step>
          <Step title="Укажите DNS вручную в настройках сети Xbox">
            <p className="m-0">
              На геймпаде нажмите кнопку <strong>Xbox</strong> → <strong>«Профиль и система» → «Параметры» → «Общие» → «Параметры сети» → «Дополнительные параметры» → «Параметры DNS» → «Вручную»</strong>:
            </p>
            <CopyField label={`Основной IPv4 DNS (${SITE.name} Pro)`} value={PRO_IP} />
            <p className="m-0 text-sm">
              Когда консоль попросит <strong>«Дополнительный IPv4 DNS»</strong>, введите <code>0.0.0.0</code> (или повторите <code>{PRO_IP}</code> — не указывайте там <code>8.8.8.8</code>, иначе Xbox может отправить проверку региона мимо прокси!).
            </p>
          </Step>
          <Step title="Очистите кэш сети (перезагрузите консоль)">
            <p className="m-0">
              Зажмите кнопку Xbox на геймпаде и выберите <strong>«Перезагрузить консоль»</strong> (именно перезагрузку, а не спящий режим). После включения войдите в свой профиль Xbox Live — ошибка <code>0x80a40401</code> исчезнет.
            </p>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "После ввода DNS на Xbox всё равно выскакивает 0x80a40401",
        fix: "Три частые причины: 1) В кабинете Pro не привязан ваш текущий внешний IP (или провайдер сменил динамический IP); 2) На роутере включён IPv6 — в «Параметрах сети» Xbox должно быть написано только «IPv4», а не «IPv4 и IPv6»; 3) Интернет-провайдер перехватывает порт 53 — в этом случае пропишите наш зашифрованный DoH прямо на роутере (например, Keenetic или MikroTik).",
      },
      {
        symptom: "Провайдер выдаёт «серый» IP за CGNAT, можно ли привязать его?",
        fix: "Да, DNS-сервер видит внешний адрес NAT-шлюза вашего провайдера и разрешает с него ваши запросы. А если на роутере настроить персональную ссылку DoH, токен авторизует запросы вообще независимо от смены IP.",
      },
    ],
    popularServiceSlugs: ["xbox", "playstation", "spotify", "brawl-stars", "home-connect"],
    faq: [
      {
        q: "Упадёт ли скорость скачивания игр из Game Pass при таком DNS?",
        a: "<p>Нет! Загрузка самих дистрибутивов игр идёт с высокоскоростных CDN-серверов Microsoft (<code>xboxlive.cn</code> / <code>akamaized</code> / локальные кэши), а через узел Pro проходит только проверка региона и сервисы Xbox Live. Игры качаются на полной скорости вашего тарифа, а пинг в мультиплеере не растёт.</p>",
      },
      {
        q: "Почему бесплатные публичные DNS для Xbox из интернета постоянно ломаются?",
        a: "<p>Открытые всему миру серверы быстро попадают под спам-трафик, перегружаются десятками тысяч консолей в пятницу вечером или блокируются самими сервисами. Узлы Перевал Pro закрыты сетевым экраном <code>nftables</code> исключительно для привязанных IP подписчиков.</p>",
      },
    ],
    priority: 0.88,
  },
  {
    slug: "playstation",
    name: "PlayStation 5 и PlayStation 4",
    shortName: "PlayStation 5 / 4",
    group: "consoles",
    groupLabel: "Игровые консоли",
    protocolBadge: "Перевал Pro · Привязка IP + DNS",
    tierNote: "pro_recommended",
    title: `Настройка DNS на PlayStation 5 и PS4 в России и Беларуси без VPN — ${SITE.name} Pro`,
    description: `Инструкция по настройке чистого DNS ${SITE.name} Pro на консолях PS5 и PS4: стабильный вход в PSN, работа PlayStation Store и сетевых служб без потери скорости загрузки.`,
    h1: "Как настроить DNS на PlayStation 5 и PlayStation 4 без VPN",
    lead: "Для стабильной работы учётной записи PlayStation Network, магазина PS Store и синхронизации сетевых служб на PS5 и PS4 достаточно привязать домашний IP в кабинете Перевал Pro и указать DNS в свойствах соединения консоли (или один раз на домашнем роутере).",
    summary: "Пошаговая прописка DNS на PS5 и PS4 с привязкой домашнего IP и сохранением низкого пинга в онлайне.",
    howToSteps: [
      { name: "Привяжите домашний IP в кабинете Pro", text: "Войдите в кабинет Перевал Pro из домашней сети Wi-Fi и добавьте ваш текущий внешний IP-адрес." },
      { name: "Перейдите к ручным настройкам DNS на PS5 / PS4", text: "На PS5 откройте «Настройки → Сеть → Настройки → Установить соединение с Интернетом → Дополнительные настройки»." },
      { name: "Укажите Основной DNS и проверьте соединение", text: `Переключите «Настройки DNS» на «Вручную», укажите Основной DNS ${PRO_IP}, дополнительный оставьте 0.0.0.0 и сохраните.` },
    ],
    content: (
      <div className="grid gap-5">
        <div className="note [&_p]:m-0" role="note">
          <p>
            <strong>Сервисы PlayStation Network входят в подписку <Link href="/pro">{SITE.name} Pro</Link>.</strong> Перед настройкой на консоли привяжите IP вашей домашней сети в <Link href="/account">личном кабинете</Link> (либо настройте зашифрованный DoH-токен на роутере <Link href="/setup/keenetic">Keenetic</Link> / <Link href="/setup/mikrotik">MikroTik</Link>).
          </p>
        </div>
        <Steps>
          <Step title="На PlayStation 5">
            <p className="m-0">
              Откройте <strong>«Настройки» → «Сеть» → «Настройки» → «Установить соединение с Интернетом»</strong>. Наведите курсор на вашу сеть Wi-Fi или LAN-кабель, нажмите кнопку <strong>Options (≡)</strong> на геймпаде DualSense → <strong>«Дополнительные настройки»</strong>:
            </p>
            <ul className="m-0 list-disc pl-5 text-sm">
              <li>Настройки IP-адреса: <strong>Автоматически</strong></li>
              <li>Настройки DNS: <strong>Вручную</strong></li>
              <li>Дополнительный DNS: <code>0.0.0.0</code></li>
            </ul>
            <CopyField label={`Основной DNS (${SITE.name} Pro)`} value={PRO_IP} />
          </Step>
          <Step title="На PlayStation 4">
            <p className="m-0">
              Перейдите в <strong>«Настройки» → «Сеть» → «Установить соединение с Интернетом»</strong> → выберите Wi-Fi или LAN → способ <strong>«Специальный»</strong> → IP-адрес «Автоматически», DHCP «Не указывать», <strong>Настройки DNS — «Вручную»</strong> → Основной DNS <code>{PRO_IP}</code>, Дополнительный <code>0.0.0.0</code> → MTU «Автоматически», Прокси-сервер «Не использовать».
            </p>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "При проверке соединения на PS5 ошибка на этапе «Вход в сеть PlayStation Network»",
        fix: "Проверьте в личном кабинете Pro (с телефона в той же Wi-Fi сети), совпадает ли ваш текущий публичный IP с привязанным. Если ваш провайдер блокирует внешние DNS на 53 порту, пропишите персональную ссылку DoH на роутере.",
      },
      {
        symptom: "Вход в PSN проходит успешно, но пишет «Тип NAT: Не удалось»",
        fix: "Проверка типа NAT на PS4 и PS5 идёт напрямую по UDP (STUN порт 3478) с вашего домашнего роутера в обход прокси. Полностью перезагрузите консоль (не спящий режим), чтобы сбросить DNS-кэш приставки, и убедитесь, что на роутере включён UPnP.",
      },
    ],
    popularServiceSlugs: ["playstation", "xbox", "spotify", "brawl-stars", "home-connect"],
    faq: [
      {
        q: "Позволяет ли DNS покупать игры с российской карты в PS Store?",
        a: "<p>Smart DNS восстанавливает техническое сетевое соединение с серверами PSN и магазином, но правила приёма банковских карт определяются регионом самого аккаунта PSN (Турция, Польша, США, Индия и др.) и картами пополнения.</p>",
      },
    ],
    priority: 0.84,
  },
  {
    slug: "corporate-vpn",
    name: "Совместно с корпоративным VPN (update_hosts.py)",
    shortName: "Корпоративный VPN",
    group: "developers",
    groupLabel: "Для разработчиков и ОС",
    protocolBadge: "Утилита update_hosts.py (/etc/hosts)",
    tierNote: "free_and_pro",
    title: `Как совместить Claude, Cursor и ChatGPT с корпоративным VPN (Cloudflare WARP, AnyConnect) — ${SITE.name}`,
    description: `Конфликтует системный DNS с рабочим VPN (Cloudflare WARP, Cisco AnyConnect, WireGuard)? Настройте прямой доступ к ИИ и IDE через скрипт с открытым кодом update_hosts.py.`,
    h1: "Как работать с ChatGPT, Claude и Cursor при включённом корпоративном VPN",
    lead: "Корпоративные клиенты VPN (Cloudflare WARP Zero Trust, Cisco AnyConnect, GlobalProtect, OpenVPN, рабочий WireGuard) принудительно перехватывают все системные DNS-запросы, чтобы разрешать внутренние домены компании (*.corp, *.internal). Из-за этого обычный Smart DNS отключается в момент подключения к работе. Для этого сценария в репозитории Перевала есть открытая утилита src/update_hosts.py.",
    summary: "Решение конфликта с Cloudflare WARP, AnyConnect и рабочим WireGuard через управляемый блок в /etc/hosts.",
    howToSteps: [
      { name: "Скачайте скрипт update_hosts.py из открытого репозитория", text: "Клонируйте репозиторий на GitHub или скачайте один самодостаточный файл src/update_hosts.py и services.yaml (только Python 3 stdlib)." },
      { name: "Проверьте генерируемый блок в режиме --dry-run", text: "Запустите python3 src/update_hosts.py --dry-run, чтобы увидеть список доменов между маркерами # >>> PEREVAL START и # <<< PEREVAL END." },
      { name: "Примените записи в /etc/hosts", text: "Выполните sudo python3 src/update_hosts.py — система начнёт направлять домены ИИ и разработки на прокси-узел до обращения к DNS корпоративного VPN." },
    ],
    content: (
      <div className="grid gap-5">
        <div className="card">
          <h3 className="m-0 text-[16px] font-semibold">Почему файл /etc/hosts обходит перехват DNS от рабочего VPN?</h3>
          <p className="m-0 mt-2 text-[15px] text-mute">
            В macOS, Linux и Windows системный резолвер проверяет локальную таблицу хостов <strong>раньше</strong>, чем отправляет запрос в виртуальный DNS-интерфейс корпоративного туннеля (если рабочий VPN работает в режиме split-tunnel по подсетям и не заворачивает <code>0.0.0.0/0</code> целиком через российский офис). При этом все внутренние домены вашей компании продолжают штатно разрешаться через корпоративный DNS!
          </p>
        </div>

        <Steps>
          <Step title="Запустите update_hosts.py на macOS или Linux">
            <p className="m-0">
              Скрипт написан на чистом Python 3 без внешних зависимостей, аккуратно обновляет только собственный блок между маркерами <code># &gt;&gt;&gt; PEREVAL START</code> и <code># &lt;&lt;&lt; PEREVAL END</code> (не трогая ваши рабочие записи в <code>/etc/hosts</code>) и автоматически сбрасывает кэш <code>mDNSResponder</code>:
            </p>
            <CodeBlock>{`git clone ${SITE.github}.git pereval-dns
cd pereval-dns

# Посмотреть записи без изменения системы:
python3 src/update_hosts.py --dry-run

# Записать актуальные домены Free в /etc/hosts:
sudo python3 src/update_hosts.py

# Удалить блок Перевала одной командой в любой момент:
sudo python3 src/update_hosts.py --remove`}</CodeBlock>
          </Step>
          <Step title="Командный сценарий: выделенный сервер Перевал Dedicated">
            <p className="m-0">
              Если в вашей компании корпоративный VPN заворачивает вообще весь интернет-трафик сотрудников (Full Tunnel) через российский шлюз офиса, администратор сети может направить список доменов на выделенном корпоративном DNS-резолвере офиса на ваш изолированный узел <Link href="/dedicated">{SITE.name} Dedicated</Link> — тогда Cursor, Claude, JetBrains, Miro и Notion заработают у всей команды сразу без правки ноутбуков.
            </p>
          </Step>
        </Steps>
      </div>
    ),
    troubleshooting: [
      {
        symptom: "В /etc/hosts нельзя прописать маску *.domain.com — как работают поддомены?",
        fix: "Утилита update_hosts.py автоматически разворачивает для каждого базового домена частые служебные поддомены (www, api, auth, cdn, platform, chat, accounts, app, static, assets) плюс все явно перечисленные API-хосты из services.yaml.",
      },
      {
        symptom: "Записи добавлены в /etc/hosts, но при включённом VPN сайт всё равно пишет о российском регионе",
        fix: `Если корпоративный файрвол в режиме Full Tunnel блокирует исходящие соединения к внешним IP-адресам на порту 443 или подменяет TLS-сертификаты собственным корнем инспекции, попросите ИТ-службу разрешить прямой выход на IP узла ${FREE_IP} либо рассмотрите выделенный командный узел ${SITE.name} Dedicated.`,
      },
    ],
    popularServiceSlugs: ["claude", "cursor", "chatgpt", "github-copilot", "jetbrains", "terraform", "google-ai-studio", "miro"],
    faq: [
      {
        q: "Не испортит ли скрипт мои собственные рабочие строки в /etc/hosts?",
        a: "<p>Нет. <code>update_hosts.py</code> ищет и заменяет строго текст между строками-маркерами <code># &gt;&gt;&gt; PEREVAL START</code> и <code># &lt;&lt;&lt; PEREVAL END</code>. Все остальные строки до и после блока остаются нетронутыми.</p>",
      },
      {
        q: "Где посмотреть исходный код скрипта перед запуском с sudo?",
        a: `<p>Полный исходный код открыт под лицензией Apache 2.0 в репозитории на GitHub: <a href="${SITE.github}/blob/main/src/update_hosts.py" target="_blank" rel="noopener">src/update_hosts.py</a> (~200 строк читаемого Python без сетевых запросов).</p>`,
      },
    ],
    priority: 0.82,
  },
];

const GUIDE_MAP = new Map<string, DeviceGuideData>(GUIDES.map((g) => [g.slug, g]));

export function allDeviceGuides(): DeviceGuideData[] {
  return GUIDES;
}

export function deviceGuideBySlug(slug: string): DeviceGuideData | undefined {
  return GUIDE_MAP.get(slug.toLowerCase());
}

export function deviceGuidesBySlugs(slugs: string[]): DeviceGuideData[] {
  const out: DeviceGuideData[] = [];
  for (const s of slugs) {
    const found = GUIDE_MAP.get(s);
    if (found) out.push(found);
  }
  return out;
}
