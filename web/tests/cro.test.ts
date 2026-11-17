import { describe, expect, it, vi } from "vitest";
import { track } from "@/components/track";
import {
  filterCatalogCategories,
  freeCategories,
  matchesCatalogService,
  normalizeSearchHost,
  proCategories,
} from "@/lib/catalog";
import {
  computeFreeClusterCapacity,
  evaluateFreeClusterLoad,
  isEveningPeakMsk,
  resolveFreeWorkerMaxClients,
  type FreeCapacityConfig,
} from "@/lib/cluster-load";

describe("catalog search across Free and Pro", () => {
  it("находит Notion, Miro, Spotify, Xbox и Brawl Stars в каталоге Pro, когда их нет во Free", () => {
    const free = freeCategories();
    const pro = proCategories();

    for (const query of ["Notion", "Miro", "Spotify", "Xbox", "Brawl Stars", "Coda", "Autodesk", "Semrush"]) {
      const freeHits = filterCatalogCategories(free, query);
      const proHits = filterCatalogCategories(pro, query);
      expect(freeHits).toHaveLength(0);
      expect(proHits.length).toBeGreaterThan(0);
    }
  });

  it("поддерживает поиск по поддоменам и полным URL", () => {
    expect(normalizeSearchHost("https://open.spotify.com/track/123?si=abc")).toBe("open.spotify.com");
    expect(normalizeSearchHost("  APP.MIRO.COM:443/app/board  ")).toBe("app.miro.com");

    const pro = proCategories();
    const spotifyHits = filterCatalogCategories(pro, "https://open.spotify.com/track/123");
    expect(spotifyHits.flatMap((c) => c.services.map((s) => s.name))).toContain("Spotify");

    const miroHits = filterCatalogCategories(pro, "app.miro.com");
    expect(miroHits.flatMap((c) => c.services.map((s) => s.name))).toContain("Miro");

    const claudeService = { name: "Anthropic / Claude", pool: "ai", domains: ["claude.ai", "anthropic.com"] };
    expect(matchesCatalogService(claudeService, "api.anthropic.com")).toBe(true);
    expect(matchesCatalogService(claudeService, "unknown-example.org")).toBe(false);
  });

  it("учитывает выбранную категорию Free и возвращает пустой список при отсутствии совпадений", () => {
    const free = freeCategories();
    const aiOnly = filterCatalogCategories(free, "Claude", "ai");
    const devOnly = filterCatalogCategories(free, "Claude", "dev");

    expect(aiOnly.length).toBeGreaterThan(0);
    expect(devOnly).toHaveLength(0);
    expect(filterCatalogCategories(proCategories(), "definitely-non-existent-service-xyz")).toHaveLength(0);
  });
});

