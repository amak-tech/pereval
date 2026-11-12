import { eq } from "drizzle-orm";
import { catalog, type PoolInfo, type WorkerInfo } from "@/lib/catalog";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { enqueueAdminMail } from "@/lib/mail";
import { adminAlertMail } from "@/lib/mail-templates";
import { getIntSetting, getSetting, setSetting } from "@/lib/settings";

export const NODE_MAX_CLIENTS_SETTING_KEY = "node_max_clients";
export const NODEWATCH_STATUS_KEY = "nodewatch:status";
const ALERT_KEY_PREFIX = "nodewatch:alert:";

export type NodeLoadEntry = {
  ip: string;
  name: string;
  tier: "free" | "pro";
  pools: string[];
  onlineUsers5m: number | null;
  activeConnections: number | null;
  maxClients: number;
  overloaded: boolean;
  reachable: boolean;
  checkedAt: string;
  alertedAt: string | null;
};

export type NodeWatchReport = {
  checkedAt: string;
  defaultMaxClients: number;
  nodes: NodeLoadEntry[];
};

function posInt(val: unknown): number | null {
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  const n = Math.floor(val);
  return n >= 1 ? n : null;
}

/**
 * Вычисляет эффективный порог max_clients для ноды по приоритету:
 * worker.max_clients -> min(pool.max_clients) -> cluster.max_clients -> defaultMaxClients.
 */
export function resolveNodeMaxClients(
  worker: Pick<WorkerInfo, "pools" | "max_clients">,
  pools: Record<string, PoolInfo> | undefined,
  clusterMaxClients: number | null | undefined,
  defaultMaxClients: number,
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

  return posInt(defaultMaxClients) ?? 150;
}

/** Извлекает online_users_5m и active_connections из ответа /node-stats.json. */
export function extractOnlineUsers5m(
  payload: unknown,
): { onlineUsers5m: number; activeConnections: number | null } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  let onlineUsers5m: number | null = null;
  if (typeof obj.online_users_5m === "number" && Number.isFinite(obj.online_users_5m)) {
    onlineUsers5m = Math.max(0, Math.floor(obj.online_users_5m));
  } else if (obj.recent_5m_users && typeof obj.recent_5m_users === "object" && !Array.isArray(obj.recent_5m_users)) {
    onlineUsers5m = Object.keys(obj.recent_5m_users as Record<string, unknown>).length;
  }
  if (onlineUsers5m === null) return null;

  const activeConnections =
    typeof obj.active_connections === "number" && Number.isFinite(obj.active_connections)
      ? Math.max(0, Math.floor(obj.active_connections))
      : null;

  return { onlineUsers5m, activeConnections };
}

/**
 * Определяет статус перегрузки ноды и необходимость отправки алерта с учётом кулдауна и гистерезиса 80%.
 */
export function evaluateNodeAlertState(
  onlineUsers5m: number | null,
  maxClients: number,
  prevAlertedAt: string | null,
  now: Date,
  cooldownMinutes: number,
): {
  overloaded: boolean;
  shouldSendAlert: boolean;
  nextAlertedAt: string | null;
  cleared: boolean;
} {
  const cleanPrev = prevAlertedAt && prevAlertedAt.trim() ? prevAlertedAt.trim() : null;
  if (onlineUsers5m === null) {
    return {
      overloaded: false,
      shouldSendAlert: false,
      nextAlertedAt: cleanPrev,
      cleared: false,
    };
  }

  const limit = Math.max(1, Math.floor(maxClients));
  const overloaded = onlineUsers5m >= limit;
  if (overloaded) {
    const prevTs = cleanPrev ? Date.parse(cleanPrev) : NaN;
    const cooldownMs = Math.max(1, cooldownMinutes) * 60_000;
    const cooldownExpired = !Number.isFinite(prevTs) || now.getTime() - prevTs >= cooldownMs;
    if (cooldownExpired) {
      return {
        overloaded: true,
        shouldSendAlert: true,
        nextAlertedAt: now.toISOString(),
        cleared: false,
      };
    }
    return {
      overloaded: true,
      shouldSendAlert: false,
      nextAlertedAt: cleanPrev,
      cleared: false,
    };
  }

  const releaseThreshold = Math.floor(0.8 * limit);
  if (onlineUsers5m <= releaseThreshold) {
    return {
      overloaded: false,
      shouldSendAlert: false,
      nextAlertedAt: null,
      cleared: Boolean(cleanPrev),
    };
  }

  return {
    overloaded: false,
    shouldSendAlert: false,
    nextAlertedAt: cleanPrev,
    cleared: false,
  };
}

