import { describe, it, expect } from "vitest";
import { bestSubscription, grantPeriodEnd, parseAdminEmails } from "@/lib/admin";
import { adminActionSchema } from "@/lib/admin-actions";

describe("parseAdminEmails", () => {
  it("объединяет ADMIN_EMAILS и ADMIN_EMAIL, нормализует регистр и пробелы, отбрасывает мусор", () => {
    const set = parseAdminEmails(" Anton@Example.com, ,second@example.com ,not-an-email", "admin@portbuddy.dev");
    expect([...set].sort()).toEqual(["admin@portbuddy.dev", "anton@example.com", "second@example.com"]);
  });
  it("пустые значения → пустой список (никто не админ)", () => {
    expect(parseAdminEmails("", "").size).toBe(0);
  });
});

describe("grantPeriodEnd", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  it("30 дней = календарный месяц от сейчас, если подписки нет или она истекла", () => {
    expect(grantPeriodEnd(null, now, 30).toISOString()).toBe("2026-12-10T12:00:00.000Z");
    expect(grantPeriodEnd(new Date("2026-01-01T00:00:00Z"), now, 30).toISOString()).toBe("2026-12-10T12:00:00.000Z");
  });
  it("продление добавляется к текущему концу периода, если он в будущем", () => {
    const end = new Date("2026-11-20T00:00:00Z");
    expect(grantPeriodEnd(end, now, 30).toISOString()).toBe("2026-12-20T00:00:00.000Z");
    expect(grantPeriodEnd(end, now, 7).toISOString()).toBe("2026-11-27T00:00:00.000Z");
  });
});

describe("bestSubscription", () => {
  const base = { id: "", userId: "u", plan: "pro", provider: "lava", parentContractId: null, offerId: null, currency: null, periodicity: "MONTHLY", startedAt: null, periodEnd: null, cancelledAt: null, lastEventAt: null, createdAt: new Date(0) };
  it("active важнее expired; при равном статусе — более свежая", () => {
    const a = { ...base, id: "a", status: "expired" as const, updatedAt: new Date("2026-05-01") };
    const b = { ...base, id: "b", status: "active" as const, updatedAt: new Date("2026-01-01") };
    const c = { ...base, id: "c", status: "active" as const, updatedAt: new Date("2026-03-01") };
    expect(bestSubscription([a, b, c])?.id).toBe("c");
    expect(bestSubscription([])).toBeNull();
  });
});

describe("adminActionSchema", () => {
  it("принимает известные действия и приводит days к числу", () => {
    const r = adminActionSchema.parse({ action: "user.grant", userId: "u1", days: "30" });
    expect(r).toEqual({ action: "user.grant", userId: "u1", days: 30 });
  });
  it("отклоняет неизвестные действия и выход за границы", () => {
    expect(() => adminActionSchema.parse({ action: "user.delete", userId: "u1" })).toThrow();
    expect(() => adminActionSchema.parse({ action: "user.grant", userId: "u1", days: 0 })).toThrow();
    expect(() => adminActionSchema.parse({ action: "nodes.push", what: "everything" })).toThrow();
  });
});
