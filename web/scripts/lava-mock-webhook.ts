/**
 * Шлёт тестовый вебхук lava.top на локальный сервер (LAVA_MOCK=1).
 *
 *   pnpm lava:mock payment.success <invoiceId> <email> [amount] [currency]
 *   pnpm lava:mock subscription.recurring.payment.success <contractId> <email> --parent <parentContractId>
 *   pnpm lava:mock subscription.cancelled <contractId> <email> --parent <parentContractId>
 *   pnpm lava:mock refund.success <email> [amount]
 *
 * URL и ключ: WEBHOOK_URL (по умолчанию http://localhost:3000/api/billing/lava/webhook), LAVA_WEBHOOK_KEY.
 */
const url = process.env.WEBHOOK_URL ?? "http://localhost:3000/api/billing/lava/webhook";
const key = process.env.LAVA_WEBHOOK_KEY ?? "dev-webhook-key";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [type, a, b, c, d] = process.argv.slice(2);
  if (!type) {
    console.log("usage: lava-mock-webhook <eventType> ...");
    process.exit(1);
  }
  let body: unknown;
  if (type === "refund.success" || type === "chargeback.initiated") {
    body = {
      event_id: crypto.randomUUID(),
      event_type: type,
      created_at: new Date().toISOString(),
      data: { refund_id: crypto.randomUUID(), refund_type: "full", initiator: "creator", amount: Number(b ?? 299), currency: "RUB", customer_email: a, product: { product_name: "Перевал Pro" } },
    };
  } else {
    body = {
      eventType: type,
      product: { id: process.env.LAVA_PRODUCT_ID_PRO ?? "mock-product", title: "Перевал Pro" },
      contractId: a,
      parentContractId: arg("--parent") ?? null,
      buyer: { email: b },
      amount: Number(c ?? 299),
      currency: d ?? "RUB",
      status: type.endsWith("failed") ? "failed" : "subscription-active",
      timestamp: new Date().toISOString(),
      errorMessage: type.endsWith("failed") ? "Insufficient funds" : null,
    };
  }
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": key }, body: JSON.stringify(body) });
  console.log(res.status, await res.text());
}

void main();
