import type { ReactNode } from "react";
import { Download } from "lucide-react";
import { CopyField } from "@/components/CopyButton";
import type { WizardTab } from "@/components/home/SetupWizard";

/**
 * Содержимое вкладок мастера настройки (рендерится на сервере, попадает в статический HTML).
 * Каждая вкладка — 2–4 коротких шага; альтернативные способы спрятаны в <details>.
 */
export type SetupValues = { name: string; ip: string; doh: string; dot: string; profilePath: string };

function Steps({ children }: { children: ReactNode }) {
  return <ol className="m-0 grid list-none gap-3 p-0 [counter-reset:step]">{children}</ol>;
}

function Step({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3 [counter-increment:step]">
      <span
        aria-hidden
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent before:content-[counter(step)]"
      />
      <div className="min-w-0 text-[15px] leading-relaxed">{children}</div>
    </li>
  );
}

function Alt({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="mt-4 rounded-lg border border-line bg-bg px-4 py-3 text-[15px]">
      <summary className="cursor-pointer font-medium text-mute hover:text-ink">{title}</summary>
      <div className="mt-3 grid gap-3 [&_ol]:m-0 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1">{children}</div>
    </details>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="m-0 overflow-x-auto rounded-lg bg-code p-3 text-[13px] leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="m-0 mt-4 text-sm text-mute">{children}</p>;
}

function ProfileButton({ v, platform }: { v: SetupValues; platform: string }) {
  return (
    <a className="btn-primary" href={v.profilePath} download={`${v.dot}.mobileconfig`}>
      <Download className="h-4 w-4" aria-hidden /> Скачать профиль для {platform}
    </a>
  );
}

export function buildSetupTabs(v: SetupValues): WizardTab[] {
  return [
    {
      id: "ios",
      label: "iPhone / iPad",
      content: (
        <>
          <p className="m-0 mb-4 text-[15px] text-mute">
            Профиль включает зашифрованный DNS (DNS-over-TLS через <code>{v.dot}</code>) для Wi-Fi и мобильной сети сразу.
          </p>
          <Steps>
            <Step>
              Откройте эту страницу в <strong>Safari</strong> и скачайте профиль, в появившемся окне нажмите «Разрешить».
              <div className="mt-3">
                <ProfileButton v={v} platform="iOS" />
              </div>
            </Step>
            <Step>
              Откройте «Настройки» — вверху появится пункт <strong>«Профиль загружен»</strong>. Нажмите «Установить» и введите код-пароль.
            </Step>
            <Step>
              Проверьте, что профиль выбран: «Настройки» → «Основные» → «VPN и управление устройством» → «DNS» → <strong>{v.name} DNS</strong>.
            </Step>
          </Steps>
          <Alt title="Вручную только для текущей сети Wi-Fi">
            <ol>
              <li>
                «Настройки» → «Wi-Fi» → значок <strong>ⓘ</strong> рядом с вашей сетью.
              </li>
              <li>«Настройка DNS» → переключите с «Автоматически» на «Вручную».</li>
              <li>
                Удалите существующие записи, нажмите «Добавить сервер» и введите адрес ниже, затем «Сохранить».
              </li>
            </ol>
            <CopyField label="DNS-сервер (IPv4)" value={v.ip} />
          </Alt>
          <Hint>Отключить или удалить: «Настройки» → «Основные» → «VPN и управление устройством» → «{v.name} DNS» → «Удалить профиль».</Hint>
        </>
      ),
    },
    {
      id: "android",
      label: "Android",
      content: (
        <>
          <p className="m-0 mb-4 text-[15px] text-mute">
            Встроенный «Частный DNS» (Android 9+) включает DNS-over-TLS без приложений и работает по Wi-Fi и в мобильной сети.
          </p>
          <Steps>
            <Step>
              «Настройки» → «Сеть и интернет» → <strong>«Частный DNS»</strong>.
              <div className="mt-1 text-sm text-mute">
                Samsung: «Подключения» → «Другие настройки подключения» → «Частный DNS-сервер». Xiaomi: «Подключение и общий доступ» → «Частный DNS-сервер».
              </div>
            </Step>
            <Step>
              Выберите «Имя хоста поставщика частного DNS» и введите:
              <div className="mt-3">
                <CopyField label="Имя хоста частного DNS (DoT)" value={v.dot} />
              </div>
            </Step>
            <Step>Нажмите «Сохранить». Готово — перезапускать ничего не нужно.</Step>
          </Steps>
          <Alt title="Вручную только для текущей сети Wi-Fi">
            <ol>
              <li>«Настройки» → «Сеть и интернет» → «Интернет» → шестерёнка рядом с вашей сетью → «Изменить».</li>
              <li>«Дополнительные параметры» → «Настройки IP»: с «DHCP» на «Статический».</li>
              <li>В поле «DNS 1» введите адрес ниже («DNS 2» оставьте пустым), затем «Сохранить».</li>
            </ol>
            <CopyField label="DNS-сервер (IPv4)" value={v.ip} />
          </Alt>
          <Hint>Чтобы отключить, верните «Частный DNS» в положение «Автоматически» или «Выкл.».</Hint>
        </>
      ),
    },
    {
      id: "mac",
      label: "macOS",
      content: (
        <>
          <p className="m-0 mb-4 text-[15px] text-mute">
            Профиль настраивает зашифрованный DNS сразу для всех подключений — Wi-Fi, Ethernet, модем (macOS 11 и новее).
          </p>
          <Steps>
            <Step>
              Скачайте профиль и откройте файл двойным щелчком — появится уведомление «Профиль загружен».
              <div className="mt-3">
                <ProfileButton v={v} platform="macOS" />
              </div>
            </Step>
            <Step>
              «Системные настройки» → «Основные» → «Управление устройством» (на Ventura: «Конфиденциальность и безопасность» → «Профили»).
            </Step>
            <Step>
              Дважды щёлкните <strong>{v.name} DNS</strong>, нажмите «Установить» и введите пароль администратора. Пометка «Не проверен» означает лишь, что профиль не подписан.
            </Step>
          </Steps>
          <Alt title="Вручную через «Системные настройки» → «Сеть»">
            <ol>
              <li>Выберите активное подключение (Wi-Fi или Ethernet) → «Подробнее…» → вкладка «DNS».</li>
              <li>
                Удалите существующие записи, нажмите <strong>+</strong> и добавьте адрес ниже → «ОК» → «Применить».
              </li>
              <li>Повторите для каждой сети: настройка привязана к интерфейсу.</li>
            </ol>
            <CopyField label="DNS-сервер (IPv4)" value={v.ip} />
          </Alt>
          <Alt title="Через терминал">
            <Code>{`networksetup -setdnsservers Wi-Fi ${v.ip}
dscacheutil -flushcache && sudo killall -HUP mDNSResponder

# проверить
networksetup -getdnsservers Wi-Fi
# вернуть настройки роутера (DHCP)
networksetup -setdnsservers Wi-Fi empty`}</Code>
          </Alt>
          <Hint>Включить/выключить профиль: «Системные настройки» → «Сеть» → «VPN и фильтры» (Sonoma и новее); удалить — там же, где устанавливали, кнопкой −.</Hint>
        </>
      ),
    },
    {
      id: "win",
      label: "Windows",
      content: (
        <>
          <Steps>
            <Step>«Параметры» → «Сеть и Интернет» → ваше подключение («Wi-Fi» или «Ethernet») → «Свойства оборудования».</Step>
            <Step>
              Рядом с «Назначение DNS-сервера» нажмите «Изменить», переключите на «Вручную», включите <strong>IPv4</strong> и вставьте адрес в «Предпочтительный DNS» (альтернативный оставьте пустым).
              <div className="mt-3">
                <CopyField label="Предпочтительный DNS (IPv4)" value={v.ip} />
              </div>
            </Step>
            <Step>
              <strong>Windows 11:</strong> в пункте «DNS через HTTPS» выберите «Вкл. (ручной шаблон)» и укажите шаблон ниже — запросы будут зашифрованы. В Windows 10 этого пункта нет, пропустите шаг.
              <div className="mt-3">
                <CopyField label="Шаблон DNS через HTTPS (DoH)" value={v.doh} />
              </div>
            </Step>
            <Step>IPv6 оставьте выключенным и нажмите «Сохранить».</Step>
          </Steps>
          <Alt title="PowerShell от администратора">
            <Code>{`Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ${v.ip}
# Windows 11: включить DNS-over-HTTPS для этого сервера
Add-DnsClientDohServerAddress -ServerAddress ${v.ip} -DohTemplate ${v.doh} -AllowFallbackToUdp $false -AutoUpgrade $true
Clear-DnsClientCache

# проверить
Get-DnsClientServerAddress -InterfaceAlias "Wi-Fi"
# вернуть DHCP
Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ResetServerAddresses
Remove-DnsClientDohServerAddress -ServerAddress ${v.ip}`}</Code>
            <p className="m-0 text-sm text-mute">
              Имя интерфейса покажет <code>Get-NetAdapter</code>.
            </p>
          </Alt>
        </>
      ),
    },
    {
      id: "linux",
      label: "Linux",
      content: (
        <>
          <p className="m-0 mb-4 text-[15px] text-mute">NetworkManager (Ubuntu, Fedora и большинство окружений):</p>
          <Steps>
            <Step>
              Узнайте имя подключения и пропишите DNS:
              <div className="mt-3">
                <Code>{`nmcli con show                       # имя подключения
nmcli con mod "<имя>" ipv4.dns "${v.ip}"
nmcli con mod "<имя>" ipv4.ignore-auto-dns yes
nmcli con up "<имя>"`}</Code>
              </div>
            </Step>
            <Step>
              Проверьте: <code>resolvectl status | grep -A2 &apos;DNS Servers&apos;</code> — в списке должен быть <code>{v.ip}</code>.
            </Step>
          </Steps>
          <Alt title="Графический интерфейс">
            <p className="m-0">«Настройки» → «Сеть» → шестерёнка → «IPv4»: отключите автоматический DNS и введите адрес вручную.</p>
            <CopyField label="DNS-сервер (IPv4)" value={v.ip} />
          </Alt>
          <Alt title="systemd-resolved напрямую">
            <Code>{`resolvectl dns <интерфейс> ${v.ip}
resolvectl domain <интерфейс> '~.'
resolvectl flush-caches`}</Code>
          </Alt>
          <Alt title="Без NetworkManager">
            <Code>{`# /etc/resolv.conf — DHCP перезапишет файл, если его не защитить
nameserver ${v.ip}`}</Code>
          </Alt>
        </>
      ),
    },
    {
      id: "router",
      label: "Роутер",
      content: (
        <>
          <p className="m-0 mb-4 text-[15px] text-mute">
            Один адрес на роутере — и все устройства дома (включая Smart TV и приставки) получают доступ без настройки каждого.
          </p>
          <Steps>
            <Step>
              Откройте веб-интерфейс роутера: адрес и пароль указаны на наклейке (обычно <code>192.168.0.1</code>, <code>192.168.1.1</code> или <code>my.keenetic.net</code>).
            </Step>
            <Step>
              Найдите настройки интернет-подключения (WAN) и переключите DNS с «автоматически» на «вручную». В поле DNS 1 вставьте адрес, DNS 2 оставьте пустым или укажите тот же.
              <div className="mt-3">
                <CopyField label="DNS-сервер (IPv4)" value={v.ip} />
              </div>
              <div className="mt-2 text-sm text-mute">
                Keenetic: «Интернет» → подключение → «DNS-серверы». ASUS: «WAN» → «Подключаться к DNS-серверу автоматически: Нет». TP-Link: «Дополнительные настройки» → «Сеть» → «Интернет». MikroTik: «IP» → «DNS» → «Servers».
              </div>
            </Step>
            <Step>Сохраните настройки и переподключите устройства к Wi-Fi (или перезагрузите роутер), чтобы они получили новый DNS.</Step>
          </Steps>
          <Hint>
            Если провайдер выдаёт IPv6, отключите на роутере раздачу IPv6-DNS (или IPv6 целиком), иначе часть устройств пойдёт к сервисам напрямую, минуя подмену. Для семьи с разными сетями и своими доменами есть <a href="/dedicated">выделенный сервер</a>.
          </Hint>
        </>
      ),
    },
    {
      id: "browser",
      label: "Браузеры",
      content: (
        <>
          <p className="m-0 mb-4 text-[15px] text-mute">
            Нет прав администратора или не хотите трогать систему? Пропишите DNS-over-HTTPS прямо в браузере — настройка повлияет только на него.
          </p>
          <div className="mb-4">
            <CopyField label="Адрес сервера DNS-over-HTTPS (DoH)" value={v.doh} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="m-0 mb-2 text-[15px] font-semibold">Chrome, Edge, Brave, Яндекс.Браузер</h4>
              <Steps>
                <Step>«Настройки» → «Конфиденциальность и безопасность» → «Безопасность» (Edge: «Конфиденциальность, поиск и службы»).</Step>
                <Step>Включите «Использовать безопасный DNS» → «Указать другой провайдер» → «Добавить свой провайдер».</Step>
                <Step>Вставьте адрес DoH и сохраните.</Step>
              </Steps>
            </div>
            <div>
              <h4 className="m-0 mb-2 text-[15px] font-semibold">Firefox</h4>
              <Steps>
                <Step>«Настройки» → «Приватность и защита» → раздел «DNS через HTTPS».</Step>
                <Step>Выберите «Максимальная защита», поставщик — «Пользовательский».</Step>
                <Step>Вставьте адрес DoH и нажмите Enter.</Step>
              </Steps>
            </div>
          </div>
          <Hint>Safari отдельной настройки не имеет — он всегда следует системным настройкам DNS (вкладки macOS / iPhone).</Hint>
        </>
      ),
    },
  ];
}
