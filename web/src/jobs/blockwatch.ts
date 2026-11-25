import net from "node:net";
import { catalog, type WorkerInfo } from "@/lib/catalog";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { enqueueAdminMail } from "@/lib/mail";
import { adminAlertMail } from "@/lib/mail-templates";
import { getSetting, setSetting } from "@/lib/settings";
import { getNodeWatchStatus, type NodeWatchReport } from "@/jobs/nodewatch";

/**
 * Фоновый мониторинг сетевых блокировок (ТСПУ/РКН) и недоступности нод из РФ.
 *
 * Комбинирует два независимых сигнала:
 *   1. Активные HTTPS :443 пробы (/healthz) из российских узлов Globalping (для DNS-нод и Free-воркеров,
 *      где порт 443 открыт для всех). Все цели проверяются параллельно; при подозрении на полную
 *      блокировку (0/N) выполняется контрольная перепроверка, чтобы исключить разовый сбой.
 *   2. Пассивный анализ перекоса трафика внутри пула (по данным nodewatch /node-stats.json):
 *      если в пуле >= 2 здоровых воркеров с достаточной нагрузкой (baseline >= 20 клиентов),
 *      и у ноды online_users_5m/weight < 50% от среднего по верхней половине пула — это
 *      сигнал блокировки (в том числе для Pro-воркеров, у которых порт 443 закрыт nftables).
 */

export const BLOCKWATCH_STATUS_KEY = "blockwatch:status";
const STATE_KEY_PREFIX = "blockwatch:state:";

export const GLOBALPING_API_BASE = "https://api.globalping.io/v1";
export const DEFAULT_RU_PROBE_LIMIT = 3;

export const SKEW_MIN_BASELINE = 20;
export const SKEW_RATIO_THRESHOLD = 0.5;
export const NODEWATCH_MAX_AGE_MS = 10 * 60_000;

export type BlockNodeKind = "dns" | "worker";
export type BlockStatus = "ok" | "blocked" | "degraded" | "skewed" | "down" | "unknown";

export type BlockWatchTarget = {
  ip: string;
  name: string;
  tier: "free" | "pro";
  kind: BlockNodeKind;
  pools: string[];
  weight: number;
  /** Можно ли проверять HTTPS/TCP :443 извне (у Pro-воркеров порт закрыт nftables). */
  probeTcp443: boolean;
  /** SNI / Host для HTTPS-пробы /healthz на порту 443. */
  probeHost: string;
};

export type RuProbeNodeResult = {
  node: string;
  city: string;
  ok: boolean | null;
  latencyMs: number | null;
  error: string | null;
};

export type RuProbeSummary = {
  requestId: string | null;
  ok: number;
  responded: number;
  total: number;
  nodes: RuProbeNodeResult[];
  error: string | null;
};

export type TrafficSkewInfo = {
  pool: string;
  onlineUsers5m: number;
  baseline: number;
  ratio: number;
  skewed: boolean;
};

export type BlockWatchEntry = {
  ip: string;
  name: string;
  tier: "free" | "pro";
  kind: BlockNodeKind;
  pools: string[];
  probeTcp443: boolean;
  cpReachable: boolean;
  ruProbe: RuProbeSummary | null;
  trafficSkew: TrafficSkewInfo | null;
  status: BlockStatus;
  reason: string;
  consecutiveBad: number;
  checkedAt: string;
  alertedAt: string | null;
};

export type BlockWatchReport = {
  checkedAt: string;
  ruNodes: string[];
  nodes: BlockWatchEntry[];
};

export type NodeBlockState = {
  consecutiveBad: number;
  lastAlertedAt: string | null;
  lastStatus: BlockStatus;
};

type GlobalpingCreateResponse = {
  id?: string;
  probesCount?: number;
  error?: { type?: string; message?: string };
};

