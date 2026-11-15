import { catalog, type Catalog, type PoolInfo, type WorkerInfo } from "@/lib/catalog";

/** Порог мягкого апсейла: загрузка бесплатного кластера свыше 70% от расчётной ёмкости max_clients. */
export const FREE_HIGH_LOAD_THRESHOLD = 0.7;
const FALLBACK_NODE_MAX_CLIENTS = 300;
const MSK_UTC_OFFSET_HOURS = 3;

export type ClusterWorkerStatus = {
  ip?: string;
  healthy?: boolean;
  status?: "up" | "down";
};

export type ClusterHealthSummary = {
  fail_open_active?: boolean;
  workers?: ClusterWorkerStatus[];
} | null;

export type FreeCapacityConfig = Pick<Catalog["free"], "max_clients" | "pools" | "workers">;

export type FreeClusterLoad = {
  online: number;
  maxClients: number;
  loadRatio: number;
  loadPercent: number;
  isHighLoad: boolean;
  isEveningMsk: boolean;
  upsellMessage: string;
};

function posInt(val: unknown): number | null {
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  const n = Math.floor(val);
  return n >= 1 ? n : null;
}

/**
 * Эффективный лимит max_clients для воркера по тому же приоритету, что в nodewatch и poolrouting:
 * worker.max_clients -> min(pool.max_clients) -> cluster.max_clients -> fallback.
 */
export function resolveFreeWorkerMaxClients(
  worker: Pick<WorkerInfo, "pools" | "max_clients">,
  pools: Record<string, PoolInfo> | undefined,
  clusterMaxClients: number | null | undefined,
  fallbackMaxClients = FALLBACK_NODE_MAX_CLIENTS,
): number {
  const workerLimit = posInt(worker.max_clients);
  if (workerLimit !== null) return workerLimit;

  if (pools) {
    const poolLimits: number[] = [];
    for (const poolName of worker.pools ?? []) {
      const pLimit = posInt(pools[poolName]?.max_clients);
      if (pLimit !== null) poolLimits.push(pLimit);
    }
    if (poolLimits.length > 0) return Math.min(...poolLimits);
  }

  const clusterLimit = posInt(clusterMaxClients);
  if (clusterLimit !== null) return clusterLimit;

  return posInt(fallbackMaxClients) ?? FALLBACK_NODE_MAX_CLIENTS;
}

/**
 * Суммарная ёмкость активных узлов бесплатного кластера.
 * Если активных здоровых воркеров нет или включён fail-open, трафик идёт через основной узел (primary).
 */
export function computeFreeClusterCapacity(
  freeConfig: FreeCapacityConfig = catalog.free,
  clusterHealth: ClusterHealthSummary = null,
): number {
  const primaryMax = posInt(freeConfig.max_clients) ?? FALLBACK_NODE_MAX_CLIENTS;
  const configuredWorkers = (freeConfig.workers ?? []).filter(
    (w) => w.ip && !w.ip.startsWith("203.0.113."),
  );

  if (configuredWorkers.length === 0 || clusterHealth?.fail_open_active) {
    return primaryMax;
  }

  const statusByIp = new Map<string, boolean>();
  for (const w of clusterHealth?.workers ?? []) {
    if (w.ip) {
      const up = w.healthy ?? (w.status ? w.status === "up" : true);
      statusByIp.set(w.ip, Boolean(up));
    }
  }

  const activeWorkers =
    statusByIp.size > 0
      ? configuredWorkers.filter((w) => statusByIp.get(w.ip) ?? true)
      : configuredWorkers;

  if (activeWorkers.length === 0) {
    return primaryMax;
  }

  return activeWorkers.reduce(
    (sum, w) => sum + resolveFreeWorkerMaxClients(w, freeConfig.pools, freeConfig.max_clients, primaryMax),
    0,
  );
}

/** Вечерний прайм-тайм по московскому времени (UTC+3): с 19:00 до 23:00 МСК. */
export function isEveningPeakMsk(now: Date = new Date()): boolean {
  const mskHour = (now.getUTCHours() + MSK_UTC_OFFSET_HOURS) % 24;
  return mskHour >= 19 && mskHour < 23;
}

/** Оценивает текущую нагрузку Free-кластера и формирует контекстный текст апсейла в Pro при >70%. */
export function evaluateFreeClusterLoad(params: {
  onlineUsers5m: number | null | undefined;
  cluster?: ClusterHealthSummary;
  freeConfig?: FreeCapacityConfig;
  now?: Date;
  threshold?: number;
}): FreeClusterLoad | null {
  const {
    onlineUsers5m,
    cluster = null,
    freeConfig = catalog.free,
    now = new Date(),
    threshold = FREE_HIGH_LOAD_THRESHOLD,
  } = params;

  if (typeof onlineUsers5m !== "number" || !Number.isFinite(onlineUsers5m) || onlineUsers5m < 0) {
    return null;
  }

  const online = Math.floor(onlineUsers5m);
  const maxClients = Math.max(1, computeFreeClusterCapacity(freeConfig, cluster));
  const loadRatio = online / maxClients;
  const loadPercent = Math.round(loadRatio * 100);
  const isHighLoad = loadRatio > threshold;
  const isEveningMsk = isEveningPeakMsk(now);
  const upsellMessage = isEveningMsk
    ? "Высокая вечерняя нагрузка на Free — в Pro серверы свободны →"
    : "Высокая нагрузка на Free — в Pro серверы свободны →";

  return {
    online,
    maxClients,
    loadRatio,
    loadPercent,
    isHighLoad,
    isEveningMsk,
    upsellMessage,
  };
}
