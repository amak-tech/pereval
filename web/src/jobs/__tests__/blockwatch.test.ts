import { describe, expect, it } from "vitest";
import {
  classifyNodeBlockStatus,
  collectBlockWatchTargets,
  detectPoolTrafficSkew,
  evaluateBlockAlertState,
  formatRuNodesShort,
  parseCheckHostTcpResult,
  probeTcpFromRussia,
  type RuProbeSummary,
  type WorkerTrafficSample,
} from "@/jobs/blockwatch";

describe("parseCheckHostTcpResult", () => {
  const nodes = ["ru1.node.check-host.net", "ru2.node.check-host.net", "ru3.node.check-host.net"];
  const cities = {
    "ru1.node.check-host.net": "Moscow",
    "ru2.node.check-host.net": "Moscow",
    "ru3.node.check-host.net": "Saint Petersburg",
  };

  it("разбирает смесь успешных ответов, таймаутов и null", () => {
    const parsed = parseCheckHostTcpResult(
      {
        "ru1.node.check-host.net": [{ address: "144.31.159.229", time: 0.0412 }],
        "ru2.node.check-host.net": null,
        "ru3.node.check-host.net": [{ error: "Connection timed out" }],
      },
      nodes,
      cities,
      "req-1",
    );
    expect(parsed.requestId).toBe("req-1");
    expect(parsed.ok).toBe(1);
    expect(parsed.responded).toBe(2);
    expect(parsed.total).toBe(3);
    expect(parsed.nodes[0]).toEqual({
      node: "ru1.node.check-host.net",
      city: "Moscow",
      ok: true,
      latencyMs: 41,
      error: null,
    });
    expect(parsed.nodes[1]?.ok).toBeNull();
    expect(parsed.nodes[2]).toEqual({
      node: "ru3.node.check-host.net",
      city: "Saint Petersburg",
      ok: false,
      latencyMs: null,
      error: "Connection timed out",
    });
    expect(formatRuNodesShort(parsed)).toBe("1/2 (Moscow:41ms, Moscow:?, Saint Petersburg:fail)");
  });

  it("фиксирует полную недоступность (0/2)", () => {
    const parsed = parseCheckHostTcpResult(
      {
        "ru1.node.check-host.net": [{ error: "Connection timed out" }],
        "ru2.node.check-host.net": null,
        "ru3.node.check-host.net": [{ error: "Connection timed out" }],
      },
      nodes,
      cities,
      "req-2",
    );
    expect(parsed.ok).toBe(0);
    expect(parsed.responded).toBe(2);
  });
});

describe("probeTcpFromRussia", () => {
  it("выходит из поллинга, как только все узлы ответили", async () => {
    let polls = 0;
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/check-tcp")) {
        return new Response(
          JSON.stringify({
            ok: 1,
            request_id: "abc123",
            nodes: { "ru1.node.check-host.net": [], "ru3.node.check-host.net": [] },
          }),
          { status: 200 },
        );
      }
      polls++;
      return new Response(
        JSON.stringify({
          "ru1.node.check-host.net": [{ address: "1.2.3.4", time: 0.05 }],
          "ru3.node.check-host.net": [{ address: "1.2.3.4", time: 0.08 }],
        }),
        { status: 200 },
      );
    };

    const res = await probeTcpFromRussia(
      "1.2.3.4",
      ["ru1.node.check-host.net", "ru3.node.check-host.net"],
      { "ru1.node.check-host.net": "Moscow", "ru3.node.check-host.net": "SPb" },
      { fetcher: fakeFetch, sleep: async () => {}, pollDelaysMs: [0, 0, 0] },
    );
    expect(polls).toBe(1);
    expect(res.ok).toBe(2);
    expect(res.responded).toBe(2);
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
