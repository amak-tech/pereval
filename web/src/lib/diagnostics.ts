import {
  catalog,
  normalizeSearchHost,
  poolLabel,
  serviceSlug,
  type Catalog,
} from "@/lib/catalog";

/** Контрольные сервисы без заголовка Cross-Origin-Resource-Policy: same-origin (для no-cors проб из браузера). */
export const CONTROL_PROBES: { id: string; name: string; host: string; url: string }[] = [
  { id: "claude", name: "Claude", host: "anthropic.com", url: "https://www.anthropic.com/favicon.ico" },
  { id: "chatgpt", name: "ChatGPT", host: "chatgpt.com", url: "https://chatgpt.com/favicon.ico" },
  { id: "gemini", name: "Gemini", host: "gemini.google.com", url: "https://gemini.google.com/favicon.ico" },
  { id: "cursor", name: "Cursor", host: "cursor.com", url: "https://cursor.com/favicon.ico" },
  { id: "jetbrains", name: "JetBrains", host: "jetbrains.com", url: "https://www.jetbrains.com/favicon.ico" },
];

export type CheckAccountContext = {
  authenticated: true;
  mode: "proxy" | "plain" | "deny";
  subscriptionStatus: string | null;
  ipBound: boolean;
  ipInDynamicAcl: boolean;
  dynamicAclExpiresAt: string | null;
  lastDnsSeenAt: string | null;
  disabledCategories: string[];
  /** Только для локальной подстановки в команды терминала — никогда не включается в отчёт для поддержки. */
  dohUrl: string | null;
  /** Только для локальной подстановки в команды терминала — никогда не включается в отчёт для поддержки. */
  dotHost: string | null;
};

export type CheckContextResponse = {
  detectedIp: string | null;
  checkDomain: string;
  checkUrl: string;
  ipv6CheckUrl: string | null;
  free: {
    domain: string;
    dnsIp: string;
    dohUrl: string;
    dotHost: string;
    workerIps: string[];
  };
  pro: {
    domain: string;
    dnsIp: string;
    workerIps: string[];
  } | null;
  account: CheckAccountContext | null;
};

export type BeaconResult =
  | {
      state: "ok";
      pereval: boolean;
      tier: "free" | "pro" | "none";
      mode: "proxy" | "none";
      ms: number;
    }
  | {
      state: "error";
      error: string;
      ms: number;
    };

export type NodeHealthResult = {
  id: "free" | "pro";
  label: string;
  host: string;
  ok: boolean;
  ms: number;
};

export type ServiceProbeResult = {
  id: string;
  name: string;
  host: string;
  ok: boolean;
  ms: number;
};

export type Ipv6ProbeResult = {
  state: "skipped" | "reachable" | "unreachable";
  ms?: number;
};

export type DomainLookupResult =
  | {
      status: "invalid";
      normalizedHost: string;
    }
  | {
      status: "free" | "pro";
      normalizedHost: string;
      matchedDomain: string;
      serviceName: string;
      serviceSlug: string;
      categoryId: string;
      categoryName: string;
      pool: string;
      poolName: string;
      categoryDisabled: boolean;
      note?: string;
    }
  | {
      status: "excluded";
      normalizedHost: string;
      matchedDomain: string;
      serviceName: string;
      categoryName: string;
    }
  | {
      status: "passthrough";
      normalizedHost: string;
      matchedDomain: string;
      note: string;
    }
  | {
      status: "disabled";
      normalizedHost: string;
      matchedDomain: string;
      groupName: string;
      note: string;
    }
  | {
      status: "not_found";
      normalizedHost: string;
    };

export type VerdictKind =
  | "ok"
  | "dns_not_configured"
  | "tspu_or_network"
  | "pro_access_issue"
  | "partial";

export type VerdictStep = {
  text: string;
  href?: string;
  linkLabel?: string;
};

export type VerdictResult = {
  kind: VerdictKind;
  tone: "ok" | "warn" | "err";
  causeLabel: string;
  title: string;
  summary: string;
  steps: VerdictStep[];
};

function suffixMatch(host: string, candidate: string): boolean {
  const c = candidate.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!c) return false;
  return host === c || host.endsWith(`.${c}`);
}

