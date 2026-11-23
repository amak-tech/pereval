import { describe, it, expect } from "vitest";
import { buildPolicyEntry } from "@/lib/policy";
import { availableProRegions, type Catalog } from "@/lib/catalog";

describe("buildPolicyEntry (preferred_region)", () => {
  it("включает preferred_region только при непустом значении", () => {
    const states = new Map([
      ["u-us", { mode: "proxy" as const, disabled: [], preferredRegion: "us" }],
      ["u-auto", { mode: "proxy" as const, disabled: ["media"], preferredRegion: null }],
      ["u-legacy", { mode: "proxy" as const, disabled: [] }],
    ]);
    const admins = new Set<string>();

    const us = buildPolicyEntry("u-us", states, admins);
    expect(us.preferred_region).toBe("us");

    const auto = buildPolicyEntry("u-auto", states, admins);
    expect("preferred_region" in auto).toBe(false);

    const legacy = buildPolicyEntry("u-legacy", states, admins);
    expect("preferred_region" in legacy).toBe(false);
  });
});

describe("availableProRegions", () => {
  it("возвращает регионы из реального каталога Pro с их пулами", () => {
    const regions = availableProRegions();
    const byCode = new Map(regions.map((r) => [r.code, r]));
    expect(byCode.has("eu")).toBe(true);
    expect(byCode.has("us")).toBe(true);
    expect(byCode.get("eu")?.name).toBe("Европа");
    expect(byCode.get("us")?.name).toBe("США");
    expect(byCode.get("us")?.pools).toEqual(["ai"]);
    expect(byCode.get("eu")?.pools).toContain("default");
    expect(byCode.get("eu")?.pools).toContain("ai");
  });

  it("исключает регионы без воркеров и сохраняет порядок пулов", () => {
    const synth: Catalog["pro"] = {
      domain: "pro.test",
      dns_ip: "127.0.0.1",
      doh_url_template: "https://pro.test/dns/{token}",
      dot_host_template: "{token}.pro.test",
      pools: {
        default: { note: "", fallback: null, strict_allowlist: false },
        ai: { note: "", fallback: "default", strict_allowlist: false },
        media: { note: "", fallback: "default", strict_allowlist: false },
      },
      regions: {
        eu: { name: "Европа" },
        us: { name: "США", note: "Только ИИ" },
        jp: { name: "Япония" },
      },
      workers: [
        { ip: "1.1.1.1", name: "w1", weight: 1, pools: ["media", "default"], region: "eu" },
        { ip: "1.1.1.2", name: "w2", weight: 1, pools: ["ai"], region: "us" },
      ],
    };
    expect(availableProRegions(synth)).toEqual([
      { code: "eu", name: "Европа", pools: ["default", "media"] },
      { code: "us", name: "США", note: "Только ИИ", pools: ["ai"] },
    ]);
    expect(availableProRegions(null)).toEqual([]);
  });
});
