import { fail, handle, json } from "@/lib/http";
import { clientIp } from "@/lib/ip";
import { allow } from "@/lib/ratelimit";
import { invoiceStatusByRef } from "@/lib/billing";
import { hashIpDaily } from "@/lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REF_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  return handle(async () => {
    const { ref } = await ctx.params;
    if (!REF_RE.test(ref)) return fail(400, "Некорректный идентификатор.", "bad_ref");
    const ip = clientIp(req.headers);
    if (!allow(`invoice-poll:${hashIpDaily(ip, "invoice")}`, 120, 5 * 60_000)) return fail(429, "Слишком часто.", "rate_limited");
    const st = await invoiceStatusByRef(ref);
    return json({ ok: true, ...st });
  });
}
