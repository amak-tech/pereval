"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity } from "lucide-react";

type Live = { online: number; connections: number; workersUp: number | null; workersTotal: number | null };

const fmt = new Intl.NumberFormat("ru-RU");

/** Бейдж живой нагрузки Free-кластера из /api/stats. Обновляется каждые 30 с, при ошибке молча показывает прочерк. */
export function LoadBadge() {
  const [live, setLive] = useState<Live | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          stats?: { live?: { online_users_5m?: number; active_connections?: number } } | null;
          cluster?: { workers?: { healthy?: boolean }[] } | null;
        };
        const l = data.stats?.live;
        if (!l) throw new Error("no stats");
        const workers = data.cluster?.workers;
        if (alive) {
          setLive({
            online: l.online_users_5m ?? 0,
            connections: l.active_connections ?? 0,
            workersUp: workers ? workers.filter((w) => w.healthy).length : null,
            workersTotal: workers ? workers.length : null,
          });
        }
      } catch {
        if (alive) setLive(null);
      }
      if (alive && document.visibilityState === "visible") timer = setTimeout(tick, 30_000);
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (live === null) {
    return (
      <Link href="/stats" className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-mute no-underline hover:text-ink">
        <Activity className="h-3.5 w-3.5" aria-hidden /> Статистика нагрузки
      </Link>
    );
  }
  const loading = live === undefined;
  return (
    <Link
      href="/stats"
      className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-mute no-underline hover:text-ink"
      aria-live="polite"
      aria-busy={loading}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className={`absolute inline-flex h-full w-full rounded-full bg-ok opacity-60 ${loading ? "" : "motion-safe:animate-ping"}`} />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
      </span>
      <span>
        Сейчас онлайн: <strong className="text-ink">{loading ? "—" : fmt.format(live.online)}</strong>
        <span className="hidden sm:inline">
          {" "}
          · соединений: <strong className="text-ink">{loading ? "—" : fmt.format(live.connections)}</strong>
        </span>
        {!loading && live.workersTotal ? (
          <span className="hidden md:inline">
            {" "}
            · узлов в строю: <strong className="text-ink">{live.workersUp}/{live.workersTotal}</strong>
          </span>
        ) : null}
      </span>
    </Link>
  );
}
