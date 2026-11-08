import { z } from "zod";
import { eq } from "drizzle-orm";
import { fail, handle, json, readJson } from "@/lib/http";
import { isMock } from "@/lib/env";
import { db, schema } from "@/lib/db/client";
import * as lava from "@/lib/lava";
import { handleFirstPayment } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Только для LAVA_MOCK=1: помечает mock-инвойс оплаченным и прогоняет обработчик payment.success. */
export async function POST(req: Request) {
  return handle(async () => {
    if (!isMock()) return fail(404, "Not found", "not_found");
    const { ref } = await readJson(req, z.object({ ref: z.string().min(8) }));
    const [inv] = await db().select().from(schema.invoices).where(eq(schema.invoices.ref, ref)).limit(1);
    if (!inv) return fail(404, "invoice not found", "not_found");
    lava.mockMarkPaid(inv.id);
    await handleFirstPayment({
      eventType: "payment.success",
      contractId: inv.id,
      parentContractId: null,
      buyer: { email: inv.email },
      amount: Number(inv.amount ?? 299),
      currency: inv.currency ?? "RUB",
      status: "subscription-active",
      timestamp: new Date().toISOString(),
      product: { id: "mock-product", title: "Перевал Pro" },
    });
    return json({ ok: true });
  });
}
