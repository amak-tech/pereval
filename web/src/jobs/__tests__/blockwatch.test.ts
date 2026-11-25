import { describe, expect, it } from "vitest";
import {
  classifyNodeBlockStatus,
  collectBlockWatchTargets,
  detectPoolTrafficSkew,
  evaluateBlockAlertState,
  formatRuNodesShort,
  parseGlobalpingHttpResult,
  probeHttpsFromRussia,
  type RuProbeSummary,
  type WorkerTrafficSample,
} from "@/jobs/blockwatch";

describe("parseGlobalpingHttpResult", () => {
  it("разбирает смесь успешных ответов, ошибок и in-progress", () => {
    const parsed = parseGlobalpingHttpResult({
      id: "m-1",
      status: "in-progress",
      results: [
        {
          probe: { city: "Moscow", country: "RU", network: "Timeweb", asn: 9123 },
          result: { status: "finished", statusCode: 200, timings: { tcp: 41.2, total: 120 } },
        },
        {
          probe: { city: "Moscow", country: "RU", network: "Yandex.Cloud", asn: 200350 },
          result: { status: "in-progress" },
        },
        {
          probe: { city: "Saint Petersburg", country: "RU", network: "Selectel", asn: 49505 },
          result: {
            status: "failed",
            rawOutput: "Request timed out while establishing the TCP connection.\n",
          },
        },
      ],
    });
    expect(parsed.requestId).toBe("m-1");
    expect(parsed.ok).toBe(1);
    expect(parsed.responded).toBe(2);
    expect(parsed.total).toBe(3);
    expect(parsed.nodes[0]).toEqual({
      node: "Moscow (Timeweb)",
      city: "Moscow",
      ok: true,
      latencyMs: 41,
      error: null,
    });
    expect(parsed.nodes[1]?.ok).toBeNull();
    expect(parsed.nodes[2]).toEqual({
      node: "Saint Petersburg (Selectel)",
      city: "Saint Petersburg",
      ok: false,
      latencyMs: null,
      error: "Request timed out while establishing the TCP connection.",
    });
    expect(formatRuNodesShort(parsed)).toBe("1/2 (Moscow:41ms, Moscow:?, Saint Petersburg:fail)");
  });

  it("фиксирует полную недоступность (0/2)", () => {
    const parsed = parseGlobalpingHttpResult({
      id: "m-2",
      status: "finished",
      results: [
        {
          probe: { city: "Moscow", country: "RU", network: "Timeweb" },
          result: { status: "failed", rawOutput: "Connection timed out" },
        },
        {
          probe: { city: "Moscow", country: "RU", network: "Selectel" },
          result: { status: "offline" },
        },
        {
          probe: { city: "Saint Petersburg", country: "RU", network: "Miran" },
          result: { status: "failed", rawOutput: "Connection timed out" },
        },
      ],
    });
    expect(parsed.ok).toBe(0);
    expect(parsed.responded).toBe(2);
  });
});

describe("probeHttpsFromRussia", () => {
  it("выходит из поллинга, как только измерение Globalping завершилось", async () => {
    let polls = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/measurements")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "abc123", probesCount: 2 }), { status: 202 });
      }
      polls++;
      return new Response(
        JSON.stringify({
          id: "abc123",
          status: "finished",
          results: [
            {
              probe: { city: "Moscow", country: "RU", network: "Timeweb" },
              result: { status: "finished", statusCode: 200, timings: { tcp: 50, total: 140 } },
            },
            {
              probe: { city: "SPb", country: "RU", network: "Selectel" },
              result: { status: "finished", statusCode: 200, timings: { tcp: 80, total: 180 } },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const res = await probeHttpsFromRussia("1.2.3.4", "free.pereval.top", {
      fetcher: fakeFetch,
      sleep: async () => {},
      pollDelaysMs: [0, 0, 0],
      probeLimit: 2,
    });
    expect(polls).toBe(1);
    expect(res.ok).toBe(2);
    expect(res.responded).toBe(2);
    expect(bodies[0]?.target).toBe("1.2.3.4");
    expect(bodies[0]?.type).toBe("http");
  });

  it("возвращает ошибку при HTTP 429 от Globalping (без ложного blocked)", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { type: "too_many_requests", message: "Too many requests" } }), {
        status: 429,
      });

    const res = await probeHttpsFromRussia("1.2.3.4", "free.pereval.top", {
      fetcher: fakeFetch,
      sleep: async () => {},
    });
    expect(res.responded).toBe(0);
    expect(res.error).toContain("429");
  });
});

