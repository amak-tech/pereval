"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { track } from "@/components/track";
import { evaluateFreeClusterLoad, type ClusterHealthSummary } from "@/lib/cluster-load";

type Live = {
  online: number;
  connections: number;
  workersUp: number | null;
  workersTotal: number | null;
  cluster: ClusterHealthSummary;
};

const fmt = new Intl.NumberFormat("ru-RU");

/**
 * Бейдж живой нагрузки Free-кластера из /api/stats.
 * Обновляется каждые 30 с; при загрузке >70% от max_clients переключается на мягкий апсейл в Pro.
 */
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
          cluster?: {
            fail_open_active?: boolean;
            workers?: { ip?: string; healthy?: boolean; status?: "up" | "down" }[];
          } | null;
        };
        const l = data.stats?.live;
        if (!l) throw new Error("no stats");
        const workers = data.cluster?.workers;
        if (alive) {
          setLive({
            online: l.online_users_5m ?? 0,
            connections: l.active_connections ?? 0,
            workersUp: workers ? workers.filter((w) => w.healthy ?? w.status === "up").length : null,
            workersTotal: workers ? workers.length : null,
            cluster: data.cluster ?? null,
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
  const load = live ? evaluateFreeClusterLoad({ onlineUsers5m: live.online, cluster: live.cluster }) : null;

  if (load?.isHighLoad) {
    return (
      <Link
        href="/pro"
        onClick={() =>
          track("pro_upsell_click", {
            source: "hero_load_badge",
            load_pct: load.loadPercent,
            evening_msk: load.isEveningMsk,
          })
        }
        title={`Загрузка бесплатного кластера: ${load.loadPercent}% (${fmt.format(load.online)} из ${fmt.format(load.maxClients)} клиентов)`}
        className="inline-flex items-center gap-2 rounded-full border border-warn bg-warn-bg px-3.5 py-1.5 text-xs font-medium text-warn no-underline transition-opacity hover:opacity-90"
        aria-live="polite"
      >
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-warn opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-warn" />
        </span>
        <span>{load.upsellMessage}</span>
      </Link>
    );
  }

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