describe("free cluster load & smart Pro upsell", () => {
  const sampleFree: FreeCapacityConfig = {
    max_clients: 300,
    pools: {
      default: { note: "", fallback: null, strict_allowlist: false },
      ai: { note: "", fallback: "default", strict_allowlist: false, max_clients: 200 },
      media: { note: "", fallback: "default", strict_allowlist: false },
    },
    workers: [
      { ip: "151.247.25.123", name: "nl-worker-1", weight: 1, pools: ["default", "media"] },
      { ip: "144.31.159.147", name: "free-worker-ai-1", weight: 1, pools: ["ai"] },
      { ip: "144.31.159.185", name: "free-worker-ai-2", weight: 1, pools: ["ai"] },
    ],
  };

  it("считает ёмкость здоровых узлов и переходит на лимит primary при падении воркеров или fail-open", () => {
    expect(resolveFreeWorkerMaxClients(sampleFree.workers[0]!, sampleFree.pools, sampleFree.max_clients)).toBe(300);
    expect(resolveFreeWorkerMaxClients(sampleFree.workers[1]!, sampleFree.pools, sampleFree.max_clients)).toBe(200);

    // Все 3 воркера в строю: 300 + 200 + 200 = 700
    expect(computeFreeClusterCapacity(sampleFree, null)).toBe(700);

    // Один AI-воркер недоступен: 300 + 200 = 500
    expect(
      computeFreeClusterCapacity(sampleFree, {
        workers: [
          { ip: "151.247.25.123", healthy: true },
          { ip: "144.31.159.147", healthy: true },
          { ip: "144.31.159.185", healthy: false },
        ],
      }),
    ).toBe(500);

    // fail-open или все воркеры недоступны -> лимит primary (300)
    expect(computeFreeClusterCapacity(sampleFree, { fail_open_active: true })).toBe(300);
    expect(
      computeFreeClusterCapacity(sampleFree, {
        workers: sampleFree.workers.map((w) => ({ ip: w.ip, healthy: false })),
      }),
    ).toBe(300);
  });

  it("определяет вечерний пик с 19:00 до 23:00 МСК (16:00–19:59 UTC)", () => {
    expect(isEveningPeakMsk(new Date("2026-11-15T15:59:59Z"))).toBe(false); // 18:59:59 МСК
    expect(isEveningPeakMsk(new Date("2026-11-15T16:00:00Z"))).toBe(true); // 19:00:00 МСК
    expect(isEveningPeakMsk(new Date("2026-11-15T19:59:59Z"))).toBe(true); // 22:59:59 МСК
    expect(isEveningPeakMsk(new Date("2026-11-15T20:00:00Z"))).toBe(false); // 23:00:00 МСК
  });

  it("включает мягкий апсейл строго при превышении 70% от max_clients и подставляет вечерний текст в прайм-тайм", () => {
    const eveningMsk = new Date("2026-11-15T17:30:00Z"); // 20:30 МСК
    const daytimeMsk = new Date("2026-11-15T10:00:00Z"); // 13:00 МСК

    // Ровно 70% (490 / 700 = 0.7) -> апсейл ещё не активен
    const at70 = evaluateFreeClusterLoad({
      onlineUsers5m: 490,
      freeConfig: sampleFree,
      now: eveningMsk,
    });
    expect(at70?.isHighLoad).toBe(false);
    expect(at70?.loadPercent).toBe(70);

    // Свыше 70% вечером (525 / 700 = 75%) -> вечерний апсейл
    const highEvening = evaluateFreeClusterLoad({
      onlineUsers5m: 525,
      freeConfig: sampleFree,
      now: eveningMsk,
    });
    expect(highEvening?.isHighLoad).toBe(true);
    expect(highEvening?.isEveningMsk).toBe(true);
    expect(highEvening?.loadPercent).toBe(75);
    expect(highEvening?.upsellMessage).toBe("Высокая вечерняя нагрузка на Free — в Pro серверы свободны →");

    // Свыше 70% днём -> нейтральный текст без слова «вечерняя»
    const highDay = evaluateFreeClusterLoad({
      onlineUsers5m: 525,
      freeConfig: sampleFree,
      now: daytimeMsk,
    });
    expect(highDay?.isHighLoad).toBe(true);
    expect(highDay?.isEveningMsk).toBe(false);
    expect(highDay?.upsellMessage).toBe("Высокая нагрузка на Free — в Pro серверы свободны →");

    expect(evaluateFreeClusterLoad({ onlineUsers5m: null, freeConfig: sampleFree })).toBeNull();
  });
});

describe("analytics track() with gtag and Yandex.Metrika", () => {
  it("отправляет события одновременно в gtag и Яндекс.Метрику (reachGoal), даже если один из тегов недоступен", () => {
    const gtag = vi.fn();
    const ym = vi.fn();

    vi.stubGlobal("window", { gtag, ym });
    try {
      track("begin_checkout", { currency: "RUB", plan: "pro" });
      expect(gtag).toHaveBeenCalledWith("event", "begin_checkout", { currency: "RUB", plan: "pro" });
      expect(ym).toHaveBeenCalledWith(114262096, "reachGoal", "begin_checkout", { currency: "RUB", plan: "pro" });

      // Если gtag заблокирован/отсутствует, цель всё равно уходит в Яндекс.Метрику с кастомным ID
      ym.mockClear();
      vi.stubGlobal("window", { ym, __YM_COUNTER_ID: 99988877 });
      track("pro_upsell_click", { source: "catalog_search" });
      expect(ym).toHaveBeenCalledWith(99988877, "reachGoal", "pro_upsell_click", { source: "catalog_search" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
