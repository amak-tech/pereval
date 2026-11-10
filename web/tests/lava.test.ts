import { beforeEach, describe, expect, it } from "vitest";
import { parseWebhook, verifyWebhookAuth } from "@/lib/lava-webhook";
import { WebhookEnvelope, WebhookFlat, createInvoice, getInvoice, mockMarkPaid, mockReset } from "@/lib/lava";
import { resetEnvCache } from "@/lib/env";

const flat = {
  eventType: "payment.success",
  product: { id: "p1", title: "Перевал Pro" },
  contractId: "c-1",
  parentContractId: null,
  buyer: { email: "user@example.com" },
  amount: 299,
  currency: "RUB",
  status: "subscription-active",
  timestamp: "2026-11-09T10:00:00Z",
  errorMessage: null,
};

const envelope = {
  event_id: "7ea82675-4ded-4133-95a7-a6efbaf165cc",
  event_type: "refund.success",
  created_at: "2026-11-09T10:00:00Z",
  data: { refund_id: "r1", amount: 299, currency: "RUB", customer_email: "user@example.com" },
};

describe("разбор вебхуков lava.top", () => {
  it("плоский формат payment.*/subscription.*", () => {
    expect(WebhookFlat.safeParse(flat).success).toBe(true);
    const ev = parseWebhook(flat);
    expect(ev?.kind).toBe("flat");
    expect(ev?.type).toBe("payment.success");
  });
  it("конверт refund/chargeback", () => {
    expect(WebhookEnvelope.safeParse(envelope).success).toBe(true);
    const ev = parseWebhook(envelope);
    expect(ev?.kind).toBe("envelope");
    expect(ev?.type).toBe("refund.success");
  });
  it("мусор не разбирается", () => {
    expect(parseWebhook({ foo: 1 })).toBeNull();
    expect(parseWebhook("x")).toBeNull();
  });
});

describe("аутентификация вебхука", () => {
  beforeEach(() => {
    process.env.LAVA_WEBHOOK_KEY = "secret-key";
    process.env.LAVA_WEBHOOK_IP_ALLOWLIST = "158.160.60.174";
    process.env.LAVA_WEBHOOK_IP_MODE = "enforce";
    resetEnvCache();
  });
  it("правильный ключ и IP", () => {
    expect(verifyWebhookAuth(new Headers({ "x-api-key": "secret-key" }), "158.160.60.174").ok).toBe(true);
  });
  it("неверный ключ", () => {
    expect(verifyWebhookAuth(new Headers({ "x-api-key": "nope" }), "158.160.60.174").ok).toBe(false);
    expect(verifyWebhookAuth(new Headers(), "158.160.60.174").ok).toBe(false);
  });
  it("чужой IP в режиме enforce отклоняется, в log — пропускается", () => {
    expect(verifyWebhookAuth(new Headers({ "x-api-key": "secret-key" }), "1.2.3.4").ok).toBe(false);
    process.env.LAVA_WEBHOOK_IP_MODE = "log";
    resetEnvCache();
    expect(verifyWebhookAuth(new Headers({ "x-api-key": "secret-key" }), "1.2.3.4").ok).toBe(true);
  });
});

describe("mock-клиент lava.top", () => {
  beforeEach(() => {
    process.env.LAVA_MOCK = "1";
    resetEnvCache();
    mockReset();
  });
  it("создаёт инвойс и помечает оплаченным", async () => {
    const inv = await createInvoice({ email: "a@b.c", offerId: "o", currency: "RUB", periodicity: "MONTHLY", returnUrls: { success: "https://x/pay?ref=1", failure: "https://x/f", cancel: "https://x/c" } });
    expect(inv.paymentUrl).toContain("mock=1");
    expect((await getInvoice(inv.id)).status).toBe("new");
    mockMarkPaid(inv.id);
    const paid = await getInvoice(inv.id);
    expect(paid.subscriptionStatus).toBe("ACTIVE");
    expect(paid.subscriptionDetails?.expiredAt).toBeTruthy();
  });
});

import { describeInvoiceRejection } from "@/lib/lava";

describe("describeInvoiceRejection", () => {
  it("email владельца магазина — понятное объяснение", () => {
    const msg = describeInvoiceRejection('{"error":"Incorrect email to purchase","details":{},"timestamp":"2026-11-10T01:13:40+02:00"}');
    expect(msg).toMatch(/не принимает этот email/);
    expect(msg).toMatch(/другого email/);
  });
  it("прочие ошибки — текст lava.top как есть", () => {
    expect(describeInvoiceRejection('{"error":"Offer not found"}')).toBe("Платёжная система lava.top отклонила запрос: Offer not found");
    expect(describeInvoiceRejection("plain text")).toBe("Платёжная система lava.top отклонила запрос: plain text");
  });
});
