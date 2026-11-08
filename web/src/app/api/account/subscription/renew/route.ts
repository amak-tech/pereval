import { z } from "zod";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { checkout } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ currency: z.enum(["RUB", "USD"]) });

export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await requireUser();
    const input = await readJson(req, schema);
    const result = await checkout({ email: user.email, currency: input.currency });
    return json({ ok: true, ...result });
  });
}