describe("detectPoolTrafficSkew", () => {
  it("обнаруживает 1 заблокированную ноду из 4 в пуле (реальный кейс .214 vs .229)", () => {
    const samples: WorkerTrafficSample[] = [
      { ip: "144.31.159.147", tier: "free", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 125 },
      { ip: "144.31.159.185", tier: "free", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 133 },
      { ip: "144.31.159.229", tier: "free", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 101 },
      { ip: "144.31.159.214", tier: "free", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 45 },
    ];
    const skew = detectPoolTrafficSkew(samples);
    expect(skew.get("144.31.159.147")?.skewed).toBe(false);
    expect(skew.get("144.31.159.185")?.skewed).toBe(false);
    expect(skew.get("144.31.159.229")?.skewed).toBe(false);
    expect(skew.get("144.31.159.214")?.skewed).toBe(true);
    expect(skew.get("144.31.159.214")?.ratio).toBeLessThan(0.5);
  });

  it("обнаруживает обе заблокированные ноды, когда заблокированы 2 из 4 в пуле", () => {
    const samples: WorkerTrafficSample[] = [
      { ip: "144.31.159.147", tier: "free", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 135 },
      { ip: "144.31.159.185", tier: "free", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 124 },
      { ip: "151.247.25.209", tier: "free", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 53 },
      { ip: "151.247.25.223", tier: "free", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 34 },
    ];
    const skew = detectPoolTrafficSkew(samples);
    expect(skew.get("144.31.159.147")?.skewed).toBe(false);
    expect(skew.get("144.31.159.185")?.skewed).toBe(false);
    expect(skew.get("151.247.25.209")?.skewed).toBe(true);
    expect(skew.get("151.247.25.223")?.skewed).toBe(true);
  });

  it("не шумит на пулах с маленькой нагрузкой (< 20 клиентов)", () => {
    const samples: WorkerTrafficSample[] = [
      { ip: "141.11.197.214", tier: "pro", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 8 },
      { ip: "45.91.138.24", tier: "pro", pools: ["ai"], weight: 1, reachable: true, onlineUsers5m: 2 },
    ];
    const skew = detectPoolTrafficSkew(samples);
    expect(skew.size).toBe(0);
  });
});

describe("classifyNodeBlockStatus", () => {
  const mkRu = (ok: number, responded: number): RuProbeSummary => ({
    requestId: "r",
    ok,
    responded,
    total: 3,
    nodes: [],
    error: null,
  });

  it("отличает blocked, degraded, ok при прогреве, skewed на Pro и down", () => {
    expect(
      classifyNodeBlockStatus({ cpReachable: false, probeTcp443: true, ruProbe: null, trafficSkew: null }).status,
    ).toBe("down");

    expect(
      classifyNodeBlockStatus({ cpReachable: true, probeTcp443: true, ruProbe: mkRu(0, 2), trafficSkew: null }).status,
    ).toBe("blocked");

    expect(
      classifyNodeBlockStatus({ cpReachable: true, probeTcp443: true, ruProbe: mkRu(1, 2), trafficSkew: null }).status,
    ).toBe("degraded");

    // Прогрев: из РФ открывается (2/2), хотя трафик пока ниже базы -> ok
    expect(
      classifyNodeBlockStatus({
        cpReachable: true,
        probeTcp443: true,
        ruProbe: mkRu(2, 2),
        trafficSkew: { pool: "ai", onlineUsers5m: 40, baseline: 120, ratio: 0.33, skewed: true },
      }).status,
    ).toBe("ok");

    // Pro-воркер (порт 443 закрыт nftables) с перекосом трафика -> skewed
    expect(
      classifyNodeBlockStatus({
        cpReachable: true,
        probeTcp443: false,
        ruProbe: null,
        trafficSkew: { pool: "ai", onlineUsers5m: 20, baseline: 80, ratio: 0.25, skewed: true },
      }).status,
    ).toBe("skewed");
  });
});