const VALID_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Проверяет домен или URL по каталогу Перевала (Free / Pro / excluded / passthrough / disabled / not_found). */
export function lookupDomainInCatalog(
  rawInput: string,
  cat: Catalog = catalog,
  disabledCategories: readonly string[] = [],
): DomainLookupResult {
  const host = normalizeSearchHost(rawInput);
  if (!host || !VALID_HOST_RE.test(host)) {
    return { status: "invalid", normalizedHost: host };
  }

  // 1. Сначала проверяем passthrough (российские сервисы, намеренно не проксируются)
  let bestPassthrough = "";
  for (const d of cat.passthrough.domains) {
    if (suffixMatch(host, d) && d.length > bestPassthrough.length) {
      bestPassthrough = d;
    }
  }
  if (bestPassthrough) {
    return {
      status: "passthrough",
      normalizedHost: host,
      matchedDomain: bestPassthrough,
      note: cat.passthrough.note,
    };
  }

  // 2. Ищем среди exclude_domains (служебные поддомены, исключённые из проксирования)
  let bestExcluded: { domain: string; serviceName: string; categoryName: string } | null = null;
  for (const c of cat.categories) {
    for (const s of c.services) {
      for (const ex of s.exclude_domains ?? []) {
        if (suffixMatch(host, ex) && (!bestExcluded || ex.length > bestExcluded.domain.length)) {
          bestExcluded = { domain: ex, serviceName: s.name, categoryName: c.name };
        }
      }
    }
  }
  if (bestExcluded) {
    return {
      status: "excluded",
      normalizedHost: host,
      matchedDomain: bestExcluded.domain,
      serviceName: bestExcluded.serviceName,
      categoryName: bestExcluded.categoryName,
    };
  }

  // 3. Активные сервисы Free и Pro (берём наиболее специфичное совпадение)
  const disabledSet = new Set(disabledCategories);
  let bestMatch: {
    domain: string;
    tier: "free" | "pro";
    serviceName: string;
    serviceSlug: string;
    categoryId: string;
    categoryName: string;
    pool: string;
    note?: string;
  } | null = null;

  for (const c of cat.categories) {
    for (const s of c.services) {
      for (const d of s.domains) {
        if (suffixMatch(host, d) && (!bestMatch || d.length > bestMatch.domain.length)) {
          bestMatch = {
            domain: d,
            tier: c.tier,
            serviceName: s.name,
            serviceSlug: serviceSlug(s),
            categoryId: c.id,
            categoryName: c.name,
            pool: s.pool || c.pool || "default",
            ...(s.note ? { note: s.note } : {}),
          };
        }
      }
    }
  }

  if (bestMatch) {
    return {
      status: bestMatch.tier,
      normalizedHost: host,
      matchedDomain: bestMatch.domain,
      serviceName: bestMatch.serviceName,
      serviceSlug: bestMatch.serviceSlug,
      categoryId: bestMatch.categoryId,
      categoryName: bestMatch.categoryName,
      pool: bestMatch.pool,
      poolName: poolLabel(bestMatch.pool),
      categoryDisabled: disabledSet.has(bestMatch.categoryId),
      ...(bestMatch.note ? { note: bestMatch.note } : {}),
    };
  }

  // 4. Отключённые домены
  let bestDisabled: { domain: string; groupName: string; note: string } | null = null;
  for (const g of cat.disabled) {
    for (const d of g.domains) {
      if (suffixMatch(host, d) && (!bestDisabled || d.length > bestDisabled.domain.length)) {
        bestDisabled = { domain: d, groupName: g.name, note: g.note };
      }
    }
  }
  if (bestDisabled) {
    return {
      status: "disabled",
      normalizedHost: host,
      matchedDomain: bestDisabled.domain,
      groupName: bestDisabled.groupName,
      note: bestDisabled.note,
    };
  }

  return { status: "not_found", normalizedHost: host };
}

export type VerdictInput = {
  beacon: BeaconResult;
  probes: readonly ServiceProbeResult[];
  account: CheckAccountContext | null;
  ipv6?: Ipv6ProbeResult;
  domainCheck?: DomainLookupResult | null;
};

