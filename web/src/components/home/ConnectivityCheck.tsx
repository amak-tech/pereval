"use client";

import { useState } from "react";
import { CircleCheck, CircleX, LoaderCircle, RefreshCw } from "lucide-react";

type ProbeState = "idle" | "running" | "ok" | "fail";
type Probe = { name: string; host: string; url: string; state: ProbeState; ms: number | null };

// claude.ai отдаёт Cross-Origin-Resource-Policy: same-origin — браузер отбрасывает такой ответ как сетевую
// ошибку, и проверка ложно показывает «нет ответа». Поэтому для Claude проверяем anthropic.com из того же
// набора доменов (резолвится в ту же ноду прокси).
const TARGETS: { name: string; host: string; url: string }[] = [
  { name: "Claude", host: "anthropic.com", url: "https://www.anthropic.com/favicon.ico" },
  { name: "ChatGPT", host: "chatgpt.com", url: "https://chatgpt.com/favicon.ico" },
  { name: "Gemini", host: "gemini.google.com", url: "https://gemini.google.com/favicon.ico" },
  { name: "Cursor", host: "cursor.com", url: "https://cursor.com/favicon.ico" },
  { name: "JetBrains", host: "jetbrains.com", url: "https://www.jetbrains.com/favicon.ico" },
];

const TIMEOUT_MS = 8000;

/**
 * Проверка из браузера: запрашиваем favicon нескольких сервисов в режиме no-cors и засекаем время.
 * Ответ непрозрачный, поэтому «ок» означает «TCP/TLS-соединение установлено и ответ получен»,
 * а «нет ответа» — таймаут или сетевую ошибку (DNS не применился, порт 443 закрыт, сервис недоступен).
 * Цели выбираем без заголовка Cross-Origin-Resource-Policy: с ним fetch в no-cors падает, хотя соединение есть.
 */
export function ConnectivityCheck() {
  const [probes, setProbes] = useState<Probe[]>(TARGETS.map((t) => ({ ...t, state: "idle", ms: null })));
  const running = probes.some((p) => p.state === "running");
  const done = probes.every((p) => p.state === "ok" || p.state === "fail");

  async function run() {
    setProbes((ps) => ps.map((p) => ({ ...p, state: "running", ms: null })));
    await Promise.all(
      TARGETS.map(async (t, i) => {
        const started = performance.now();
        let state: ProbeState = "fail";
        try {
          const bust = `${t.url}?pereval=${Date.now().toString(36)}`;
          await fetch(bust, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS) });
          state = "ok";
        } catch {
          state = "fail";
        }
        const ms = Math.round(performance.now() - started);
        setProbes((ps) => ps.map((p, j) => (j === i ? { ...p, state, ms } : p)));
      }),
    );
  }

  const okCount = probes.filter((p) => p.state === "ok").length;

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="m-0 text-[17px] font-semibold">Проверка из браузера</h3>
          <p className="m-0 mt-1 text-sm text-mute">Запросим иконки пяти сервисов и замерим время ответа. Ничего не отправляется на наш сервер.</p>
        </div>
        <button type="button" onClick={run} disabled={running} className="btn-primary !py-2.5 disabled:opacity-60">
          {running ? <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          {done ? "Проверить ещё раз" : "Запустить проверку"}
        </button>
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
        <p className={`mt-4 rounded-lg px-4 py-3 text-sm ${okCount === probes.length ? "bg-ok-bg text-ok" : okCount === 0 ? "bg-err-bg text-err" : "bg-warn-bg text-warn"}`} role="status">
          {okCount === probes.length
            ? "Соединения со всеми сервисами проходят. Если сайт всё же сообщает о недоступности в регионе — проверьте «Безопасный DNS» в браузере и отключите IPv6 (см. вопросы ниже)."
            : okCount === 0
              ? "Ни один сервис не ответил. Убедитесь, что настройки DNS применились (перезапустите Wi-Fi) и что сеть не блокирует исходящие соединения на порт 443."
              : `Ответили ${okCount} из ${probes.length}. Возможно, часть запросов упёрлась в таймаут — повторите проверку через несколько секунд.`}
        </p>
      ) : null}
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium text-mute hover:text-ink">Проверка из терминала (nslookup / curl)</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-code p-3 text-[13px] leading-relaxed">
          <code>{`# в ответе должен быть адрес нашего сервера, а не настоящий адрес Anthropic
nslookup claude.ai

# должно вывести 200 или 307
curl -sI https://claude.ai/ | head -1`}</code>
        </pre>
        <p className="m-0 mt-2 text-mute">
          Если <code>nslookup</code> возвращает другой адрес — настройки DNS не применились. Если адрес верный, но страница не открывается, проверьте, что сеть не блокирует исходящие соединения на порт 443.
        </p>
      </details>
    </div>
  );
}
