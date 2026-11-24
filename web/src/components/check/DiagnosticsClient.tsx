"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CircleCheck,
  CircleX,
  Globe,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { AdvancedCommands } from "@/components/check/AdvancedCommands";
import { catalog } from "@/lib/catalog";
import { SITE } from "@/content/site";
import {
  buildSupportReport,
  computeVerdict,
  CONTROL_PROBES,
  lookupDomainInCatalog,
  type BeaconResult,
  type CheckContextResponse,
  type Ipv6ProbeResult,
  type NodeHealthResult,
  type ServiceProbeResult,
} from "@/lib/diagnostics";

const BEACON_TIMEOUT_MS = 6000;
const PROBE_TIMEOUT_MS = 7000;
const IPV6_TIMEOUT_MS = 3000;

const QUICK_EXAMPLES = ["claude.ai", "chatgpt.com", "notion.so", "gosuslugi.ru"];

type ProbeState = "idle" | "running" | "ok" | "fail";
type LiveServiceProbe = {
  id: string;
  name: string;
  host: string;
  url: string;
  state: ProbeState;
  ms: number | null;
};

type LiveNodeProbe = {
  id: "free" | "pro";
  label: string;
  host: string;
  state: ProbeState;
  ms: number | null;
};

async function runBeaconProbe(checkUrl: string): Promise<BeaconResult> {
  const started = performance.now();
  try {
    const bust = `${checkUrl}${checkUrl.includes("?") ? "&" : "?"}t=${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const res = await fetch(bust, {
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(BEACON_TIMEOUT_MS),
    });
    const ms = Math.round(performance.now() - started);
    if (!res.ok) {
      return { state: "error", error: `HTTP ${res.status}`, ms };
    }
    const data = (await res.json()) as {
      pereval?: unknown;
      tier?: unknown;
      mode?: unknown;
    };
    const tier = data.tier === "free" || data.tier === "pro" || data.tier === "none" ? data.tier : "none";
    const mode = data.mode === "proxy" || data.mode === "none" ? data.mode : "none";
    return {
      state: "ok",
      pereval: Boolean(data.pereval),
      tier,
      mode,
      ms,
    };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    const name = err instanceof Error ? err.name : "error";
    const msg = name === "TimeoutError" || name === "AbortError" ? "таймаут" : "сетевая ошибка";
    return { state: "error", error: msg, ms };
  }
}

async function runNoCorsProbe(url: string, timeoutMs: number): Promise<{ ok: boolean; ms: number }> {
  const started = performance.now();
  try {
    const bust = `${url}${url.includes("?") ? "&" : "?"}pereval=${Date.now().toString(36)}`;
    await fetch(bust, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started) };
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function DiagnosticsClient() {
  const [context, setContext] = useState<CheckContextResponse | null>(null);
  const [beacon, setBeacon] = useState<BeaconResult | null>(null);
  const [beaconRunning, setBeaconRunning] = useState(false);

  const [nodeProbes, setNodeProbes] = useState<LiveNodeProbe[]>(() => {
    const list: LiveNodeProbe[] = [
      { id: "free", label: "Free DNS", host: catalog.free.domain, state: "idle", ms: null },
    ];
    if (catalog.pro?.domain) {
      list.push({ id: "pro", label: "Pro DNS", host: catalog.pro.domain, state: "idle", ms: null });
    }
    return list;
  });

  const [serviceProbes, setServiceProbes] = useState<LiveServiceProbe[]>(() =>
    CONTROL_PROBES.map((t) => ({ ...t, state: "idle", ms: null })),
  );
  const [ipv6, setIpv6] = useState<Ipv6ProbeResult>({ state: "skipped" });
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);

  const [domainInput, setDomainInput] = useState("");
  const runIdRef = useRef(0);

  const running =
    beaconRunning ||
    serviceProbes.some((p) => p.state === "running") ||
    nodeProbes.some((n) => n.state === "running");

  const runDiagnostics = useCallback(async () => {
    const myRun = ++runIdRef.current;
    setBeaconRunning(true);
    setBeacon(null);
    setIpv6({ state: "skipped" });
    setServiceProbes((ps) => ps.map((p) => ({ ...p, state: "running", ms: null })));
    setNodeProbes((ns) => ns.map((n) => ({ ...n, state: "running", ms: null })));

    const defaultCheckDomain = catalog.meta.check_domain || "check.pereval.top";
    const defaultCheckUrl = `https://${defaultCheckDomain}/ping`;

    // 1. Загружаем контекст с Control Plane
    let ctx: CheckContextResponse | null = null;
    try {
      const res = await fetch("/api/check/context", {
        cache: "no-store",
        signal: AbortSignal.timeout(BEACON_TIMEOUT_MS),
      });
      if (res.ok) {
        ctx = (await res.json()) as CheckContextResponse;
      }
    } catch {
      ctx = null;
    }
    if (runIdRef.current !== myRun) return;
    if (ctx) setContext(ctx);

    const checkUrl = ctx?.checkUrl || defaultCheckUrl;
    const freeHost = ctx?.free.domain || catalog.free.domain;
    const proHost = ctx?.pro?.domain || catalog.pro?.domain || null;

    // 2. Параллельно: маячок DNS, доступность узлов, контрольные сервисы, опциональный IPv6
    const beaconPromise = runBeaconProbe(checkUrl).then((res) => {
      if (runIdRef.current !== myRun) return;
      setBeacon(res);
      setBeaconRunning(false);
    });

    const nodeTargets: { id: "free" | "pro"; host: string }[] = [{ id: "free", host: freeHost }];
    if (proHost) nodeTargets.push({ id: "pro", host: proHost });

    const nodePromises = nodeTargets.map(async (target) => {
      const res = await runNoCorsProbe(`https://${target.host}/healthz`, BEACON_TIMEOUT_MS);
      if (runIdRef.current !== myRun) return;
      setNodeProbes((ns) =>
        ns.map((n) => (n.id === target.id ? { ...n, host: target.host, state: res.ok ? "ok" : "fail", ms: res.ms } : n)),
      );
    });

    const servicePromises = CONTROL_PROBES.map(async (target, idx) => {
      const res = await runNoCorsProbe(target.url, PROBE_TIMEOUT_MS);
      if (runIdRef.current !== myRun) return;
      setServiceProbes((ps) =>
        ps.map((p, i) => (i === idx ? { ...p, state: res.ok ? "ok" : "fail", ms: res.ms } : p)),
      );
    });

    const ipv6Promise = ctx?.ipv6CheckUrl
      ? runNoCorsProbe(ctx.ipv6CheckUrl, IPV6_TIMEOUT_MS).then((res) => {
          if (runIdRef.current !== myRun) return;
          setIpv6(res.ok ? { state: "reachable", ms: res.ms } : { state: "unreachable", ms: res.ms });
        })
      : Promise.resolve();

    await Promise.all([beaconPromise, ...nodePromises, ...servicePromises, ipv6Promise]);
    if (runIdRef.current === myRun) {
      setLastRunAt(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void runDiagnostics();
    }, 0);
    return () => window.clearTimeout(id);
  }, [runDiagnostics]);

  const completedProbes: ServiceProbeResult[] = useMemo(
    () =>
      serviceProbes
        .filter((p) => p.state === "ok" || p.state === "fail")
        .map((p) => ({
          id: p.id,
          name: p.name,
          host: p.host,
          ok: p.state === "ok",
          ms: p.ms ?? 0,
        })),
    [serviceProbes],
  );

  const completedNodes: NodeHealthResult[] = useMemo(
    () =>
      nodeProbes
        .filter((n) => n.state === "ok" || n.state === "fail")
        .map((n) => ({
          id: n.id,
          label: n.label,
          host: n.host,
          ok: n.state === "ok",
          ms: n.ms ?? 0,
        })),
    [nodeProbes],
  );

  const domainCheck = useMemo(() => {
    if (!domainInput.trim()) return null;
    return lookupDomainInCatalog(domainInput, catalog, context?.account?.disabledCategories ?? []);
  }, [domainInput, context?.account?.disabledCategories]);

  const targetDomain =
    domainCheck && domainCheck.status !== "invalid" ? domainCheck.normalizedHost : "claude.ai";

  const verdict = useMemo(() => {
    if (!beacon || running) return null;
    return computeVerdict({
      beacon,
      probes: completedProbes,
      account: context?.account ?? null,
      ipv6,
      domainCheck,
    });
  }, [beacon, running, completedProbes, context?.account, ipv6, domainCheck]);

  const supportReport = useMemo(() => {
    if (!verdict || !beacon) return "";
    return buildSupportReport({
      timestampIso: lastRunAt || new Date().toISOString(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      verdict,
      beacon,
      nodeHealth: completedNodes,
      probes: completedProbes,
      ipv6,
      domainCheck,
      account: context?.account ?? null,
    });
  }, [verdict, beacon, lastRunAt, completedNodes, completedProbes, ipv6, domainCheck, context?.account]);

  const toneClasses =
    verdict?.tone === "ok"
      ? "border-ok/35 bg-ok-bg/60"
      : verdict?.tone === "warn"
        ? "border-warn/40 bg-warn-bg/60"
        : "border-err/40 bg-err-bg/60";

  const badgeClasses =
    verdict?.tone === "ok"
      ? "bg-ok/15 text-ok"
      : verdict?.tone === "warn"
        ? "bg-warn/15 text-warn"
        : "bg-err/15 text-err";

  return (
    <div className="grid gap-8">
      {/* Блок 1: Главный вердикт и чек-лист автодиагностики */}
      <section className="grid gap-4" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-lg font-semibold">1. Автодиагностика подключения</h2>
            <p className="m-0 mt-0.5 text-sm text-mute">
              Проверяем, работает ли DNS Перевала в этом браузере и проходят ли соединения до зарубежных сервисов.
            </p>
          </div>
          <button
            type="button"
            onClick={runDiagnostics}
            disabled={running}
            className="btn-primary !py-2.5 disabled:opacity-60"
          >
            {running ? (
              <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            {running ? "Проверяем…" : "Проверить ещё раз"}
          </button>
        </div>

        {/* Карточка главного вердикта */}
        {running || !verdict ? (
          <div className="card flex items-center gap-3.5 py-6">
            <LoaderCircle className="h-6 w-6 shrink-0 text-accent motion-safe:animate-spin" aria-hidden />
            <div>
              <p className="m-0 font-semibold text-ink">Идёт автоматическая диагностика…</p>
              <p className="m-0 mt-1 text-sm text-mute">
                Опрашиваем маячок <code>{context?.checkDomain || "check.pereval.top"}</code> и 5 контрольных сервисов. Обычно это занимает 1–3 секунды.
              </p>
            </div>
          </div>
        ) : (
          <div className={`rounded-2xl border p-5 sm:p-6 ${toneClasses}`} role="status">
            <div className="flex flex-wrap items-start gap-3.5">
              <div className="mt-0.5 shrink-0">
                {verdict.tone === "ok" ? (
                  <ShieldCheck className="h-7 w-7 text-ok" aria-hidden />
                ) : verdict.tone === "warn" ? (
                  <AlertTriangle className="h-7 w-7 text-warn" aria-hidden />
                ) : (
                  <ShieldAlert className="h-7 w-7 text-err" aria-hidden />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-[11.5px] font-semibold uppercase tracking-wide ${badgeClasses}`}
                >
                  {verdict.causeLabel}
                </span>
                <h3 className="m-0 mt-2 text-lg font-semibold leading-snug text-ink sm:text-xl">
                  {verdict.title}
                </h3>
                <p className="m-0 mt-2 text-[14.5px] leading-relaxed text-ink/90">{verdict.summary}</p>

                {verdict.steps.length > 0 ? (
                  <div className="mt-4 rounded-xl border border-line bg-bg/90 p-4">
                    <p className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute">
                      Что сделать сейчас
                    </p>
                    <ol className="m-0 mt-2.5 grid list-decimal gap-2 pl-5 text-sm leading-relaxed text-ink">
                      {verdict.steps.map((step, i) => (
                        <li key={i}>
                          <span>{step.text}</span>
                          {step.href ? (
                            <>
                              {" "}
                              <Link
                                href={step.href}
                                className="inline-flex items-center gap-1 font-medium text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
                              >
                                {step.linkLabel || "Открыть"}
                                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                              </Link>
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}

        {/* Подробный чек-лист автодиагностики */}
        <div className="grid gap-3 md:grid-cols-3">
          {/* Маячок DNS */}
          <div className="card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mute">
                <Globe className="h-4 w-4 text-accent" aria-hidden />
                Активный DNS
              </span>
              {beaconRunning ? (
                <LoaderCircle className="h-4 w-4 text-mute motion-safe:animate-spin" aria-hidden />
              ) : beacon?.state === "ok" && beacon.pereval ? (
                <CircleCheck className="h-4 w-4 text-ok" aria-hidden />
              ) : (
                <CircleX className="h-4 w-4 text-err" aria-hidden />
              )}
            </div>
            <p className="m-0 mt-2 text-[15px] font-semibold text-ink">
              {beaconRunning || !beacon
                ? "Проверяем…"
                : beacon.state === "error"
                  ? "Нет ответа от маячка"
                  : beacon.tier === "pro"
                    ? "Перевал Pro DNS"
                    : beacon.tier === "free"
                      ? "Перевал Free DNS"
                      : "DNS Перевала не используется"}
            </p>
            <p className="m-0 mt-1 font-mono text-xs text-mute">
              {beaconRunning || !beacon
                ? context?.checkDomain || "check.pereval.top"
                : beacon.state === "error"
                  ? `${beacon.error} (${beacon.ms} мс)`
                  : `tier=${beacon.tier} · ${beacon.ms} мс`}
            </p>
          </div>

          {/* Доступность DNS-узлов */}
          <div className="card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mute">
                <Server className="h-4 w-4 text-accent" aria-hidden />
                Узлы Перевала
              </span>
            </div>
            <ul className="m-0 mt-2.5 grid list-none gap-1.5 p-0 text-sm">
              {nodeProbes.map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-ink">{n.host}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs">
                    {n.state === "running" || n.state === "idle" ? (
                      <LoaderCircle className="h-3.5 w-3.5 text-mute motion-safe:animate-spin" aria-hidden />
                    ) : n.state === "ok" ? (
                      <>
                        <CircleCheck className="h-3.5 w-3.5 text-ok" aria-hidden />
                        <span className="text-ok">{n.ms} мс</span>
                      </>
                    ) : (
                      <>
                        <CircleX className="h-3.5 w-3.5 text-err" aria-hidden />
                        <span className="text-err">недоступен</span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* IP клиента и IPv6 */}
          <div className="card p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mute">
                <UserCheck className="h-4 w-4 text-accent" aria-hidden />
                Ваш IP и сеть
              </span>
            </div>
            <p className="m-0 mt-2 font-mono text-[14.5px] font-semibold text-ink">
              {context?.detectedIp || "Определяем…"}
            </p>
            <p className="m-0 mt-1 text-xs text-mute">
              {ipv6.state === "reachable" ? (
                <span className="font-medium text-warn">
                  IPv6 активен ({ipv6.ms} мс) — возможна утечка мимо IPv4-прокси
                </span>
              ) : ipv6.state === "unreachable" ? (
                <span className="text-ok">IPv6 не обнаружен (утечки нет)</span>
              ) : (
                "Проверку утечки IPv6 см. также в командах ниже"
              )}
            </p>
          </div>
        </div>

        {/* Состояние Pro-аккаунта (если авторизован) */}
        {context?.account ? (
          <div className="card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-[15px] font-semibold">Состояние вашего Pro-аккаунта</h3>
              <Link
                href="/account"
                className="inline-flex items-center gap-1 text-xs font-medium text-accent no-underline hover:underline"
              >
                Открыть кабинет
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <dl className="m-0 mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-line bg-bg px-3 py-2">
                <dt className="text-xs text-mute">Режим DNS</dt>
                <dd className="m-0 mt-0.5 font-mono text-[13px] font-semibold">
                  {context.account.mode === "proxy" ? (
                    <span className="text-ok">proxy (активен)</span>
                  ) : context.account.mode === "plain" ? (
                    <span className="text-warn">plain (без прокси)</span>
                  ) : (
                    <span className="text-err">deny (отключён)</span>
                  )}
                </dd>
              </div>
              <div className="rounded-lg border border-line bg-bg px-3 py-2">
                <dt className="text-xs text-mute">Текущий IP в ACL</dt>
                <dd className="m-0 mt-0.5 text-[13px] font-medium">
                  {context.account.ipBound ? (
                    <span className="text-ok">Привязан вручную</span>
                  ) : context.account.ipInDynamicAcl ? (
                    <span className="text-ok">
                      В динамическом ACL до {formatDateTime(context.account.dynamicAclExpiresAt)}
                    </span>
                  ) : (
                    <span className="text-warn">Не найден в ACL</span>
                  )}
                </dd>
              </div>
              <div className="rounded-lg border border-line bg-bg px-3 py-2">
                <dt className="text-xs text-mute">Последний DNS-запрос</dt>
                <dd className="m-0 mt-0.5 font-mono text-[13px]">
                  {formatDateTime(context.account.lastDnsSeenAt)}
                </dd>
              </div>
              <div className="rounded-lg border border-line bg-bg px-3 py-2">
                <dt className="text-xs text-mute">Отключённые категории</dt>
                <dd className="m-0 mt-0.5 text-[13px]">
                  {context.account.disabledCategories.length > 0 ? (
                    <span className="font-mono text-warn">{context.account.disabledCategories.join(", ")}</span>
                  ) : (
                    <span className="text-ok">Все включены</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}

        {/* 5 контрольных сервисов */}
        <div className="card p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="m-0 text-[15px] font-semibold">Прохождение соединений до контрольных сервисов</h3>
              <p className="m-0 mt-0.5 text-xs text-mute">
                Если маячок подтверждает DNS Перевала, но эти сервисы не отвечают — соединение режется сетью или ТСПУ.
              </p>
            </div>
          </div>
          <ul className="m-0 mt-3 grid list-none gap-2 p-0 sm:grid-cols-2 lg:grid-cols-5">
            {serviceProbes.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{p.name}</span>
                  <span className="block truncate font-mono text-[12px] text-mute">{p.host}</span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs">
                  {p.state === "running" || p.state === "idle" ? (
                    <LoaderCircle className="h-4 w-4 text-mute motion-safe:animate-spin" aria-hidden />
                  ) : p.state === "ok" ? (
                    <>
                      <CircleCheck className="h-4 w-4 text-ok" aria-hidden />
                      <span className="text-ok">{p.ms} мс</span>
                    </>
                  ) : (
                    <>
                      <CircleX className="h-4 w-4 text-err" aria-hidden />
                      <span className="text-err">нет ответа</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Блок 2: Проверка конкретного сайта */}
      <section className="card p-5 sm:p-6">
        <h2 className="m-0 text-lg font-semibold">2. Проверить конкретный сайт</h2>
        <p className="m-0 mt-1 text-sm text-mute">
          Вставьте домен или полную ссылку — покажем, входит ли сайт в Free или Pro и почему он может не открываться.
          Этот же домен автоматически подставится в команды терминала ниже.
        </p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-mute"
              aria-hidden
            />
            <input
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="Например: claude.ai или https://www.notion.so/page"
              aria-label="Домен или URL сайта для проверки"
              className="w-full rounded-xl border border-line-strong bg-bg py-2.5 pr-4 pl-10 text-sm text-ink placeholder:text-mute/70 focus:border-accent focus:outline-none"
            />
          </div>
          {domainInput ? (
            <button
              type="button"
              onClick={() => setDomainInput("")}
              className="rounded-xl border border-line-strong bg-panel-elevated px-4 py-2.5 text-sm font-medium text-mute hover:text-ink"
            >
              Очистить
            </button>
          ) : null}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-mute">
          <span>Быстрая проверка:</span>
          {QUICK_EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setDomainInput(ex)}
              className="rounded-md border border-line bg-bg px-2 py-0.5 font-mono text-[11.5px] text-ink transition-colors hover:border-accent/60 hover:text-accent"
            >
              {ex}
            </button>
          ))}
        </div>

        {domainCheck ? (
          <div className="mt-4 rounded-xl border border-line bg-bg p-4 text-sm">
            {domainCheck.status === "invalid" ? (
              <p className="m-0 text-mute">
                Введите корректный домен (например, <code>claude.ai</code>) или полную ссылку с <code>https://</code>.
              </p>
            ) : domainCheck.status === "free" || domainCheck.status === "pro" ? (
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-mono text-[11.5px] font-semibold ${
                      domainCheck.status === "free"
                        ? "bg-ok-bg text-ok"
                        : "bg-accent/15 text-accent"
                    }`}
                  >
                    {domainCheck.status === "free" ? "Входит в Free и Pro" : "Только в Pro"}
                  </span>
                  <span className="font-semibold text-ink">{domainCheck.serviceName}</span>
                  <span className="font-mono text-xs text-mute">({domainCheck.matchedDomain})</span>
                </div>
                <p className="m-0 text-mute">
                  Категория: <strong className="text-ink">{domainCheck.categoryName}</strong> · Пул:{" "}
                  <strong className="text-ink">{domainCheck.poolName}</strong>
                  {domainCheck.note ? ` · ${domainCheck.note}` : ""}
                </p>

                {domainCheck.categoryDisabled ? (
                  <p className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-warn">
                    Категория «{domainCheck.categoryName}» сейчас отключена в вашем Pro-аккаунте.{" "}
                    <Link href="/account" className="font-medium text-warn underline">
                      Включить в кабинете
                    </Link>
                  </p>
                ) : domainCheck.status === "pro" && beacon?.state === "ok" && beacon.tier === "free" ? (
                  <p className="m-0 rounded-lg bg-warn-bg px-3 py-2 text-warn">
                    Сейчас в браузере активен бесплатный Free DNS, а этот сервис доступен только в{" "}
                    <Link href="/pro" className="font-medium text-warn underline">
                      Перевал Pro
                    </Link>
                    .
                  </p>
                ) : beacon?.state === "ok" && beacon.tier === "none" ? (
                  <p className="m-0 rounded-lg bg-err-bg px-3 py-2 text-err">
                    Сайт поддерживается, но DNS Перевала сейчас не активен в этом браузере — сначала примените настройки DNS.
                  </p>
                ) : (
                  <p className="m-0 text-mute">
                    Сайт входит в каталог. Если он всё равно не открывается, проверьте его через{" "}
                    <code>curl -vI https://{domainCheck.normalizedHost}/</code> ниже — это покажет, режет ли его ТСПУ провайдера.{" "}
                    <Link
                      href={`/services/${domainCheck.serviceSlug}`}
                      className="text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
                    >
                      Карточка сервиса
                    </Link>
                  </p>
                )}
              </div>
            ) : domainCheck.status === "passthrough" ? (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-panel-elevated px-2.5 py-0.5 font-mono text-[11.5px] font-semibold text-ink">
                    Российский сервис (напрямую)
                  </span>
                  <code className="text-xs text-mute">{domainCheck.matchedDomain}</code>
                </div>
                <p className="m-0 text-mute">
                  Этот домен намеренно <strong>не проксируется</strong> Перевалом, чтобы российские сайты и банки работали напрямую без блокировок зарубежных IP.
                </p>
              </div>
            ) : domainCheck.status === "excluded" ? (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-panel-elevated px-2.5 py-0.5 font-mono text-[11.5px] font-semibold text-ink">
                    Служебный поддомен (напрямую)
                  </span>
                  <code className="text-xs text-mute">{domainCheck.matchedDomain}</code>
                </div>
                <p className="m-0 text-mute">
                  Поддомен сервиса <strong>{domainCheck.serviceName}</strong> намеренно исключён из проксирования (обычно для голоса/UDP/P2P) и идёт напрямую через провайдера.
                </p>
              </div>
            ) : domainCheck.status === "disabled" ? (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-warn-bg px-2.5 py-0.5 font-mono text-[11.5px] font-semibold text-warn">
                    Отключён в каталоге
                  </span>
                  <span className="font-medium text-ink">{domainCheck.groupName}</span>
                </div>
                <p className="m-0 text-mute">{domainCheck.note || "Этот домен сейчас отключён в конфигурации Перевала."}</p>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-panel-elevated px-2.5 py-0.5 font-mono text-[11.5px] font-semibold text-mute">
                    Нет в списке Перевала
                  </span>
                  <code className="text-xs text-ink">{domainCheck.normalizedHost}</code>
                </div>
                <p className="m-0 text-mute">
                  Перевал работает по строгому списку зарубежных платформ с геоблоком — этот домен идёт напрямую через вашего провайдера. Если сайт закрыт для РФ/РБ со стороны самой платформы, предложите добавить его в{" "}
                  <a href={SITE.telegram} target="_blank" rel="noopener" className="text-accent underline">
                    Telegram-чате
                  </a>{" "}
                  или на{" "}
                  <a href={`${SITE.github}/issues`} target="_blank" rel="noopener" className="text-accent underline">
                    GitHub
                  </a>
                  .
                </p>
              </div>
            )}
          </div>
        ) : null}
      </section>

      {/* Блок 3: Отчёт для поддержки */}
      <section className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
              <MessageSquare className="h-5 w-5 text-accent" aria-hidden />
              3. Нужна помощь? Скопируйте отчёт для поддержки
            </h2>
            <p className="m-0 mt-1 text-sm text-mute">
              Отчёт содержит только результаты проверок и безопасные флаги — <strong>без персонального токена, паролей, IP и email</strong>. Отправьте его в{" "}
              <a href={SITE.telegram} target="_blank" rel="noopener" className="text-accent underline">
                Telegram-чат поддержки
              </a>{" "}
              или на{" "}
              <a href={`mailto:${SITE.supportEmail}`} className="font-mono text-xs text-accent underline">
                {SITE.supportEmail}
              </a>
              .
            </p>
          </div>
          {supportReport ? (
            <CopyButton value={supportReport} label="Скопировать отчёт" className="!px-4 !py-2.5 !text-xs" />
          ) : null}
        </div>

        {supportReport ? (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-mute hover:text-ink">
              Посмотреть текст отчёта перед отправкой
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-xl border border-line bg-code p-3.5 text-xs leading-relaxed text-ink">
              <code>{supportReport}</code>
            </pre>
          </details>
        ) : null}
      </section>

      {/* Блок 4: Секция для продвинутых пользователей */}
      <AdvancedCommands targetDomain={targetDomain} context={context} beacon={beacon} />
    </div>
  );
}