/** Вычисляет главный вердикт диагностики («Проблема в DNS» vs «Блокировка ТСПУ / сети» vs «Pro-доступ» vs «Всё работает»). */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const { beacon, probes, account, ipv6, domainCheck } = input;
  const total = probes.length;
  const okCount = probes.filter((p) => p.ok).length;

  // 1. Маячок не ответил (сетевая ошибка / таймаут / блокировка)
  if (beacon.state === "error") {
    return {
      kind: "tspu_or_network",
      tone: "err",
      causeLabel: "Сбой сети или блокировка ТСПУ",
      title: "Не удалось связаться с проверочным узлом check.pereval.top",
      summary:
        "Браузер не получил ответ от служебного узла проверки. Это бывает при блокировке DNS/TLS провайдером, закрытом порте 443, конфликте с VPN/антивирусом или временном сбое сети.",
      steps: [
        { text: "Отключите VPN, сторонний прокси или DPI-утилиты на время проверки и нажмите «Проверить ещё раз»." },
        { text: "Если проблема повторяется только в Wi-Fi — проверьте с мобильного интернета (или наоборот)." },
        { text: "Раскройте секцию «Для продвинутых пользователей» ниже и выполните nslookup / curl — они покажут, на каком шаге обрывается соединение." },
      ],
    };
  }

  // 2. Маячок ответил от Control Plane -> DNS Перевала НЕ применяется
  if (beacon.tier === "none" || !beacon.pereval) {
    if (account && (account.mode === "plain" || account.mode === "deny")) {
      return {
        kind: "pro_access_issue",
        tone: "warn",
        causeLabel: "Проблема с Pro-подпиской",
        title: "Подписка Pro неактивна — DNS работает в обычном режиме",
        summary:
          "Ваш аккаунт переведён в режим обычного DNS без проксирования (подписка истекла или не оплачена), поэтому сайты открываются напрямую через провайдера.",
        steps: [
          {
            text: "Проверьте статус подписки и продлите доступ в личном кабинете.",
            href: "/account",
            linkLabel: "Открыть личный кабинет",
          },
          {
            text: "Если вам нужны только базовые ИИ-сервисы и инструменты разработки, можно переключиться на бесплатный DNS.",
            href: "/setup",
            linkLabel: "Инструкция Free DNS",
          },
        ],
      };
    }

    return {
      kind: "dns_not_configured",
      tone: "err",
      causeLabel: "Проблема в настройке DNS",
      title: "DNS Перевала сейчас не используется в этом браузере",
      summary:
        "Запросы идут через DNS провайдера или встроенный «Безопасный DNS» браузера (Cloudflare/Google), поэтому Перевал вообще не участвует в открытии сайтов. Это НЕ блокировка ТСПУ.",
      steps: [
        { text: "Отключите сторонний «Безопасный DNS» (DNS-over-HTTPS) в настройках браузера — или пропишите в нём адрес DoH Перевала." },
        { text: "После смены DNS в системе выключите и снова включите Wi-Fi (или авиарежим на телефоне), чтобы сбросить кэш." },
        {
          text: "Если ваш провайдер перехватывает обычный DNS (порт 53) — настройте шифрованный DoH или DoT по инструкции.",
          href: "/setup",
          linkLabel: "Пошаговые инструкции",
        },
      ],
    };
  }

  // 3. DNS Перевала активен (free или pro)
  const tierName = beacon.tier === "pro" ? "Перевал Pro DNS" : "Перевал Free DNS";

  // 3a. Pro DNS активен, но контрольные сервисы падают и IP не в bound_ips / acl_dynamic
  if (
    beacon.tier === "pro" &&
    account &&
    !account.ipBound &&
    !account.ipInDynamicAcl &&
    total > 0 &&
    okCount === 0
  ) {
    return {
      kind: "pro_access_issue",
      tone: "warn",
      causeLabel: "IP не разрешён на Pro-воркерах",
      title: "Pro DNS работает, но ваш текущий IP ещё не попал в список доступа",
      summary:
        "Pro-воркеры пропускают соединения только с разрешённых IP подписчиков. Похоже, ваш IP сменился или ещё не синхронизировался после DNS-запроса.",
      steps: [
        { text: "Подождите 10–15 секунд и нажмите «Проверить ещё раз» — динамический ACL синхронизируется автоматически после первого DNS-запроса." },
        {
          text: "Если используете обычный DNS по IP (UDP/53) или роутер, привяжите текущий IP в личном кабинете.",
          href: "/account",
          linkLabel: "Привязать IP в кабинете",
        },
      ],
    };
  }

  // 3b. DNS работает, но ни один контрольный сервис не отвечает -> ТСПУ / сеть / порт 443
  if (total > 0 && okCount === 0) {
    return {
      kind: "tspu_or_network",
      tone: "err",
      causeLabel: "Похоже на блокировку ТСПУ или сети",
      title: `${tierName} работает, но соединения до сервисов не проходят`,
      summary:
        "DNS настроен правильно и возвращает адреса Перевала, однако ни один контрольный сервис не ответил. Обычно это означает блокировку соединений средствами ТСПУ провайдера, закрытый порт 443 или вмешательство корпоративного файрвола/VPN.",
      steps: [
        { text: "Перевал работает как прозрачный SNI-прокси: если ТСПУ провайдера режет TLS-соединение по имени сайта (SNI) или блокирует зарубежный IP-диапазон, смена DNS это не обойдёт." },
        { text: "Проверьте в другой сети (например, с мобильного оператора вместо домашнего Wi-Fi), чтобы убедиться, что ограничение именно на стороне текущего провайдера." },
        { text: "Раскройте секцию «Для продвинутых пользователей» и запустите curl -vI — сброс соединения на этапе ClientHello подтвердит фильтрацию ТСПУ." },
      ],
    };
  }

  // 3c. Часть контрольных сервисов отвечает, часть нет
  if (total > 0 && okCount < total) {
    return {
      kind: "partial",
      tone: "warn",
      causeLabel: "Выборочное ограничение ТСПУ или таймаут",
      title: `${tierName} работает, но ответили только ${okCount} из ${total} сервисов`,
      summary:
        "DNS настроен верно и часть трафика проходит через Перевал, но отдельные сервисы не ответили. Это может быть выборочная фильтрация ТСПУ по конкретным SNI, утечка IPv6 или временный таймаут.",
      steps: [
        ...(ipv6?.state === "reachable"
          ? [{ text: "Обнаружен активный IPv6 — отключите IPv6 в настройках сети, иначе часть сайтов идёт напрямую в обход прокси." }]
          : []),
        { text: "Нажмите «Проверить ещё раз» через пару секунд, чтобы исключить случайный сетевой таймаут." },
        { text: "Проверьте проблемный сайт через curl -vI в секции «Для продвинутых пользователей»: если обрыв происходит на TLS ClientHello — его фильтрует ТСПУ провайдера." },
      ],
    };
  }

  // 3d. DNS работает и все контрольные сервисы отвечают
  const steps: VerdictStep[] = [];
  if (ipv6?.state === "reachable") {
    steps.push({
      text: "У вас работает IPv6: некоторые приложения могут подключаться по IPv6 напрямую мимо Перевала. Если какой-то сайт всё же выдаёт геоблок, отключите IPv6 в настройках сети.",
    });
  }
  if (domainCheck?.status === "pro" && beacon.tier === "free") {
    steps.push({
      text: `Сайт ${domainCheck.normalizedHost} (${domainCheck.serviceName}) входит только в тариф Pro, а сейчас активен Free DNS.`,
      href: "/pro",
      linkLabel: "Подробнее о Pro",
    });
  } else if (domainCheck && (domainCheck.status === "free" || domainCheck.status === "pro") && domainCheck.categoryDisabled) {
    steps.push({
      text: `Категория «${domainCheck.categoryName}» сейчас выключена в настройках вашего Pro-аккаунта — включите её в кабинете.`,
      href: "/account",
      linkLabel: "Настройки категорий",
    });
  }
  steps.push(
    { text: "Если конкретный сайт всё равно не открывается — проверьте его в блоке ниже, чтобы узнать, входит ли он в список Перевала." },
    { text: "Если сайт есть в списке, но бесконечно грузится или сбрасывает соединение — вероятна выборочная блокировка ТСПУ (проверьте через curl -vI ниже) или геоблок по стране самого аккаунта/карты." },
  );

  return {
    kind: "ok",
    tone: "ok",
    causeLabel: "DNS и прокси работают корректно",
    title: `${tierName} активен, все контрольные сервисы отвечают`,
    summary:
      "Настройки DNS применились правильно и трафик до контрольных сервисов свободно проходит через Перевал.",
    steps,
  };
}

