import { describe, expect, it } from "vitest";
import {
  collectMonitoredTargets,
  evaluateNodeAlertState,
  extractOnlineUsers5m,
  resolveNodeMaxClients,
} from "@/jobs/nodewatch";
import { catalog, type PoolInfo } from "@/lib/catalog";

describe("resolveNodeMaxClients", () => {
  const pools: Record<string, PoolInfo> = {
    default: { note: "", fallback: null, strict_allowlist: false },
    ai: { note: "", fallback: "default", strict_allowlist: false, max_clients: 60 },
    media: { note: "", fallback: "default", strict_allowlist: false, max_clients: 120 },
  };

  it("соблюдает приоритет worker -> min(pool) -> cluster -> default", () => {
    expect(resolveNodeMaxClients({ pools: ["ai"], max_clients: 25 }, pools, 150, 200)).toBe(25);
    expect(resolveNodeMaxClients({ pools: ["ai", "media"] }, pools, 150, 200)).toBe(60);
    expect(resolveNodeMaxClients({ pools: ["default"] }, pools, 150, 200)).toBe(150);
    expect(resolveNodeMaxClients({ pools: ["default"] }, pools, null, 200)).toBe(200);
  });
});

describe("extractOnlineUsers5m", () => {
  it("читает online_users_5m или считает ключи recent_5m_users", () => {
    expect(
      extractOnlineUsers5m({
        online_users_5m: 42,
        active_connections: 18,
        recent_5m_users: { a: 1, b: 2 },
      }),
    ).toEqual({ onlineUsers5m: 42, activeConnections: 18 });

    expect(
      extractOnlineUsers5m({
        recent_5m_users: { h1: 100, h2: 101, h3: 102 },
      }),
    ).toEqual({ onlineUsers5m: 3, activeConnections: null });

    expect(extractOnlineUsers5m(null)).toBeNull();
    expect(extractOnlineUsers5m({})).toBeNull();
  });
});

describe("evaluateNodeAlertState", () => {
  const baseNow = new Date("2026-11-12T12:00:00Z");

  it("отправляет алерт при достижении порога, соблюдает кулдаун и сбрасывает состояние при <= 80%", () => {
    // 1. Первое превышение порога -> отправка алерта
    const first = evaluateNodeAlertState(60, 60, null, baseNow, 360);
    expect(first).toEqual({
      overloaded: true,
      shouldSendAlert: true,
      nextAlertedAt: "2026-11-12T12:00:00.000Z",
      cleared: false,
    });

    // 2. Повторная проверка через 30 минут (до истечения кулдауна 360 мин) -> без нового письма
    const duringCooldown = new Date(baseNow.getTime() + 30 * 60_000);
    const second = evaluateNodeAlertState(65, 60, first.nextAlertedAt, duringCooldown, 360);
    expect(second).toEqual({
      overloaded: true,
      shouldSendAlert: false,
      nextAlertedAt: first.nextAlertedAt,
      cleared: false,
    });

    // 3. Снижение нагрузки до 50 (между 80% = 48 и 60) -> не перегружена, но кулдаун ещё сохраняется (гистерезис)
    const slightDrop = evaluateNodeAlertState(50, 60, first.nextAlertedAt, duringCooldown, 360);
    expect(slightDrop).toEqual({
      overloaded: false,
      shouldSendAlert: false,
      nextAlertedAt: first.nextAlertedAt,
      cleared: false,
    });

    // 4. Снижение нагрузки до <= 80% (48 из 60) -> сброс состояния алерта
    const cleared = evaluateNodeAlertState(48, 60, first.nextAlertedAt, duringCooldown, 360);
    expect(cleared).toEqual({
      overloaded: false,
      shouldSendAlert: false,
      nextAlertedAt: null,
      cleared: true,
    });

    // 5. Новый скачок до 60 после сброса -> алерт отправляется сразу
    const spikeAgain = evaluateNodeAlertState(60, 60, cleared.nextAlertedAt, duringCooldown, 360);
    expect(spikeAgain.overloaded).toBe(true);
    expect(spikeAgain.shouldSendAlert).toBe(true);
  });

  it("повторно отправляет алерт после истечения кулдауна, если перегрузка сохраняется", () => {
    const prev = "2026-11-12T05:00:00.000Z";
    const afterCooldown = new Date("2026-11-12T12:00:00.000Z"); // +7 часов при кулдауне 6 часов
    const res = evaluateNodeAlertState(45, 40, prev, afterCooldown, 360);
    expect(res).toEqual({
      overloaded: true,
      shouldSendAlert: true,
      nextAlertedAt: afterCooldown.toISOString(),
      cleared: false,
    });
  });
});

describe("collectMonitoredTargets", () => {
  it("собирает активные воркеры Free и Pro из каталога с их порогами max_clients", () => {
    const defaultMax = 150;
    const targets = collectMonitoredTargets(defaultMax);
    expect(targets.length).toBeGreaterThan(0);
    const freeAi = targets.find((t) => t.tier === "free" && t.pools.includes("ai"));
    const catalogWorker = catalog.free.workers.find((w) => w.pools.includes("ai"));
    expect(freeAi).toBeDefined();
    expect(catalogWorker).toBeDefined();
    expect(freeAi?.maxClients).toBe(
      resolveNodeMaxClients(
        catalogWorker!,
        catalog.free.pools,
        catalog.free.max_clients,
        defaultMax,
      ),
    );
  });
});
