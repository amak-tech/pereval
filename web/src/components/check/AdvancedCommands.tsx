"use client";

import { useState } from "react";
import { ChevronDown, Terminal } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { catalog } from "@/lib/catalog";
import type { BeaconResult, CheckContextResponse } from "@/lib/diagnostics";

type OsKey = "windows" | "macos" | "linux";

const OS_TABS: { id: OsKey; label: string }[] = [
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

function detectInitialOs(): OsKey {
  if (typeof navigator === "undefined") return "macos";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
  return "linux";
}

type CommandCard = {
  title: string;
  hint: string;
  command: string;
};

function buildCommands(
  os: OsKey,
  domain: string,
  checkDomain: string,
  dnsIp: string,
): CommandCard[] {
  if (os === "windows") {
    return [
      {
        title: "1. Проверка системного DNS (маячок и сайт)",
        hint: "Проверяет, через какой DNS резолвятся домены прямо сейчас (запускайте в PowerShell или cmd).",
        command: `nslookup ${checkDomain}\nnslookup ${domain}`,
      },
      {
        title: "2. Прямой запрос к DNS Перевала (проверка перехвата UDP/53)",
        hint: "Если системный nslookup даёт чужой IP, а эта команда даёт IP Перевала — DNS просто не применился. Если и здесь чужой IP или таймаут — провайдер перехватывает порт 53 (нужен DoH/DoT).",
        command: `nslookup ${domain} ${dnsIp}`,
      },
      {
        title: "3. Проверка утечки IPv6 (запись AAAA)",
        hint: "В ответе не должно быть IPv6-адресов. Если вернулся адрес с двоеточиями — отключите IPv6 в свойствах адаптера.",
        command: `nslookup -type=AAAA ${domain}`,
      },
      {
        title: "4. Проверка TLS и блокировки ТСПУ",
        hint: "Показывает IP подключения и точный момент обрыва (TCP до порта 443 vs сброс на TLS ClientHello).",
        command: `curl.exe -vI --max-time 8 https://${domain}/`,
      },
    ];
  }

  return [
    {
      title: "1. Проверка системного DNS (маячок и сайт)",
      hint: "Проверяет, какие IPv4-адреса возвращает текущий системный резолвер.",
      command: `dig +short A ${checkDomain}\ndig +short A ${domain}`,
    },
    {
      title: "2. Прямой запрос к DNS Перевала (проверка перехвата UDP/53)",
      hint: "Сравнивает ответ напрямую от DNS Перевала. Если ответ чужой или таймаут — провайдер перехватывает UDP/53, используйте DoH/DoT.",
      command: `dig +short A ${domain} @${dnsIp}`,
    },
    {
      title: "3. Проверка утечки IPv6 (запись AAAA)",
      hint: "Вывод должен быть пустым. Если вернулся IPv6-адрес — трафик уходит мимо IPv4-прокси Перевала.",
      command: `dig +short AAAA ${domain}`,
    },
    {
      title: "4. Проверка TLS и блокировки ТСПУ",
      hint: "Сразу показывает, к какому IP идёт подключение и рвёт ли ТСПУ рукопожатие на ClientHello.",
      command: `curl -vI --max-time 8 https://${domain}/`,
    },
  ];
}

const DECODER_ROWS: {
  scenario: string;
  tone: "ok" | "warn" | "err";
  dnsOutput: string;
  curlOutput: string;
  action: string;
}[] = [
  {
    scenario: "Норма (всё работает)",
    tone: "ok",
    dnsOutput: "A = IP сервера Перевала; AAAA пустой",
    curlOutput: "Connected to <IP Перевала> → TLSv1.3 → HTTP/2 200 / 301 / 307",
    action: "DNS и прокси в порядке. Если сайт всё же просит VPN — очистите кэш/куки или проверьте страну аккаунта.",
  },
  {
    scenario: "DNS не применился / сторонний DoH",
    tone: "err",
    dnsOutput: "A = чужой IP (Cloudflare 104.x, Google, AWS и т.п.)",
    curlOutput: "Connected to <чужой IP> → 403 Forbidden / геоблок",
    action: "Отключите сторонний «Безопасный DNS» в браузере, переподключите Wi-Fi или настройте DoH/DoT Перевала.",
  },
  {
    scenario: "Утечка по IPv6",
    tone: "warn",
    dnsOutput: "AAAA возвращает IPv6 (например, 2606:4700:...)",
    curlOutput: "Trying 2606:... → подключение идёт напрямую по IPv6",
    action: "Отключите IPv6 в настройках Wi-Fi / сетевого адаптера или роутера.",
  },
  {
    scenario: "Блокировка ТСПУ (по SNI)",
    tone: "err",
    dnsOutput: "A = верный IP Перевала",
    curlOutput: "Connected to <IP Перевала>:443 → Client hello → Connection reset by peer / Recv failure / таймаут",
    action: "DNS настроен верно, но ТСПУ провайдера режет TLS-рукопожатие по имени сайта. Перевал — прозрачный SNI-прокси и не обходит ТСПУ; проверьте с другого оператора.",
  },
  {
    scenario: "Закрыт порт 443 или нет IP в Pro ACL",
    tone: "warn",
    dnsOutput: "A = верный IP Перевала",
    curlOutput: "Зависает до Connected → Failed to connect / Operation timed out / Connection refused",
    action: "Проверьте файрвол/корпоративную сеть (порт 443). Для Pro: убедитесь, что текущий IP привязан или попал в ACL в кабинете.",
  },
];

export function AdvancedCommands({
  targetDomain,
  context,
  beacon,
}: {
  targetDomain: string;
  context: CheckContextResponse | null;
  beacon: BeaconResult | null;
}) {
  const [os, setOs] = useState<OsKey>(() => detectInitialOs());

  const checkDomain = context?.checkDomain || catalog.meta.check_domain || "check.pereval.top";
  const usePro =
    beacon?.state === "ok" && beacon.tier === "pro"
      ? true
      : Boolean(context?.account && context.pro?.dnsIp);
  const dnsIp =
    (usePro && context?.pro?.dnsIp) ||
    context?.free.dnsIp ||
    catalog.free.dns_ip;

  const commands = buildCommands(os, targetDomain, checkDomain, dnsIp);
  const freeIps = context?.free.workerIps ?? [catalog.free.dns_ip, ...catalog.free.workers.map((w) => w.ip)];
  const proIps = context?.pro?.workerIps ?? (catalog.pro ? catalog.pro.workers.map((w) => w.ip) : []);

  return (
    <details className="card group p-5 sm:p-6">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Terminal className="h-5 w-5 shrink-0 text-accent" aria-hidden />
          <div>
            <h2 className="m-0 text-lg font-semibold">
              4. Для продвинутых пользователей: команды терминала и разбор ответов
            </h2>
            <p className="m-0 mt-0.5 text-sm text-mute">
              Точная диагностика через <code>nslookup</code> / <code>dig</code> / <code>curl -vI</code> для домена{" "}
              <code className="text-ink">{targetDomain}</code> — помогает на 100% отличить ошибку DNS от ресета ТСПУ.
            </p>
          </div>
        </div>
        <ChevronDown
          className="h-5 w-5 shrink-0 text-mute transition-transform duration-200 group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="mt-5 grid gap-6 border-t border-line pt-5">
        {/* Переключатель ОС */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-xl border border-line bg-bg p-1" role="tablist" aria-label="Операционная система">
            {OS_TABS.map((tab) => {
              const active = os === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setOs(tab.id)}
                  className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                    active
                      ? "bg-accent text-white"
                      : "text-mute hover:text-ink"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <p className="m-0 text-xs text-mute">
            Тестируемый домен: <code className="font-semibold text-ink">{targetDomain}</code> · DNS-сервер:{" "}
            <code className="font-semibold text-ink">{dnsIp}</code>
          </p>
        </div>

        {/* Ожидаемые IP для сверки */}
        <div className="rounded-xl border border-line bg-bg px-4 py-3 text-xs leading-relaxed text-mute">
          <strong className="text-ink">Как узнать адрес Перевала в ответе:</strong>{" "}
          Free-узлы: <code className="text-ink">{Array.from(new Set(freeIps)).join(", ")}</code>
          {proIps.length > 0 ? (
            <>
              {" · "}Pro-узлы: <code className="text-ink">{Array.from(new Set(proIps)).join(", ")}</code>
            </>
          ) : null}
          .
        </div>

        {/* Карточки команд */}
        <div className="grid gap-3 md:grid-cols-2">
          {commands.map((item) => (
            <div key={item.title} className="flex flex-col justify-between rounded-xl border border-line bg-bg p-4">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="m-0 text-[14px] font-semibold text-ink">{item.title}</h3>
                  <CopyButton value={item.command} />
                </div>
                <p className="m-0 mt-1.5 text-xs leading-relaxed text-mute">{item.hint}</p>
              </div>
              <pre className="mt-3 mb-0 overflow-x-auto rounded-lg bg-code p-3 text-[12.5px] leading-relaxed text-ink">
                <code>{item.command}</code>
              </pre>
            </div>
          ))}
        </div>

        {/* Таблица расшифровки ответов */}
        <div>
          <h3 className="m-0 text-[15px] font-semibold">Как расшифровать вывод команд</h3>
          <p className="m-0 mt-1 text-xs text-mute">
            Сравните вывод <code>{os === "windows" ? "nslookup" : "dig"}</code> и <code>curl -vI</code> со строками ниже:
          </p>
          <div className="mt-3 overflow-x-auto rounded-xl border border-line">
            <table className="w-full border-collapse text-left text-xs sm:text-[13px]">
              <thead>
                <tr className="border-b border-line bg-panel-elevated text-mute">
                  <th className="px-3.5 py-2.5 font-semibold">Сценарий</th>
                  <th className="px-3.5 py-2.5 font-semibold">Ответ DNS (A / AAAA)</th>
                  <th className="px-3.5 py-2.5 font-semibold">Вывод curl -vI</th>
                  <th className="px-3.5 py-2.5 font-semibold">Что делать</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line bg-bg">
                {DECODER_ROWS.map((row) => (
                  <tr key={row.scenario} className="align-top">
                    <td className="px-3.5 py-3 font-semibold whitespace-nowrap">
                      <span
                        className={
                          row.tone === "ok"
                            ? "text-ok"
                            : row.tone === "warn"
                              ? "text-warn"
                              : "text-err"
                        }
                      >
                        {row.scenario}
                      </span>
                    </td>
                    <td className="px-3.5 py-3 font-mono text-[12px] text-ink/90">{row.dnsOutput}</td>
                    <td className="px-3.5 py-3 font-mono text-[12px] text-ink/90">{row.curlOutput}</td>
                    <td className="px-3.5 py-3 text-mute">{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </details>
  );
}
