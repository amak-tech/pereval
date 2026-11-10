import { json } from "@/lib/http";
import { clientIp } from "@/lib/ip";
import { processWebhook } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Вебхуки lava.top. Любой 2xx за 10 с считается доставкой, поэтому обработка
 * синхронная, но быстрая (письма уходят в outbox). Повторы дедуплицируются по
 * sha256 сырого тела.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const result = await processWebhook(raw, req.headers, clientIp(req.headers));
    if (!result.ok) return json({ ok: false, error: result.message }, { status: result.status });
    return json({ ok: true, duplicate: result.duplicate ?? false, handled: result.handled ?? null });
  } catch (err) {
    console.error("[lava-webhook] fatal:", err);
    // 500 — lava.top повторит доставку
    return json({ ok: false, error: "internal" }, { status: 500 });
  }
}

export async function GET() {
  return json({ ok: true, hint: "POST only" });
}
