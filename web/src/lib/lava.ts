import { z } from "zod";
import { env, isMock } from "@/lib/env";

/**
 * Клиент lava.top (https://developers.lava.top, модели — из lava-top-sdk 1.1.1).
 * База https://gate.lava.top, заголовок X-Api-Key. В режиме LAVA_MOCK=1 всё
 * эмулируется локально (для разработки и тестов).
 */

export type Currency = "RUB" | "USD" | "EUR";
export type PaymentMethod = "BANK131" | "UNLIMINT" | "PAYPAL" | "STRIPE";
export type Periodicity = "ONE_TIME" | "MONTHLY" | "PERIOD_90_DAYS" | "PERIOD_180_DAYS" | "PERIOD_YEAR";

export const InvoiceCreateResponse = z.object({
  id: z.string(),
  status: z.string(),
  amountTotal: z.object({ amount: z.number(), currency: z.string() }).optional(),
  paymentUrl: z.string().nullable().optional(),
});
export type InvoiceCreateResponse = z.infer<typeof InvoiceCreateResponse>;

export const InvoiceDetails = z.object({
  id: z.string(),
  type: z.string().optional(),
  datetime: z.string().optional(),
  status: z.string(),
  receipt: z.object({ amount: z.number(), currency: z.string(), fee: z.number().optional() }).optional(),
  buyer: z.object({ email: z.string(), cardMask: z.string().nullable().optional() }).optional(),
  product: z.object({ name: z.string().optional(), offer: z.string().optional() }).optional(),
  parentInvoice: z.object({ id: z.string() }).nullable().optional(),
  subscriptionStatus: z.string().nullable().optional(),
  subscriptionDetails: z
    .object({
      expiredAt: z.string().nullable().optional(),
      terminatedAt: z.string().nullable().optional(),
      cancelledAt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type InvoiceDetails = z.infer<typeof InvoiceDetails>;

export const ProductsResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable().optional(),
      type: z.string().optional(),
      offers: z
        .array(
          z.object({
            id: z.string(),
            name: z.string().nullable().optional(),
            prices: z.array(z.object({ amount: z.number().nullable().optional(), currency: z.string(), periodicity: z.string().nullable().optional() })),
          }),
        )
        .nullable()
        .optional(),
    }),
  ),
  nextPage: z.string().nullable().optional(),
});

