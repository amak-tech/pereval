"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, CircleCheck, CircleX, LoaderCircle, RefreshCw } from "lucide-react";
import { MouseTrailCanvas } from "@/components/MouseTrailCanvas";
import { catalog } from "@/lib/catalog";
import { CONTROL_PROBES, type BeaconResult } from "@/lib/diagnostics";

type ProbeState = "idle" | "running" | "ok" | "fail";
type Probe = { name: string; host: string; url: string; state: ProbeState; ms: number | null };

const TIMEOUT_MS = 7000;
const CHECK_DOMAIN = catalog.meta.check_domain || "check.pereval.top";
const CHECK_URL = `https://${CHECK_DOMAIN}/ping`;

/**
 * Быстрая проверка на главной странице: опрашивает маячок check.pereval.top
 * (отличает ненастроенный DNS от работы через Перевал) и 5 контрольных сервисов.
 * Полная диагностика, проверка конкретного сайта и отчёт для поддержки — на /check.
 */
export function ConnectivityCheck() {
  const [probes, setProbes] = useState<Probe[]>(
    CONTROL_PROBES.map((t) => ({ name: t.name, host: t.host, url: t.url, state: "idle", ms: null })),
  );
  const [beacon, setBeacon] = useState<BeaconResult | null>(null);
  const [beaconRunning, setBeaconRunning] = useState(false);

  const running = beaconRunning || probes.some((p) => p.state === "running");
  const done = !beaconRunning && beacon !== null && probes.every((p) => p.state === "ok" || p.state === "fail");

  async function run() {
    setBeaconRunning(true);
    setBeacon(null);
    setProbes((ps) => ps.map((p) => ({ ...p, state: "running", ms: null })));

    const beaconTask = (async () => {
      const started = performance.now();
      try {
        const bust = `${CHECK_URL}?t=${Date.now().toString(36)}`;
        const res = await fetch(bust, {
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const ms = Math.round(performance.now() - started);
        if (!res.ok) {
          setBeacon({ state: "error", error: `HTTP ${res.status}`, ms });
        } else {
          const data = (await res.json()) as { pereval?: unknown; tier?: unknown; mode?: unknown };
          const tier = data.tier === "free" || data.tier === "pro" || data.tier === "none" ? data.tier : "none";
          const mode = data.mode === "proxy" || data.mode === "none" ? data.mode : "none";
          setBeacon({ state: "ok", pereval: Boolean(data.pereval), tier, mode, ms });
        }
      } catch {
        setBeacon({ state: "error", error: "нет ответа", ms: Math.round(performance.now() - started) });
      } finally {
        setBeaconRunning(false);
      }
    })();

    const probeTasks = CONTROL_PROBES.map(async (t, i) => {
      const started = performance.now();
      let state: ProbeState = "fail";
      try {
        const bust = `${t.url}?pereval=${Date.now().toString(36)}`;
        await fetch(bust, {
          mode: "no-cors",
          cache: "no-store",
          credentials: "omit",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        state = "ok";
      } catch {
        state = "fail";
      }
      const ms = Math.round(performance.now() - started);
      setProbes((ps) => ps.map((p, j) => (j === i ? { ...p, state, ms } : p)));
    });

    await Promise.all([beaconTask, ...probeTasks]);
  }

  const okCount = probes.filter((p) => p.state === "ok").length;

  let summaryTone: "ok" | "warn" | "err" = "ok";
  let summaryText = "";
  if (done && beacon) {
    if (beacon.state === "ok" && (!beacon.pereval || beacon.tier === "none")) {
      summaryTone = "err";
      summaryText =
        "DNS Перевала сейчас не используется в этом браузере (возможен сторонний «Безопасный DNS» или кэш). Откройте подробную диагностику для пошагового решения.";
    } else if (beacon.state === "error") {
      summaryTone = "err";
      summaryText =
        "Не удалось связаться с проверочным узлом check.pereval.top — возможна блокировка сети/ТСПУ или временный сбой.";
    } else if (okCount === 0) {
      summaryTone = "err";
      summaryText = `DNS Перевала (${beacon.tier === "pro" ? "Pro" : "Free"}) активен, но контрольные сервисы не ответили — похоже на блокировку ТСПУ или закрытый порт 443.`;
    } else if (okCount < probes.length) {
      summaryTone = "warn";
      summaryText = `DNS Перевала (${beacon.tier === "pro" ? "Pro" : "Free"}) активен, ответили ${okCount} из ${probes.length} сервисов. Проверьте детали на странице диагностики.`;
    } else {
      summaryTone = "ok";
      summaryText = `DNS Перевала (${beacon.tier === "pro" ? "Pro" : "Free"}) активен и все контрольные сервисы отвечают.`;
    }
  }

  return (
    <div className="card relative overflow-hidden">
      <MouseTrailCanvas cellSize={16} maxAlpha={0.16} decay={0.03} />
      <div className="relative z-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="m-0 text-[17px] font-semibold">Быстрая проверка из браузера</h3>
            <p className="m-0 mt-1 text-sm text-mute">
              Проверим, активен ли DNS Перевала, и доходят ли соединения до 5 контрольных сервисов.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={run} disabled={running} className="btn-primary !py-2.5 disabled:opacity-60">
              {running ? (
                <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
              {done ? "Проверить ещё раз" : "Запустить проверку"}
            </button>
            <Link href="/check" className="btn-secondary !py-2.5">
              Подробная диагностика
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>

        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-live="polite" aria-busy={running}>
          {probes.map((p) => (
            <li key={p.host} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block font-medium">{p.name}</span>
                <span className="block truncate font-mono text-[12px] text-mute">{p.host}</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs">
                {p.state === "running" ? (
                  <>
                    <LoaderCircle className="h-4 w-4 text-mute motion-safe:animate-spin" aria-hidden />
                    <span className="sr-only">проверяем</span>
                  </>
                ) : p.state === "ok" ? (
                  <>
                    <CircleCheck className="h-4 w-4 text-ok" aria-hidden />
                    <span className="text-ok">{p.ms} мс</span>
                  </>
                ) : p.state === "fail" ? (
                  <>
                    <CircleX className="h-4 w-4 text-err" aria-hidden />
                    <span className="text-err">нет ответа</span>
                  </>
                ) : (
                  <span className="text-mute">—</span>
                )}
              </span>
            </li>
          ))}
        </ul>

        {done ? (
          <div
            className={`mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm ${
              summaryTone === "ok"
                ? "bg-ok-bg text-ok"
                : summaryTone === "err"
                  ? "bg-err-bg text-err"
                  : "bg-warn-bg text-warn"
            }`}
            role="status"
          >
            <p className="m-0 flex-1">{summaryText}</p>
            <Link
              href="/check"
              className="inline-flex shrink-0 items-center gap-1 font-semibold text-current underline underline-offset-4"
            >
              Проверить конкретный сайт и ТСПУ
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
        ) : (
          <p className="m-0 mt-4 text-xs text-mute">
            Нужно проверить конкретный сайт, отличить проблему DNS от блокировки ТСПУ или собрать отчёт для поддержки?{" "}
            <Link href="/check" className="font-medium text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent">
              Перейти в инструмент диагностики (/check)
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
