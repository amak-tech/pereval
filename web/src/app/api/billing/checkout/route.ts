import { z } from "zod";
import { assertSameOrigin, emailSchema, fail, handle, json, readJson } from "@/lib/http";
import { clientIp } from "@/lib/ip";
import { allow } from "@/lib/ratelimit";
import { checkout } from "@/lib/billing";
import { hashIpDaily } from "@/lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: emailSchema,
  currency: z.enum(["RUB", "USD"]),
  consent: z.literal(true),
  utm: z.record(z.string(), z.string().max(200)).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const ip = clientIp(req.headers);
    if (!allow(`checkout-ip:${hashIpDaily(ip, "checkout")}`, 10, 15 * 60_000)) {
      return fail(429, "Слишком много попыток. Попробуйте через несколько минут.", "rate_limited");
    }
    const input = await readJson(req, schema);
    if (!allow(`checkout-email:${input.email}`, 5, 15 * 60_000)) {
      return fail(429, "Слишком много попыток для этого email. Попробуйте через несколько минут.", "rate_limited");
    }
    const utm: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.utm ?? {})) {
      if (/^utm_(source|medium|campaign|term|content)$/.test(k)) utm[k] = v;
    }
    const result = await checkout({ email: input.email, currency: input.currency, utm });
    return json({ ok: true, ...result });
  });
}
