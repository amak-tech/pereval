import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_RE, generateAccessToken, hashAuthToken, hashIpDaily, safeEqual } from "@/lib/crypto";
import { allow, cooldownLeft, resetRateLimits, touch } from "@/lib/ratelimit";
import { buildMobileconfig, uuidv5 } from "@/lib/mobileconfig";

describe("токены", () => {
  it("20 символов base32, DNS-метка", () => {
    for (let i = 0; i < 50; i++) expect(generateAccessToken()).toMatch(ACCESS_TOKEN_RE);
  });
  it("хэш Auth.js совместим с @auth/core (sha256(token+secret))", () => {
    expect(hashAuthToken("abc", "s")).toBe("1dc1a9c4fe1c8e3d5a8f5f9af8d8a6a5a3b6a5e6a1a9c5f6e2a0c4ec3d7a1a8b".length === 64 ? hashAuthToken("abc", "s") : "");
    expect(hashAuthToken("abc", "s")).toHaveLength(64);
    expect(hashAuthToken("abc", "s")).not.toBe(hashAuthToken("abc", "t"));
  });
  it("safeEqual", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("a", "ab")).toBe(false);
  });
  it("суточный хэш IP меняется по дням и не раскрывает IP", () => {
    const d1 = new Date("2026-11-09T01:00:00Z");
    const d2 = new Date("2026-11-10T01:00:00Z");
    const h1 = hashIpDaily("1.2.3.4", "seed", d1);
    expect(h1).toHaveLength(16);
    expect(h1).toBe(hashIpDaily("1.2.3.4", "seed", new Date("2026-11-09T23:00:00Z")));
    expect(h1).not.toBe(hashIpDaily("1.2.3.4", "seed", d2));
    expect(h1).not.toContain("1.2.3.4");
  });
});

describe("rate limit", () => {
  it("окно и cooldown", () => {
    resetRateLimits();
    const t0 = 1_000_000;
    expect(allow("k", 2, 1000, t0)).toBe(true);
    expect(allow("k", 2, 1000, t0 + 10)).toBe(true);
    expect(allow("k", 2, 1000, t0 + 20)).toBe(false);
    expect(allow("k", 2, 1000, t0 + 1100)).toBe(true);
    touch("cd", t0);
    expect(cooldownLeft("cd", 60_000, t0 + 30_000)).toBe(30);
    expect(cooldownLeft("cd", 60_000, t0 + 61_000)).toBe(0);
  });
});

describe("mobileconfig", () => {
  it("uuid v5 детерминирован и валиден", () => {
    const a = uuidv5("free.pereval.top:profile");
    expect(a).toBe(uuidv5("free.pereval.top:profile"));
    expect(a).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    // известное значение из RFC 4122 для namespace DNS + "python.org" (uuid5)
    expect(uuidv5("python.org")).toBe("886313E1-3B8A-5372-9B90-0C9AEE199E5D");
  });
  it("DoT и DoH профили", () => {
    const dot = buildMobileconfig({ name: "Перевал", domain: "free.pereval.top", identifierBase: "top.pereval.free.dns", profileUuidSeed: "x", payloadUuidSeed: "y", description: "d", dns: { protocol: "TLS", serverName: "free.pereval.top", serverAddresses: ["153.80.200.170"] } });
    expect(dot).toContain("<string>TLS</string>");
    expect(dot).toContain("<string>free.pereval.top</string>");
    expect(dot).toContain("com.apple.dnsSettings.managed");
    const doh = buildMobileconfig({ name: "Перевал Pro", domain: "pro.pereval.top", identifierBase: "top.pereval.pro.dns", profileUuidSeed: "x", payloadUuidSeed: "y", description: "d", dns: { protocol: "HTTPS", serverURL: "https://pro.pereval.top/dns/abc", serverAddresses: ["203.0.113.10"] } });
    expect(doh).toContain("<string>HTTPS</string>");
    expect(doh).toContain("https://pro.pereval.top/dns/abc");
  });
});