export type GlobalpingMeasurementResult = {
  probe?: {
    city?: string;
    country?: string;
    network?: string;
    asn?: number;
  };
  result?: {
    status?: string;
    statusCode?: number;
    rawOutput?: string;
    timings?: {
      total?: number | null;
      tcp?: number | null;
      tls?: number | null;
      firstByte?: number | null;
    };
  };
};

export type GlobalpingMeasurementResponse = {
  id?: string;
  status?: string;
  results?: GlobalpingMeasurementResult[];
  error?: { type?: string; message?: string };
};

export type RuProbeOptions = {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Количество российских проб Globalping на одну цель (по умолчанию 3). */
  probeLimit?: number;
  /** Паузы поллинга результатов Globalping (мс). */
  pollDelaysMs?: number[];
  /** Пауза перед контрольной перепроверкой при 0/N (мс). */
  recheckDelayMs?: number;
  /** Опциональный API-токен Globalping (увеличивает лимит с 250 до 500 проб/ч). */
  token?: string;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- сбор целей

export function collectBlockWatchTargets(disabledIps: Set<string> = new Set()): BlockWatchTarget[] {
  const targets: BlockWatchTarget[] = [];
  const seen = new Set<string>();

  const push = (t: BlockWatchTarget) => {
    const ip = t.ip.trim();
    if (!ip || ip.startsWith("203.0.113.") || disabledIps.has(ip)) return;
    const key = `${t.tier}:${t.kind}:${ip}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ ...t, ip });
  };

  const freeHost = catalog.free.domain || "free.pereval.top";
  const proHost = catalog.pro?.domain || "pro.pereval.top";

  if (catalog.free.dns_ip) {
    push({
      ip: catalog.free.dns_ip,
      name: "free-primary",
      tier: "free",
      kind: "dns",
      pools: ["dns"],
      weight: 1,
      probeTcp443: true,
      probeHost: freeHost,
    });
  }

  for (const w of catalog.free.workers ?? []) {
    push(workerToTarget(w, "free", true, freeHost));
  }

  if (catalog.pro?.dns_ip) {
    push({
      ip: catalog.pro.dns_ip,
      name: "pro-dns",
      tier: "pro",
      kind: "dns",
      pools: ["dns"],
      weight: 1,
      probeTcp443: true,
      probeHost: proHost,
    });
  }

  if (catalog.pro) {
    for (const w of catalog.pro.workers ?? []) {
      if (w.pools?.length === 1 && w.pools[0] === "reserve") continue;
      push(workerToTarget(w, "pro", false, proHost));
    }
  }

  return targets;
}

function workerToTarget(w: WorkerInfo, tier: "free" | "pro", probeTcp443: boolean, probeHost: string): BlockWatchTarget {
  return {
    ip: (w.ip ?? "").trim(),
    name: w.name || w.ip,
    tier,
    kind: "worker",
    pools: w.pools?.length ? w.pools : ["default"],
    weight: typeof w.weight === "number" && w.weight > 0 ? w.weight : 1,
    probeTcp443,
    probeHost,
  };
}

// ---------------------------------------------------------------- пробы с CP

export function probeTcpDirect(ip: string, port = 443, timeoutMs = 4_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    const sock = net.createConnection({ host: ip, port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// ---------------------------------------------------------------- Globalping API

/** Разбирает JSON-ответ GET /v1/measurements/<id> для HTTPS-пробы :443. */
export function parseGlobalpingHttpResult(
  raw: GlobalpingMeasurementResponse | null | undefined,
  expectedTotal = DEFAULT_RU_PROBE_LIMIT,
): RuProbeSummary {
  const list = Array.isArray(raw?.results) ? raw.results : [];
  const results: RuProbeNodeResult[] = [];
  let ok = 0;
  let responded = 0;

  for (const item of list) {
    const city = item.probe?.city?.trim() || "RU";
    const netLabel = item.probe?.network?.trim() || (item.probe?.asn ? `AS${item.probe.asn}` : "");
    const node = netLabel ? `${city} (${netLabel})` : city;
    const st = item.result?.status;

    if (st === "finished") {
      responded++;
      ok++;
      const tcp = item.result?.timings?.tcp;
      const total = item.result?.timings?.total;
      const latencyMs =
        typeof tcp === "number" && Number.isFinite(tcp)
          ? Math.round(tcp)
          : typeof total === "number" && Number.isFinite(total)
            ? Math.round(total)
            : null;
      results.push({ node, city, ok: true, latencyMs, error: null });
    } else if (st === "failed") {
      responded++;
      const firstLine = (item.result?.rawOutput ?? "").split(/\r?\n/)[0]?.trim() || "connection failed";
      results.push({ node, city, ok: false, latencyMs: null, error: firstLine.slice(0, 140) });
    } else {
      results.push({ node, city, ok: null, latencyMs: null, error: null });
    }
  }

  return {
    requestId: raw?.id ?? null,
    ok,
    responded,
    total: results.length > 0 ? results.length : expectedTotal,
    nodes: results,
    error: null,
  };
}

export async function probeHttpsFromRussia(
  ip: string,
  host: string,
  opts: RuProbeOptions = {},
): Promise<RuProbeSummary> {
  const fetcher = opts.fetcher ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const probeLimit = Math.max(1, opts.probeLimit ?? DEFAULT_RU_PROBE_LIMIT);
  const pollDelays = opts.pollDelaysMs ?? [1_500, 1_500, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000];
  const token = (opts.token ?? process.env.GLOBALPING_TOKEN ?? "").trim();

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "pereval-blockwatch/1.0",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let measurementId: string | null = null;
  let expectedCount = probeLimit;
  try {
    const startRes = await fetcher(`${GLOBALPING_API_BASE}/measurements`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { ...headers, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        type: "http",
        target: ip,
        locations: [{ country: "RU", limit: probeLimit }],
        measurementOptions: {
          protocol: "HTTPS",
          port: 443,
          request: {
            host: host || "free.pereval.top",
            path: "/healthz",
            method: "HEAD",
          },
        },
      }),
    });
    if (!startRes.ok) {
      let detail = `Globalping HTTP ${startRes.status}`;
      try {
        const errBody = (await startRes.json()) as GlobalpingCreateResponse;
        if (errBody?.error?.message) detail = `Globalping ${startRes.status}: ${errBody.error.message}`;
      } catch {
        // игнорируем не-JSON тело ошибки
      }
      return { requestId: null, ok: 0, responded: 0, total: probeLimit, nodes: [], error: detail };
    }
    const started = (await startRes.json()) as GlobalpingCreateResponse;
    if (!started.id) {
      return {
        requestId: null,
        ok: 0,
        responded: 0,
        total: probeLimit,
        nodes: [],
        error: started.error?.message || "Globalping не вернул id измерения",
      };
    }
    measurementId = started.id;
    if (typeof started.probesCount === "number" && started.probesCount > 0) {
      expectedCount = started.probesCount;
    }
  } catch (err) {
    return {
      requestId: null,
      ok: 0,
      responded: 0,
      total: probeLimit,
      nodes: [],
      error: (err as Error)?.message || "Globalping request failed",
    };
  }

  let latest: RuProbeSummary = {
    requestId: measurementId,
    ok: 0,
    responded: 0,
    total: expectedCount,
    nodes: [],
    error: null,
  };

  for (const delay of pollDelays) {
    if (delay > 0) await sleep(delay);
    try {
      const pollRes = await fetcher(`${GLOBALPING_API_BASE}/measurements/${encodeURIComponent(measurementId)}`, {
        signal: AbortSignal.timeout(10_000),
        headers,
        cache: "no-store",
      });
      if (!pollRes.ok) continue;
      const raw = (await pollRes.json()) as GlobalpingMeasurementResponse;
      latest = parseGlobalpingHttpResult(raw, expectedCount);
      if (raw.status && raw.status !== "in-progress") break;
      if (latest.responded >= latest.total && latest.total > 0) break;
    } catch {
      // попробуем ещё раз на следующей итерации
    }
  }

  return latest;
}

// ---------------------------------------------------------------- анализ перекоса трафика

export type WorkerTrafficSample = {
  ip: string;
  tier: "free" | "pro";
  pools: string[];
  weight: number;
  reachable: boolean;
  onlineUsers5m: number | null;
};

/**
 * Вычисляет перекос трафика внутри пулов: сравнивает нормированную нагрузку
 * (online_users_5m / weight) каждого воркера со средним по верхней половине здоровых
 * воркеров этого пула (устойчиво даже когда заблокированы 2 из 4 нод).
 */
export function detectPoolTrafficSkew(
  samples: WorkerTrafficSample[],
  minBaseline = SKEW_MIN_BASELINE,
  ratioThreshold = SKEW_RATIO_THRESHOLD,
): Map<string, TrafficSkewInfo> {
  const byPool = new Map<string, WorkerTrafficSample[]>();
  for (const s of samples) {
    if (!s.reachable || s.onlineUsers5m === null) continue;
    for (const pool of s.pools) {
      const key = `${s.tier}:${pool}`;
      const list = byPool.get(key) ?? [];
      list.push(s);
      byPool.set(key, list);
    }
  }

  const worstByIp = new Map<string, TrafficSkewInfo>();
  for (const [poolKey, list] of byPool.entries()) {
    if (list.length < 2) continue;
    const poolName = poolKey.split(":", 2)[1] ?? poolKey;
    const weighted = list.map((s) => ({
      sample: s,
      rate: (s.onlineUsers5m ?? 0) / Math.max(1, s.weight),
    }));
    const sortedRates = weighted.map((x) => x.rate).sort((a, b) => b - a);
    const topCount = Math.max(1, Math.ceil(sortedRates.length / 2));
    const baseline = sortedRates.slice(0, topCount).reduce((sum, v) => sum + v, 0) / topCount;
    if (baseline < minBaseline) continue;

    for (const { sample, rate } of weighted) {
      const ratio = rate / baseline;
      const info: TrafficSkewInfo = {
        pool: poolName,
        onlineUsers5m: sample.onlineUsers5m ?? 0,
        baseline: Math.round(baseline),
        ratio: Number(ratio.toFixed(2)),
        skewed: ratio < ratioThreshold,
      };
      const prev = worstByIp.get(sample.ip);
      if (!prev || info.ratio < prev.ratio) {
        worstByIp.set(sample.ip, info);
      }
    }
  }

  return worstByIp;
}

// ---------------------------------------------------------------- классификация и алерты

export function classifyNodeBlockStatus(input: {
  cpReachable: boolean;
  probeTcp443: boolean;
  ruProbe: RuProbeSummary | null;
  trafficSkew: TrafficSkewInfo | null;
}): { status: BlockStatus; reason: string } {
  if (!input.cpReachable) {
    return { status: "down", reason: "Нода недоступна даже с control plane (TCP :443 / stats)" };
  }

  const ru = input.ruProbe;
  if (input.probeTcp443) {
    if (ru && ru.responded > 0) {
      if (ru.ok === 0) {
        return {
          status: "blocked",
          reason: `HTTPS :443 недоступен из РФ (${ru.ok}/${ru.responded} RU-узлов Globalping)`,
        };
      }
      if (ru.ok < ru.responded) {
        return {
          status: "degraded",
          reason: `Частичная недоступность из РФ (${ru.ok}/${ru.responded} RU-узлов Globalping)`,
        };
      }
      // Из РФ все ответившие узлы достучались
      if (input.trafficSkew?.skewed) {
        return {
          status: "ok",
          reason: `Доступна из РФ (${ru.ok}/${ru.responded}); перекос трафика ${Math.round(input.trafficSkew.ratio * 100)}% (вероятно, прогрев)`,
        };
      }
      return { status: "ok", reason: `Доступна из РФ (${ru.ok}/${ru.responded} RU-узлов)` };
    }

    // Globalping не ответил — опираемся на пассивный перекос трафика
    if (input.trafficSkew?.skewed) {
      return {
        status: "skewed",
        reason: `Перекос трафика в пуле ${input.trafficSkew.pool}: ${input.trafficSkew.onlineUsers5m} клиентов против базы ${input.trafficSkew.baseline} (${Math.round(input.trafficSkew.ratio * 100)}%); Globalping не ответил`,
      };
    }
    return {
      status: "unknown",
      reason: ru?.error ? `Globalping: ${ru.error}` : "RU-узлы Globalping не вернули ответ",
    };
  }

  // Pro-воркеры (порт 443 закрыт nftables): ориентируемся на перекос трафика в пуле
  if (input.trafficSkew?.skewed) {
    return {
      status: "skewed",
      reason: `Перекос трафика в пуле ${input.trafficSkew.pool}: ${input.trafficSkew.onlineUsers5m} клиентов против базы ${input.trafficSkew.baseline} (${Math.round(input.trafficSkew.ratio * 100)}%)`,
    };
  }
  return {
    status: "ok",
    reason: input.trafficSkew
      ? `Нагрузка в норме (${input.trafficSkew.onlineUsers5m} / база ${input.trafficSkew.baseline})`
      : "Доступна с CP (порт 443 закрыт nftables, недостаточно трафика для сравнения в пуле)",
  };
}

export function evaluateBlockAlertState(input: {
  status: BlockStatus;
  ruResponded: number;
  prev: NodeBlockState | null;
  now: Date;
  cooldownMinutes: number;
}): {
  shouldAlert: boolean;
  recovered: boolean;
  nextState: NodeBlockState;
} {
  const prev = input.prev ?? { consecutiveBad: 0, lastAlertedAt: null, lastStatus: "ok" as BlockStatus };

  if (input.status === "ok") {
    const recovered = Boolean(prev.lastAlertedAt);
    return {
      shouldAlert: false,
      recovered,
      nextState: { consecutiveBad: 0, lastAlertedAt: null, lastStatus: "ok" },
    };
  }

  if (input.status === "unknown") {
    // Не сбрасываем и не наращиваем счётчик, чтобы сбой check-host.net не ломал состояние
    return {
      shouldAlert: false,
      recovered: false,
      nextState: prev,
    };
  }

  const consecutiveBad = prev.consecutiveBad + 1;
  // Подтверждённая полная блокировка (>= 2 RU-узлов дали 0/N) — алертим сразу;
  // частичная деградация, перекос трафика или падение с CP — после 2 подряд проверок.
  const thresholdReached =
    (input.status === "blocked" && input.ruResponded >= 2) || consecutiveBad >= 2;

  const prevTs = prev.lastAlertedAt ? Date.parse(prev.lastAlertedAt) : NaN;
  const cooldownMs = Math.max(1, input.cooldownMinutes) * 60_000;
  const cooldownExpired = !Number.isFinite(prevTs) || input.now.getTime() - prevTs >= cooldownMs;

  if (thresholdReached && cooldownExpired) {
    return {
      shouldAlert: true,
      recovered: false,
      nextState: {
        consecutiveBad,
        lastAlertedAt: input.now.toISOString(),
        lastStatus: input.status,
      },
    };
  }

  return {
    shouldAlert: false,
    recovered: false,
    nextState: {
      consecutiveBad,
      lastAlertedAt: prev.lastAlertedAt,
      lastStatus: input.status,
    },
  };
}

// ---------------------------------------------------------------- форматирование

export function formatRuNodesShort(ru: RuProbeSummary | null): string {
  if (!ru) return "—";
  if (ru.error && ru.responded === 0) return `ошибка (${ru.error})`;
  if (ru.nodes.length === 0) return `${ru.ok}/${ru.responded}`;
  const parts = ru.nodes.map((n) => {
    const label = n.city || n.node.split(".")[0];
    if (n.ok === true) return `${label}:${n.latencyMs !== null ? `${n.latencyMs}ms` : "ok"}`;
    if (n.ok === false) return `${label}:fail`;
    return `${label}:?`;
  });
  return `${ru.ok}/${ru.responded} (${parts.join(", ")})`;
}

export function formatBlockWatchLine(e: BlockWatchEntry): string {
  const statusTag =
    e.status === "ok"
      ? "OK      "
      : e.status === "blocked"
        ? "BLOCKED "
        : e.status === "degraded"
          ? "DEGRADED"
          : e.status === "skewed"
            ? "SKEWED  "
            : e.status === "down"
              ? "DOWN    "
              : "UNKNOWN ";
  const ruStr = e.probeTcp443 ? `RU=${formatRuNodesShort(e.ruProbe)}` : "RU=n/a(nft)";
  const skewStr = e.trafficSkew
    ? ` skew=${e.trafficSkew.onlineUsers5m}/${e.trafficSkew.baseline}(${Math.round(e.trafficSkew.ratio * 100)}%)`
    : "";
  return `[${statusTag}] ${e.name.padEnd(22)} ${e.ip.padEnd(16)} (${e.tier}/${e.pools.join(",")})  cp=${e.cpReachable ? "up" : "down"}  ${ruStr}${skewStr}`;
}

// ---------------------------------------------------------------- хранение и основной прогон

export async function getBlockWatchStatus(): Promise<BlockWatchReport | null> {
  return getSetting<BlockWatchReport>(BLOCKWATCH_STATUS_KEY);
}

function getFreshNodeWatchMap(report: NodeWatchReport | null, now: Date): Map<string, { reachable: boolean; onlineUsers5m: number | null }> {
  const map = new Map<string, { reachable: boolean; onlineUsers5m: number | null }>();
  if (!report?.checkedAt) return map;
  const age = now.getTime() - Date.parse(report.checkedAt);
  if (!Number.isFinite(age) || age > NODEWATCH_MAX_AGE_MS) return map;
  for (const n of report.nodes ?? []) {
    map.set(n.ip, { reachable: n.reachable, onlineUsers5m: n.onlineUsers5m });
  }
  return map;
}

export async function checkNodesBlocking(
  now: Date = new Date(),
  opts: RuProbeOptions = {},
): Promise<{
  checked: number;
  blocked: number;
  degraded: number;
  skewed: number;
  down: number;
  alerted: string[];
  recovered: string[];
}> {
  const sleep = opts.sleep ?? defaultSleep;
  const recheckDelayMs = opts.recheckDelayMs ?? 3_000;
  const cooldownMinutes = env().BLOCK_ALERT_COOLDOWN_MINUTES;
  const probeOpts: RuProbeOptions = {
    ...opts,
    token: opts.token ?? env().GLOBALPING_TOKEN,
  };

  const [dbNodes, nodewatch] = await Promise.all([
    db().select().from(schema.nodes),
    getNodeWatchStatus().catch(() => null),
  ]);

  const disabledIps = new Set<string>();
  for (const n of dbNodes) {
    if (n.ip && !n.enabled) disabledIps.add(n.ip);
  }

  const targets = collectBlockWatchTargets(disabledIps);
  const nwMap = getFreshNodeWatchMap(nodewatch, now);

  // 1. Проверяем доступность с CP (из свежего nodewatch для воркеров или прямым TCP :443)
  const cpReachableList = await Promise.all(
    targets.map(async (t) => {
      const cached = nwMap.get(t.ip);
      if (cached && cached.reachable) return true;
      return probeTcpDirect(t.ip, 443, 4_000);
    }),
  );

  // 2. Считаем пассивный перекос трафика по пулам (из свежего nodewatch)
  const workerSamples: WorkerTrafficSample[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (t.kind !== "worker") continue;
    const cached = nwMap.get(t.ip);
    workerSamples.push({
      ip: t.ip,
      tier: t.tier,
      pools: t.pools,
      weight: t.weight,
      reachable: cached ? cached.reachable : cpReachableList[i]!,
      onlineUsers5m: cached?.onlineUsers5m ?? null,
    });
  }
  const skewMap = detectPoolTrafficSkew(workerSamples);

  // 3. Параллельно проверяем все открытые цели из РФ через Globalping
  const ruProbes: Array<RuProbeSummary | null> = await Promise.all(
    targets.map(async (t, i) => {
      if (!t.probeTcp443 || !cpReachableList[i]) return null;
      return probeHttpsFromRussia(t.ip, t.probeHost, probeOpts);
    }),
  );

  // Контрольная перепроверка для целей с 0/N (тоже параллельно), чтобы исключить разовый сбой
  const recheckIdx: number[] = [];
  for (let i = 0; i < ruProbes.length; i++) {
    const p = ruProbes[i];
    if (p && p.responded > 0 && p.ok === 0) recheckIdx.push(i);
  }
  if (recheckIdx.length > 0) {
    if (recheckDelayMs > 0) await sleep(recheckDelayMs);
    await Promise.all(
      recheckIdx.map(async (i) => {
        const t = targets[i]!;
        const recheck = await probeHttpsFromRussia(t.ip, t.probeHost, probeOpts);
        if (recheck.responded > 0) {
          ruProbes[i] = recheck;
        }
      }),
    );
  }

  const ruNodeSet = new Set<string>();
  for (const p of ruProbes) {
    for (const n of p?.nodes ?? []) ruNodeSet.add(n.node);
  }
  const ruNodes = [...ruNodeSet].sort();

  const checkedAt = now.toISOString();
  const entries: BlockWatchEntry[] = [];
  const toAlert: BlockWatchEntry[] = [];
  const recoveredEntries: BlockWatchEntry[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const cpReachable = cpReachableList[i]!;
    const trafficSkew = skewMap.get(t.ip) ?? null;
    const ruProbe = ruProbes[i] ?? null;

    const { status, reason } = classifyNodeBlockStatus({
      cpReachable,
      probeTcp443: t.probeTcp443,
      ruProbe,
      trafficSkew,
    });

    const stateKey = `${STATE_KEY_PREFIX}${t.ip}`;
    const prevState = await getSetting<NodeBlockState>(stateKey);
    const decision = evaluateBlockAlertState({
      status,
      ruResponded: ruProbe?.responded ?? 0,
      prev: prevState,
      now,
      cooldownMinutes,
    });

    await setSetting(stateKey, decision.nextState);

    const entry: BlockWatchEntry = {
      ip: t.ip,
      name: t.name,
      tier: t.tier,
      kind: t.kind,
      pools: t.pools,
      probeTcp443: t.probeTcp443,
      cpReachable,
      ruProbe,
      trafficSkew,
      status,
      reason,
      consecutiveBad: decision.nextState.consecutiveBad,
      checkedAt,
      alertedAt: decision.nextState.lastAlertedAt,
    };
    entries.push(entry);

    if (decision.shouldAlert) toAlert.push(entry);
    if (decision.recovered) recoveredEntries.push(entry);
  }

  // 4. Отправляем сводный алерт по новым проблемным нодам
  if (toAlert.length > 0) {
    const names = toAlert.map((e) => `${e.name} (${e.ip})`).join(", ");
    const lines = [
      `Обнаружены проблемы с доступностью нод из РФ / возможная блокировка IP (${checkedAt}):`,
      ``,
      ...toAlert.flatMap((e) => [
        `• ${e.name} (${e.ip}) — [${e.status.toUpperCase()}]`,
        `  Кластер: ${e.tier === "pro" ? "Pro" : "Free"} · роль: ${e.kind} · пулы: ${e.pools.join(", ")}`,
        `  Причина: ${e.reason}`,
        e.probeTcp443 ? `  RU-пробы (HTTPS :443): ${formatRuNodesShort(e.ruProbe)}` : `  RU-пробы: порт 443 закрыт nftables (оценка по перекосу трафика)`,
        e.trafficSkew ? `  Трафик пула ${e.trafficSkew.pool}: ${e.trafficSkew.onlineUsers5m} клиентов против базы ${e.trafficSkew.baseline} (${Math.round(e.trafficSkew.ratio * 100)}%)` : "",
        ``,
      ]).filter((l, idx, arr) => l !== "" || (idx > 0 && arr[idx - 1] !== "")),
      `Что делать:`,
      `  1. Перепроверить ноду: pnpm admin blockwatch check ${toAlert.map((e) => e.ip).join(" ")}`,
      `  2. Если IP фильтруется в РФ — заменить воркер в services.yaml (новый IP предварительно проверить той же командой) и выкатить через ./deploy.sh.`,
      ``,
      `Повторное уведомление по этим нодам не будет отправляться в течение ${cooldownMinutes} мин (или до восстановления).`,
    ];
    const mail = adminAlertMail(`Блокировка/недоступность нод из РФ: ${names}`, lines.join("\n"));
    await enqueueAdminMail(mail.subject, mail.text, mail.html);
  }

  // 5. Уведомление о восстановлении (только если ранее уходил алерт)
  if (recoveredEntries.length > 0) {
    const names = recoveredEntries.map((e) => `${e.name} (${e.ip})`).join(", ");
    const lines = [
      `Ноды снова доступны из РФ (${checkedAt}):`,
      ``,
      ...recoveredEntries.map((e) => `• ${e.name} (${e.ip}) — ${e.reason}`),
    ];
    const mail = adminAlertMail(`Восстановилась доступность нод: ${names}`, lines.join("\n"));
    await enqueueAdminMail(mail.subject.replace("⚠️ ", "✅ "), mail.text, mail.html);
  }

  const report: BlockWatchReport = {
    checkedAt,
    ruNodes,
    nodes: entries,
  };
  await setSetting(BLOCKWATCH_STATUS_KEY, report);

  return {
    checked: entries.length,
    blocked: entries.filter((e) => e.status === "blocked").length,
    degraded: entries.filter((e) => e.status === "degraded").length,
    skewed: entries.filter((e) => e.status === "skewed").length,
    down: entries.filter((e) => e.status === "down").length,
    alerted: toAlert.map((e) => e.name),
    recovered: recoveredEntries.map((e) => e.name),
  };
}

/**
 * Разовая проверка произвольных IP (например, кандидатов перед добавлением в services.yaml).
 * Не требует БД и не меняет сохранённое состояние blockwatch.
 */
export async function probeAdhocIps(
  ips: string[],
  opts: RuProbeOptions = {},
): Promise<BlockWatchEntry[]> {
  const checkedAt = new Date().toISOString();
  const probeHost = catalog.free.domain || "free.pereval.top";
  const cleanIps = ips.map((x) => x.trim()).filter(Boolean);

  return Promise.all(
    cleanIps.map(async (ip) => {
      const [cpReachable, ruProbe] = await Promise.all([
        probeTcpDirect(ip, 443, 4_000),
        probeHttpsFromRussia(ip, probeHost, opts),
      ]);
      const { status, reason } = classifyNodeBlockStatus({
        cpReachable,
        probeTcp443: true,
        ruProbe,
        trafficSkew: null,
      });
      return {
        ip,
        name: ip,
        tier: "free" as const,
        kind: "worker" as const,
        pools: ["adhoc"],
        probeTcp443: true,
        cpReachable,
        ruProbe,
        trafficSkew: null,
        status,
        reason,
        consecutiveBad: status === "ok" || status === "unknown" ? 0 : 1,
        checkedAt,
        alertedAt: null,
      };
    }),
  );
}