export async function getDefaultNodeMaxClients(): Promise<number> {
  return getIntSetting(NODE_MAX_CLIENTS_SETTING_KEY, env().NODE_MAX_CLIENTS);
}

export async function getNodeWatchStatus(): Promise<NodeWatchReport | null> {
  return getSetting<NodeWatchReport>(NODEWATCH_STATUS_KEY);
}

type MonitoredTarget = {
  ip: string;
  name: string;
  tier: "free" | "pro";
  pools: string[];
  maxClients: number;
};

export function collectMonitoredTargets(defaultMaxClients: number, disabledIps: Set<string> = new Set()): MonitoredTarget[] {
  const targets: MonitoredTarget[] = [];
  const seen = new Set<string>();

  const addWorker = (w: WorkerInfo, tier: "free" | "pro", pools: Record<string, PoolInfo>, clusterMax?: number | null) => {
    const ip = (w.ip ?? "").trim();
    if (!ip || ip.startsWith("203.0.113.") || disabledIps.has(ip) || seen.has(`${tier}:${ip}`)) return;
    seen.add(`${tier}:${ip}`);
    targets.push({
      ip,
      name: w.name || ip,
      tier,
      pools: w.pools?.length ? w.pools : ["default"],
      maxClients: resolveNodeMaxClients(w, pools, clusterMax, defaultMaxClients),
    });
  };

  const freeWorkers = catalog.free.workers ?? [];
  if (freeWorkers.length > 0) {
    for (const w of freeWorkers) {
      addWorker(w, "free", catalog.free.pools, catalog.free.max_clients);
    }
  } else if (catalog.free.dns_ip) {
    addWorker(
      { ip: catalog.free.dns_ip, name: "free-primary", weight: 1, pools: ["default"] },
      "free",
      catalog.free.pools,
      catalog.free.max_clients,
    );
  }

  if (catalog.pro) {
    for (const w of catalog.pro.workers ?? []) {
      if (w.pools?.length === 1 && w.pools[0] === "reserve") continue;
      addWorker(w, "pro", catalog.pro.pools, catalog.pro.max_clients);
    }
  }

  return targets;
}