/** Плоский формат вебхуков payment.* / subscription.* */
export const WebhookFlat = z.object({
  eventType: z.string(),
  product: z.object({ id: z.string().optional(), title: z.string().optional() }).passthrough().optional(),
  contractId: z.string(),
  parentContractId: z.string().nullable().optional(),
  buyer: z.object({ email: z.string() }).passthrough(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  status: z.string().optional(),
  timestamp: z.string().optional(),
  clientUtm: z.record(z.string(), z.unknown()).nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});
export type WebhookFlat = z.infer<typeof WebhookFlat>;

/** Конверт refund.success / chargeback.initiated */
export const WebhookEnvelope = z.object({
  event_id: z.string(),
  event_type: z.string(),
  created_at: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

/**
 * Человекочитаемое объяснение отказа lava.top при создании счёта (HTTP 400) — для ответа
 * пользователю вместо общего 500. Известные тексты переводим, остальные показываем как есть.
 */
export function describeInvoiceRejection(body: string): string {
  let raw = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    raw = String(parsed.error ?? parsed.message ?? body);
  } catch {
    /* не JSON — оставляем как есть */
  }
  const lower = raw.toLowerCase();
  if (lower.includes("incorrect email")) {
    return "Платёжная система lava.top не принимает этот email для покупки (так бывает с адресом, на который зарегистрирован магазин продавца). Оплатите с другого email или войдите другим способом.";
  }
  return `Платёжная система lava.top отклонила запрос: ${raw.slice(0, 200)}`;
}

export class LavaError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`lava.top HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, query?: Record<string, string>): Promise<T> {
  const e = env();
  if (!e.LAVA_API_KEY) throw new LavaError(0, "LAVA_API_KEY не задан");
  const url = new URL(path, e.LAVA_BASE_URL);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { "X-Api-Key": e.LAVA_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new LavaError(res.status, text);
  if (res.status === 204 || text.trim() === "") return schema.parse({});
  return schema.parse(JSON.parse(text));
}

export type CreateInvoiceInput = {
  email: string;
  offerId: string;
  currency: Currency;
  periodicity: Periodicity;
  paymentMethod?: PaymentMethod;
  buyerLanguage?: "RU" | "EN";
  clientUtm?: Record<string, string>;
  returnUrls?: { success: string; failure: string; cancel: string };
};

// ---------------------------------------------------------------- mock
const mockInvoices = new Map<string, InvoiceDetails>();

export function mockReset(): void {
  mockInvoices.clear();
}

export function mockGetInvoice(id: string): InvoiceDetails | undefined {
  return mockInvoices.get(id);
}

export function mockMarkPaid(id: string, when: Date = new Date()): InvoiceDetails | undefined {
  const inv = mockInvoices.get(id);
  if (!inv) return undefined;
  const upd: InvoiceDetails = {
    ...inv,
    status: "subscription-active",
    subscriptionStatus: "ACTIVE",
    subscriptionDetails: { expiredAt: new Date(when.getTime() + 31 * 86_400_000).toISOString(), terminatedAt: null, cancelledAt: null },
  };
  mockInvoices.set(id, upd);
  return upd;
}

// ---------------------------------------------------------------- API

export async function createInvoice(input: CreateInvoiceInput): Promise<InvoiceCreateResponse> {
  if (isMock()) {
    const id = `mock-${crypto.randomUUID()}`;
    const amount = input.currency === "RUB" ? 299 : 3.99;
    mockInvoices.set(id, {
      id,
      type: "RECURRING",
      datetime: new Date().toISOString(),
      status: "new",
      receipt: { amount, currency: input.currency, fee: 0 },
      buyer: { email: input.email },
      product: { name: "Перевал Pro", offer: input.offerId },
      parentInvoice: null,
      subscriptionStatus: null,
      subscriptionDetails: null,
    });
    const success = input.returnUrls?.success ?? `${env().PUBLIC_ORIGIN}/account/pay`;
    const sep = success.includes("?") ? "&" : "?";
    return { id, status: "new", amountTotal: { amount, currency: input.currency }, paymentUrl: `${success}${sep}mock=1&invoiceId=${id}` };
  }
  const base: Record<string, unknown> = {
    email: input.email,
    offerId: input.offerId,
    currency: input.currency,
    periodicity: input.periodicity,
  };
  if (input.paymentMethod) base.paymentMethod = input.paymentMethod;
  if (input.buyerLanguage) base.buyerLanguage = input.buyerLanguage;
  if (input.clientUtm && Object.keys(input.clientUtm).length) base.clientUtm = input.clientUtm;
  if (input.returnUrls) {
    try {
      return await request("POST", "/api/v2/invoice", InvoiceCreateResponse, {
        ...base,
        successful_return_url: input.returnUrls.success,
        failure_return_url: input.returnUrls.failure,
        cancel_return_url: input.returnUrls.cancel,
      });
    } catch (err) {
      // return-URL для v2 документированы не до конца: при 400 повторяем без них
      if (!(err instanceof LavaError && err.status === 400)) throw err;
      console.warn("[lava] invoice с return-URL отклонён (400), повторяю без них");
    }
  }
  return request("POST", "/api/v2/invoice", InvoiceCreateResponse, base);
}

export async function getInvoice(id: string): Promise<InvoiceDetails> {
  if (isMock()) {
    const inv = mockInvoices.get(id);
    if (!inv) throw new LavaError(404, "mock invoice not found");
    return inv;
  }
  return request("GET", `/api/v1/invoices/${encodeURIComponent(id)}`, InvoiceDetails);
}

export async function cancelSubscription(contractId: string, email: string): Promise<void> {
  if (isMock()) {
    const inv = mockInvoices.get(contractId);
    if (inv) mockInvoices.set(contractId, { ...inv, subscriptionStatus: "CANCELLED", subscriptionDetails: { ...(inv.subscriptionDetails ?? {}), cancelledAt: new Date().toISOString() } });
    return;
  }
  await request("DELETE", "/api/v1/subscriptions", z.object({}).passthrough(), undefined, { contractId, email });
}

export async function getProducts(): Promise<z.infer<typeof ProductsResponse>> {
  if (isMock()) {
    return {
      items: [
        {
          id: env().LAVA_PRODUCT_ID_PRO || "mock-product",
          title: "Перевал Pro",
          type: "SUBSCRIPTION",
          offers: [
            {
              id: env().LAVA_OFFER_ID_PRO || "mock-offer",
              name: "Месяц",
              prices: [
                { amount: 299, currency: "RUB", periodicity: "MONTHLY" },
                { amount: 3.99, currency: "USD", periodicity: "MONTHLY" },
              ],
            },
          ],
        },
      ],
      nextPage: null,
    };
  }
  return request("GET", "/api/v2/products", ProductsResponse, undefined, {
    feedVisibility: "ALL",
    showAllSubscriptionPeriods: "true",
  });
}

export function paymentMethodFor(currency: Currency): PaymentMethod | undefined {
  if (currency === "RUB") return "BANK131";
  return env().LAVA_USD_METHOD;
}

export const WEBHOOK_SOURCE_IPS_DEFAULT = ["158.160.60.174"];