describe("evaluateBlockAlertState", () => {
  const t0 = new Date("2026-11-24T12:00:00Z");

  it("шлёт алерт сразу при подтверждённом blocked (>= 2 RU-узлов), соблюдает кулдаун и шлёт recovery", () => {
    const first = evaluateBlockAlertState({
      status: "blocked",
      ruResponded: 2,
      prev: null,
      now: t0,
      cooldownMinutes: 360,
    });
    expect(first.shouldAlert).toBe(true);
    expect(first.recovered).toBe(false);
    expect(first.nextState.lastAlertedAt).toBe(t0.toISOString());

    const t1 = new Date(t0.getTime() + 30 * 60_000);
    const duringCooldown = evaluateBlockAlertState({
      status: "blocked",
      ruResponded: 2,
      prev: first.nextState,
      now: t1,
      cooldownMinutes: 360,
    });
    expect(duringCooldown.shouldAlert).toBe(false);
    expect(duringCooldown.nextState.consecutiveBad).toBe(2);

    const t2 = new Date(t0.getTime() + 60 * 60_000);
    const rec = evaluateBlockAlertState({
      status: "ok",
      ruResponded: 2,
      prev: duringCooldown.nextState,
      now: t2,
      cooldownMinutes: 360,
    });
    expect(rec.shouldAlert).toBe(false);
    expect(rec.recovered).toBe(true);
    expect(rec.nextState).toEqual({ consecutiveBad: 0, lastAlertedAt: null, lastStatus: "ok" });
  });

  it("требует 2 подряд прогона для degraded / skewed и игнорирует unknown", () => {
    const s1 = evaluateBlockAlertState({
      status: "degraded",
      ruResponded: 2,
      prev: null,
      now: t0,
      cooldownMinutes: 360,
    });
    expect(s1.shouldAlert).toBe(false);
    expect(s1.nextState.consecutiveBad).toBe(1);

    // Сбой check-host.net не сбрасывает счётчик
    const unk = evaluateBlockAlertState({
      status: "unknown",
      ruResponded: 0,
      prev: s1.nextState,
      now: new Date(t0.getTime() + 30 * 60_000),
      cooldownMinutes: 360,
    });
    expect(unk.shouldAlert).toBe(false);
    expect(unk.nextState).toEqual(s1.nextState);

    const s2 = evaluateBlockAlertState({
      status: "degraded",
      ruResponded: 2,
      prev: unk.nextState,
      now: new Date(t0.getTime() + 60 * 60_000),
      cooldownMinutes: 360,
    });
    expect(s2.shouldAlert).toBe(true);
    expect(s2.nextState.consecutiveBad).toBe(2);
  });
});

describe("collectBlockWatchTargets", () => {
  it("собирает DNS-ноды и воркеры с правильным флагом probeTcp443", () => {
    const targets = collectBlockWatchTargets();
    expect(targets.some((t) => t.kind === "dns" && t.tier === "free" && t.probeTcp443)).toBe(true);
    expect(targets.some((t) => t.kind === "worker" && t.tier === "free" && t.probeTcp443)).toBe(true);
    const proWorkers = targets.filter((t) => t.kind === "worker" && t.tier === "pro");
    for (const w of proWorkers) {
      expect(w.probeTcp443).toBe(false);
    }
  });
});