async function fetchNodeStats(
  ip: string,
  fetcher: typeof fetch,
): Promise<{ reachable: boolean; onlineUsers5m: number | null; activeConnections: number | null }> {
  try {
    const res = await fetcher(`http://${ip}/node-stats.json`, {
      signal: AbortSignal.timeout(3_000),
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { reachable: false, onlineUsers5m: null, activeConnections: null };
    const data: unknown = await res.json();
    const parsed = extractOnlineUsers5m(data);
    if (!parsed) return { reachable: false, onlineUsers5m: null, activeConnections: null };
    return {
      reachable: true,
      onlineUsers5m: parsed.onlineUsers5m,
      activeConnections: parsed.activeConnections,
    };
  } catch {
    return { reachable: false, onlineUsers5m: null, activeConnections: null };
  }
}

export async function checkNodesLoad(
  now: Date = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<{ checked: number; overloaded: number; alerted: string[] }> {
  const defaultMaxClients = await getDefaultNodeMaxClients();
  const cooldownMinutes = env().NODE_ALERT_COOLDOWN_MINUTES;

  const dbNodes = await db().select().from(schema.nodes);
  const disabledIps = new Set<string>();
  const dbNodesByIp = new Map<string, (typeof dbNodes)[number]>();
  for (const n of dbNodes) {
    if (n.ip) {
      dbNodesByIp.set(n.ip, n);
      if (!n.enabled) disabledIps.add(n.ip);
    }
  }

  const targets = collectMonitoredTargets(defaultMaxClients, disabledIps);
  const statsList = await Promise.all(targets.map((t) => fetchNodeStats(t.ip, fetcher)));

  const entries: NodeLoadEntry[] = [];
  const alerted: string[] = [];
  const checkedAt = now.toISOString();

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const st = statsList[i]!;
    const alertKey = `${ALERT_KEY_PREFIX}${target.ip}`;
    const prevAlertedAt = await getSetting<string>(alertKey);

    const decision = evaluateNodeAlertState(
      st.onlineUsers5m,
      target.maxClients,
      prevAlertedAt,
      now,
      cooldownMinutes,
    );

    if (decision.shouldSendAlert && st.onlineUsers5m !== null) {
      const tierLabel = target.tier === "pro" ? "Pro" : "Free";
      const poolsLabel = target.pools.join(", ");
      const mail = adminAlertMail(
        `Нода ${target.name} (${tierLabel}) достигла порога клиентов: ${st.onlineUsers5m} / ${target.maxClients}`,
        [
          `На прокси-воркере ${target.name} (${target.ip}, кластер ${tierLabel}, пулы: ${poolsLabel}) число активных клиентов за последние 5 минут достигло порога:`,
          ``,
          `  • Онлайн-клиентов (5 мин): ${st.onlineUsers5m}`,
          `  • Порог ноды (max_clients): ${target.maxClients}`,
          `  • Активных TCP-соединений: ${st.activeConnections ?? "н/д"}`,
          ``,
          `Чтобы избежать перегрузки и бана IP со стороны целевых сервисов (например, Google Gemini unusual traffic), добавьте новый воркер в пул [${poolsLabel}] в services.yaml и выкатите его через ./deploy.sh.`,
          ``,
          `На уровне DNS новые клиенты сверх порога автоматически перенаправляются на свободные ноды пула/fallback либо в прямой DNS.`,
          `Повторное уведомление по этой ноде не будет отправляться в течение ${cooldownMinutes} мин (или пока нагрузка не опустится до ≤ ${Math.floor(0.8 * target.maxClients)} клиентов).`,
        ].join("\n"),
      );
      await enqueueAdminMail(mail.subject, mail.text, mail.html);
      await setSetting(alertKey, decision.nextAlertedAt);
      alerted.push(target.name);
    } else if (decision.cleared) {
      await setSetting(alertKey, "");
    }

    const entry: NodeLoadEntry = {
      ip: target.ip,
      name: target.name,
      tier: target.tier,
      pools: target.pools,
      onlineUsers5m: st.onlineUsers5m,
      activeConnections: st.activeConnections,
      maxClients: target.maxClients,
      overloaded: decision.overloaded,
      reachable: st.reachable,
      checkedAt,
      alertedAt: decision.nextAlertedAt,
    };
    entries.push(entry);

    const dbNode = dbNodesByIp.get(target.ip);
    if (dbNode && st.reachable) {
      const prevHealth =
        dbNode.lastHealth && typeof dbNode.lastHealth === "object" && !Array.isArray(dbNode.lastHealth)
          ? (dbNode.lastHealth as Record<string, unknown>)
          : {};
      await db()
        .update(schema.nodes)
        .set({
          lastHealth: {
            ...prevHealth,
            online_users_5m: st.onlineUsers5m,
            active_connections: st.activeConnections,
            max_clients: target.maxClients,
            overloaded: decision.overloaded,
            nodewatch_checked_at: checkedAt,
          },
        })
        .where(eq(schema.nodes.id, dbNode.id));
    }
  }

  const report: NodeWatchReport = {
    checkedAt,
    defaultMaxClients,
    nodes: entries,
  };
  await setSetting(NODEWATCH_STATUS_KEY, report);

  return {
    checked: entries.length,
    overloaded: entries.filter((e) => e.overloaded).length,
    alerted,
  };
}
