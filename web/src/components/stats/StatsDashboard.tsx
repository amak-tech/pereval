"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleCheck, CircleX, RefreshCw } from "lucide-react";
import type { ClusterHealth, ProHealth, StatsResponse, TopService, WorkerHealth } from "@/components/stats/types";
import { fmtAgo, fmtBytes, fmtNum } from "@/components/stats/format";
import { poolLabel } from "@/lib/catalog";

const POLL_MS = 5000;

const ChartSkeleton = ({ h }: { h: number }) => <div className="w-full rounded-lg bg-code" style={{ height: h }} aria-hidden />;
const MinuteChart = dynamic(() => import("@/components/stats/StatsCharts").then((m) => m.MinuteChart), { ssr: false, loading: () => <ChartSkeleton h={220} /> });
const TopServicesChart = dynamic(() => import("@/components/stats/StatsCharts").then((m) => m.TopServicesChart), { ssr: false, loading: () => <ChartSkeleton h={316} /> });

type Conn = "loading" | "live" | "stale";

/** Дашборд /stats: опрос /api/stats каждые 5 с, плитки, графики, здоровье пулов и узлов. */
export function StatsDashboard({ freeDomain, proDomain, serviceCount }: { freeDomain: string; proDomain: string | null; serviceCount: number }) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [conn, setConn] = useState<Conn>("loading");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [win, setWin] = useState<"24h" | "1h">("24h");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const res = await fetch("/api/stats", { cache: "no-store", headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as StatsResponse;
        if (!alive) return;
        setData(json);
        setUpdatedAt(Date.now());
        setConn(json.stats ? "live" : "stale");
      } catch {
        if (alive) setConn("stale");
      }
      if (alive && document.visibilityState === "visible") timer = setTimeout(load, POLL_MS);
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        load();
      }
    };
    load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick]);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const stats = data?.stats ?? null;
  const live = stats?.live ?? {};
  const top = useMemo<TopService[]>(() => {
    if (!stats) return [];
    const rows = win === "1h" ? stats.top_services_1h : stats.top_services_24h;
    return rows && rows.length ? rows : (stats.top_services_24h ?? []);
  }, [stats, win]);

  const genAgo = stats?.generated_at ? Math.max(0, now / 1000 - stats.generated_at) : null;
  const dataStale = genAgo !== null && genAgo > 120;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-xs" role="status" aria-live="polite">
          <span className="relative flex h-2 w-2" aria-hidden>
            {conn === "live" && !dataStale ? <span className="absolute inline-flex h-full w-full rounded-full bg-ok opacity-60 motion-safe:animate-ping" /> : null}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${conn === "live" && !dataStale ? "bg-ok" : conn === "loading" ? "bg-mute" : "bg-warn"}`} />
          </span>
          <span className="text-mute">
            {conn === "loading" ? "Загрузка метрик…" : conn === "stale" && !stats ? "Данные недоступны" : dataStale ? `Сборщик не обновлялся ${fmtAgo(genAgo ?? 0)}` : updatedAt ? `Обновлено ${fmtAgo((now - updatedAt) / 1000)}` : "—"}
            {conn === "stale" && stats ? " · нет связи с API, показаны последние данные" : ""}
          </span>
        </div>
        <button type="button" onClick={() => setTick((v) => v + 1)} className="btn-secondary !px-3 !py-1.5 !text-sm">
          <RefreshCw className="h-4 w-4" aria-hidden /> Обновить сейчас
        </button>
      </div>

      {!stats && conn !== "loading" ? (
        <div className="card text-center">
          <p className="m-0 font-semibold">Данные статистики временно недоступны</p>
          <p className="m-0 mt-2 text-sm text-mute">Сборщик метрик на кластере не отвечает. Страница продолжит опрашивать API каждые 5 секунд.</p>
        </div>
      ) : null}

      <section aria-label="Ключевые показатели" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Пользователей онлайн" hint="за 5 минут" value={fmtNum(live.online_users_5m)} unit="уник. IP" sub={[`За 1 ч: ${fmtNum(live.unique_users_1h)}`, `За 24 ч: ${fmtNum(live.unique_users_24h)}`]} loading={!stats} />
        <StatTile label="Активных соединений" hint="TCP :443 / :80" value={fmtNum(live.active_connections)} sub={[`Запросов сейчас: ${fmtNum(live.requests_current_min)}/мин`, `Пик за час: ${fmtNum(live.peak_requests_1m)}/мин`]} loading={!stats} />
        <StatTile label="Запросов за час" hint="сессий прокси" value={fmtNum(live.requests_1h)} sub={[`За 24 ч: ${fmtNum(live.requests_24h)}`, `Пик в час: ${fmtNum(live.peak_requests_1h)}`]} loading={!stats} />
        <StatTile label="Трафик за 24 часа" hint="через прокси" value={fmtBytes(live.bytes_24h)} sub={[`За 1 ч: ${fmtBytes(live.bytes_1h)}`, `↑ ${fmtBytes(live.bytes_sent_24h)} · ↓ ${fmtBytes(live.bytes_recv_24h)}`]} loading={!stats} />
      </section>

      <section className="card" aria-labelledby="chart-min-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="chart-min-h" className="m-0 text-[17px] font-semibold">
            Запросы в минуту за последние 60 минут
          </h2>
          <span className="text-xs text-mute">наведите на столбец — увидите пользователей и трафик</span>
        </div>
        <div className="mt-4">{stats?.per_minute?.length ? <MinuteChart points={stats.per_minute} /> : <ChartSkeleton h={220} />}</div>
      </section>

      <section className="card" aria-labelledby="top-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="top-h" className="m-0 text-[17px] font-semibold">
              Популярные сервисы
            </h2>
            <p className="m-0 mt-1 text-xs text-mute">Группировка обращений по {serviceCount} сервисам каталога</p>
          </div>
          <div role="group" aria-label="Период" className="inline-flex rounded-lg border border-line bg-bg p-0.5 text-sm">
            {(["24h", "1h"] as const).map((w) => (
              <button key={w} type="button" aria-pressed={win === w} onClick={() => setWin(w)} className={`rounded-md px-3 py-1.5 ${win === w ? "bg-panel font-semibold text-accent shadow-[var(--shadow-card)]" : "text-mute hover:text-ink"}`}>
                {w === "24h" ? "За 24 часа" : "За 1 час"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4">{top.length ? <TopServicesChart rows={top} /> : <p className="m-0 py-8 text-center text-sm text-mute">{stats ? "Пока нет данных за выбранный период" : "Нет данных"}</p>}</div>
        {top.length ? (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium text-mute hover:text-ink">Таблица: все сервисы периода ({top.length})</summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-mute">
                    <th scope="col" className="py-2 pr-3 font-semibold">Сервис</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Категория</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold">Польз.</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold">Запросы</th>
                    <th scope="col" className="py-2 text-right font-semibold">Трафик</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((r) => (
                    <tr key={r.service} className="border-t border-line">
                      <td className="py-2 pr-3 font-medium">{r.service}</td>
                      <td className="py-2 pr-3 text-mute">{r.category}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(r.unique_users)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(r.requests)}</td>
                      <td className="py-2 text-right tabular-nums">{fmtBytes(r.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </section>

      <section className="grid gap-4 lg:grid-cols-2" aria-label="Здоровье узлов">
        <HealthCard title={`Free-кластер · ${freeDomain}`} health={data?.cluster ?? null} kind="free" loading={conn === "loading"} />
        <HealthCard title={`Pro-кластер · ${proDomain ?? "pro"}`} health={data?.pro ?? null} kind="pro" loading={conn === "loading"} />
      </section>

      <p className="note m-0 text-sm" role="note">
        <strong>Приватность и нулевая нагрузка на прокси.</strong> Метрики собираются фоновым процессом из буферизованных логов nginx и таблицы сокетов без логирования DNS-запросов. Для подсчёта уникальных пользователей IP-адреса хешируются в оперативной памяти с суточной криптографической солью (blake2b) и никогда не сохраняются в файлах статистики.
      </p>
    </div>
  );
}

function StatTile({ label, hint, value, unit, sub, loading }: { label: string; hint?: string; value: string; unit?: string; sub?: string[]; loading?: boolean }) {
  return (
    <div className="card flex flex-col justify-between gap-3" aria-busy={loading}>
      <div>
        <p className="m-0 flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
          <span>{label}</span>
          {hint ? <span className="font-normal normal-case tracking-normal">{hint}</span> : null}
        </p>
        <p className="m-0 mt-1 flex items-baseline gap-1.5">
          <span className="text-[clamp(28px,4vw,34px)] font-semibold leading-none tracking-tight">{loading ? "—" : value}</span>
          {unit ? <span className="text-xs text-mute">{unit}</span> : null}
        </p>
      </div>
      {sub?.length ? (
        <p className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-mute">
          {sub.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function HealthCard({ title, health, kind, loading }: { title: string; health: ClusterHealth | ProHealth | null; kind: "free" | "pro"; loading: boolean }) {
  const workers: WorkerHealth[] = health?.workers ?? [];
  const up = workers.filter((w) => w.healthy ?? w.status === "up").length;
  const pools = health?.pools ?? {};
  const meta: ReactNode[] = [];
  if (kind === "free" && health && "mode" in health) {
    const c = health as ClusterHealth;
    meta.push(<span key="mode">режим: {c.mode === "workers" ? "воркеры" : c.mode === "primary" ? "основной узел" : (c.mode ?? "—")}</span>);
    if (c.fail_open_active) meta.push(<span key="fo" className="text-warn">fail-open: трафик идёт через основной узел</span>);
  }
  if (kind === "pro" && health && "qps" in health) {
    const p = health as ProHealth;
    meta.push(<span key="qps">DNS-запросов/с: {typeof p.qps === "number" ? p.qps.toFixed(1) : "—"}</span>);
    if (typeof p.policy_version === "number") meta.push(<span key="pv">политика v{p.policy_version}</span>);
    if (p.fail_open) meta.push(<span key="fo" className="text-warn">fail-open</span>);
  }
  return (
    <div className="card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
        {health ? (
          <span className={`text-xs font-semibold ${up === workers.length ? "text-ok" : up === 0 ? "text-err" : "text-warn"}`}>
            узлов в строю: {up}/{workers.length}
          </span>
        ) : null}
      </div>
      {meta.length ? <p className="m-0 mt-1 flex flex-wrap gap-x-3 text-xs text-mute">{meta}</p> : null}
      {!health ? (
        <p className="m-0 mt-4 text-sm text-mute">{loading ? "Загрузка…" : "Данные о здоровье кластера недоступны."}</p>
      ) : (
        <>
          {Object.keys(pools).length ? (
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0">
              {Object.entries(pools).map(([pool, ips]) => (
                <li key={pool} className="chip !font-sans" title={ips.join(", ")}>
                  {poolLabel(pool)}: {ips.length}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <caption className="sr-only">{title}: состояние узлов</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-mute">
                  <th scope="col" className="py-2 pr-3 font-semibold">Узел</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Пулы</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Статус</th>
                  <th scope="col" className="py-2 text-right font-semibold">Задержка</th>
                </tr>
              </thead>
              <tbody>
                {workers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-3 text-center text-mute">
                      Воркеров нет — трафик обслуживает основной узел
                    </td>
                  </tr>
                ) : (
                  workers.map((w) => {
                    const ok = w.healthy ?? w.status === "up";
                    return (
                      <tr key={w.ip} className="border-t border-line align-top">
                        <td className="py-2 pr-3">
                          <div className="font-medium">{w.name}</div>
                          <div className="font-mono text-xs text-mute">{w.ip}</div>
                        </td>
                        <td className="py-2 pr-3 text-mute">{(w.pools ?? []).join(", ") || "—"}</td>
                        <td className="py-2 pr-3">
                          <span className={`inline-flex items-center gap-1 font-medium ${ok ? "text-ok" : "text-err"}`}>
                            {ok ? <CircleCheck className="h-4 w-4" aria-hidden /> : <CircleX className="h-4 w-4" aria-hidden />}
                            {ok ? "в строю" : "недоступен"}
                          </span>
                          {!ok && w.last_error ? (
                            <div className="mt-0.5 max-w-[240px] truncate text-xs text-mute" title={w.last_error}>
                              {w.last_error}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-2 text-right tabular-nums">{typeof w.latency_ms === "number" && w.latency_ms > 0 ? `${Math.round(w.latency_ms)} мс` : "—"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
