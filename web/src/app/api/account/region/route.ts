import { z } from "zod";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { setPreferredRegion } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ region: z.string().trim().min(2).max(24).nullable() });

export async function PUT(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await requireUser();
    const input = await readJson(req, schema);
    const region = await setPreferredRegion(user.id, input.region);
    return json({ ok: true, region });
  });
}