export type SupportReportInput = {
  timestampIso: string;
  userAgent?: string;
  verdict: VerdictResult;
  beacon: BeaconResult;
  nodeHealth?: readonly NodeHealthResult[];
  probes: readonly ServiceProbeResult[];
  ipv6?: Ipv6ProbeResult;
  domainCheck?: DomainLookupResult | null;
  account: CheckAccountContext | null;
};

/**
 * Формирует компактный текстовый отчёт для отправки в поддержку (Telegram / email).
 * ГАРАНТИЯ ПРИВАТНОСТИ: никогда не включает токены, dohUrl, dotHost с токеном, email или IP-адрес клиента.
 */
export function buildSupportReport(input: SupportReportInput): string {
  const lines: string[] = [];
  lines.push("Диагностика Перевал (/check)");
  lines.push(`Время (UTC): ${input.timestampIso}`);
  if (input.userAgent) {
    lines.push(`Браузер/ОС: ${input.userAgent}`);
  }
  lines.push(`Вердикт: [${input.verdict.kind}] ${input.verdict.causeLabel} — ${input.verdict.title}`);

  if (input.beacon.state === "ok") {
    lines.push(
      `Маячок DNS: tier=${input.beacon.tier}, pereval=${input.beacon.pereval ? "yes" : "no"}, mode=${input.beacon.mode} (${input.beacon.ms} ms)`,
    );
  } else {
    lines.push(`Маячок DNS: error (${input.beacon.error}, ${input.beacon.ms} ms)`);
  }

  if (input.nodeHealth && input.nodeHealth.length > 0) {
    const nodes = input.nodeHealth
      .map((n) => `${n.host}=${n.ok ? `ok(${n.ms}ms)` : "fail"}`)
      .join(", ");
    lines.push(`Узлы DNS: ${nodes}`);
  }

  if (input.probes.length > 0) {
    const okCount = input.probes.filter((p) => p.ok).length;
    const detail = input.probes
      .map((p) => `${p.name}:${p.ok ? `${p.ms}ms` : "fail"}`)
      .join(", ");
    lines.push(`Контрольные сервисы (${okCount}/${input.probes.length}): ${detail}`);
  }

  if (input.ipv6 && input.ipv6.state !== "skipped") {
    lines.push(
      `IPv6: ${input.ipv6.state === "reachable" ? `активен (${input.ipv6.ms ?? 0}ms)` : "недоступен"}`,
    );
  }

  if (input.account) {
    const flags = [
      `mode=${input.account.mode}`,
      `sub=${input.account.subscriptionStatus ?? "none"}`,
      `ipBound=${input.account.ipBound ? "yes" : "no"}`,
      `dynAcl=${input.account.ipInDynamicAcl ? "yes" : "no"}`,
      `disabledCats=${input.account.disabledCategories.length > 0 ? input.account.disabledCategories.join(",") : "none"}`,
    ];
    if (input.account.lastDnsSeenAt) {
      flags.push(`lastDns=${input.account.lastDnsSeenAt}`);
    }
    lines.push(`Pro-аккаунт: ${flags.join(", ")}`);
  }

  if (input.domainCheck && input.domainCheck.status !== "invalid") {
    const d = input.domainCheck;
    if (d.status === "free" || d.status === "pro") {
      lines.push(
        `Проверяемый сайт: ${d.normalizedHost} -> ${d.status.toUpperCase()} (${d.serviceName}, pool=${d.pool}, catDisabled=${d.categoryDisabled ? "yes" : "no"})`,
      );
    } else if (d.status === "passthrough") {
      lines.push(`Проверяемый сайт: ${d.normalizedHost} -> passthrough (${d.matchedDomain})`);
    } else if (d.status === "disabled") {
      lines.push(`Проверяемый сайт: ${d.normalizedHost} -> disabled (${d.groupName})`);
    } else if (d.status === "excluded") {
      lines.push(`Проверяемый сайт: ${d.normalizedHost} -> excluded (${d.serviceName})`);
    } else {
      lines.push(`Проверяемый сайт: ${d.normalizedHost} -> not_found`);
    }
  }

  return lines.join("\n");
}
