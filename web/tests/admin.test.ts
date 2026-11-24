import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { Mono, Table } from "@/components/admin/ui";
import { bestSubscription, grantPeriodEnd, parseAdminEmails } from "@/lib/admin";
import { adminActionSchema } from "@/lib/admin-actions";
import { buildPolicyEntry } from "@/lib/policy";

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
    const m = adminActionSchema.parse({ action: "settings.node_max_clients", maxClients: "120" });
    expect(m).toEqual({ action: "settings.node_max_clients", maxClients: 120 });
  });
  it("отклоняет неизвестные действия и выход за границы", () => {
    expect(() => adminActionSchema.parse({ action: "user.delete", userId: "u1" })).toThrow();
    expect(() => adminActionSchema.parse({ action: "user.grant", userId: "u1", days: 0 })).toThrow();
    expect(() => adminActionSchema.parse({ action: "nodes.push", what: "everything" })).toThrow();
  });
});

describe("buildPolicyEntry (флаг is_admin для Pro DNS)", () => {
  it("проставляет is_admin: true только администраторам", () => {
    const states = new Map([
      ["u-admin", { mode: "proxy" as const, disabled: [] }],
      ["u-user", { mode: "proxy" as const, disabled: ["media"] }],
    ]);
    const adminIds = new Set(["u-admin"]);

    const adminEntry = buildPolicyEntry("u-admin", states, adminIds);
    expect(adminEntry).toEqual({
      user_id: "u-admin",
      mode: "proxy",
      disabled_categories: [],
      qps_limit: 50,
      is_admin: true,
    });

    const userEntry = buildPolicyEntry("u-user", states, adminIds);
    expect(userEntry).toEqual({
      user_id: "u-user",
      mode: "proxy",
      disabled_categories: ["media"],
      qps_limit: 50,
    });
    expect("is_admin" in userEntry).toBe(false);
  });
});

describe("Table & Mono (мобильная адаптация админ-панели)", () => {
  it("рендерит мобильные подписи колонок, span для заголовка/действий и скрывает пустые ячейки на смартфонах", () => {
    const row1 = createElement(
      "tr",
      { key: "n1" },
      createElement("td", { className: "font-semibold" }, "pro-worker-ai-1"),
      createElement("td", null, "pro_worker"),
      createElement("td", null, createElement(Mono, { nowrap: true }, "153.80.200.170")),
      createElement("td", null, createElement("button", { type: "button" }, "Отключить")),
    );
    const row2 = createElement(
      "tr",
      { key: "n2" },
      createElement("td", null, "primary"),
      createElement("td", null, "free_primary"),
      createElement("td", null, createElement(Mono, { nowrap: true }, "85.209.148.147")),
      createElement("td", null, null),
    );
    const html = renderToStaticMarkup(createElement(Table, { head: ["Нода", "Тип", "IP", ""] }, row1, row2));

    expect(html).toContain(">Нода</span>");
    expect(html).toContain(">Тип</span>");
    expect(html).toContain(">IP</span>");
    expect(html).toContain("md:whitespace-nowrap");
    expect(html).toContain("max-md:col-span-2 max-md:border-b");
    expect(html).toContain("max-md:col-span-2 max-md:border-t");
    expect(html).toContain("max-md:hidden");
  });

  it("показывает текст empty, если строк нет", () => {
    const html = renderToStaticMarkup(createElement(Table, { head: ["Email"], empty: "Никого не найдено." }));
    expect(html).toContain("Никого не найдено.");
    expect(html).not.toContain("<table");
  });
});

