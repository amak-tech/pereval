import { describe, expect, it } from "vitest";
import { accessUntil, addPeriod, dnsMode, firstPeriodEnd, renewedPeriodEnd, shouldExpire } from "@/lib/subscription";

const d = (s: string) => new Date(s);

describe("addPeriod", () => {
  it("MONTHLY добавляет календарный месяц с учётом конца месяца", () => {
    expect(addPeriod(d("2026-01-31T10:00:00Z"), "MONTHLY").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addPeriod(d("2026-03-15T00:00:00Z"), "MONTHLY").toISOString()).toBe("2026-04-15T00:00:00.000Z");
    expect(addPeriod(d("2026-12-05T00:00:00Z"), "MONTHLY").toISOString()).toBe("2027-01-05T00:00:00.000Z");
  });
  it("другие периоды", () => {
    expect(addPeriod(d("2026-01-01T00:00:00Z"), "PERIOD_90_DAYS").toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(addPeriod(d("2026-01-01T00:00:00Z"), "PERIOD_YEAR").toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(addPeriod(d("2026-01-01T00:00:00Z"), "weird").toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("period math без компаундинга grace", () => {
  it("первая оплата", () => {
    expect(firstPeriodEnd(d("2026-11-09T12:00:00Z"), "MONTHLY").toISOString()).toBe("2026-12-09T12:00:00.000Z");
  });
  it("продление до истечения продлевает от конца периода, после — от момента оплаты", () => {
    const prev = d("2026-12-09T12:00:00Z");
    expect(renewedPeriodEnd(prev, d("2026-12-08T00:00:00Z"), "MONTHLY").toISOString()).toBe("2027-01-09T12:00:00.000Z");
    expect(renewedPeriodEnd(prev, d("2026-12-20T00:00:00Z"), "MONTHLY").toISOString()).toBe("2027-01-20T00:00:00.000Z");
    expect(renewedPeriodEnd(null, d("2026-12-20T00:00:00Z"), "MONTHLY").toISOString()).toBe("2027-01-20T00:00:00.000Z");
  });
  it("grace только при past_due", () => {
    const end = d("2026-12-09T12:00:00Z");
    expect(accessUntil("active", end, 3)!.toISOString()).toBe(end.toISOString());
    expect(accessUntil("past_due", end, 3)!.toISOString()).toBe("2026-12-12T12:00:00.000Z");
    expect(accessUntil("cancelled", end, 3)!.toISOString()).toBe(end.toISOString());
    expect(accessUntil("active", null, 3)).toBeNull();
  });
});

describe("dnsMode / shouldExpire", () => {
  const end = d("2026-12-09T12:00:00Z");
  it("активная и отменённая до конца периода — proxy, после — plain (не deny!)", () => {
    expect(dnsMode("active", end, 3, d("2026-12-01T00:00:00Z"))).toBe("proxy");
    expect(dnsMode("cancelled", end, 3, d("2026-12-01T00:00:00Z"))).toBe("proxy");
    expect(dnsMode("active", end, 3, d("2026-12-10T00:00:00Z"))).toBe("plain");
    expect(dnsMode("expired", end, 3, d("2027-06-01T00:00:00Z"))).toBe("plain");
    expect(dnsMode(null, null, 3, new Date())).toBe("plain");
  });
  it("past_due живёт grace дней", () => {
    expect(dnsMode("past_due", end, 3, d("2026-12-11T00:00:00Z"))).toBe("proxy");
    expect(dnsMode("past_due", end, 3, d("2026-12-13T00:00:00Z"))).toBe("plain");
    expect(shouldExpire("past_due", end, 3, d("2026-12-11T00:00:00Z"))).toBe(false);
    expect(shouldExpire("past_due", end, 3, d("2026-12-13T00:00:00Z"))).toBe(true);
    expect(shouldExpire("expired", end, 3, d("2027-01-01T00:00:00Z"))).toBe(false);
  });
});
