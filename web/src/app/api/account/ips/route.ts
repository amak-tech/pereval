import { z } from "zod";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { clientIp, isPublicIPv4 } from "@/lib/ip";
import { addBoundIp } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  kind: z.enum(["static", "ddns_host", "ddns_push"]),
  ip: z.string().trim().max(45).optional(),
  hostname: z.string().trim().max(253).optional(),
  label: z.string().trim().max(60).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await requireUser();
    const input = await readJson(req, schema);
    const ip = clientIp(req.headers);
    await addBoundIp(user.id, input, isPublicIPv4(ip) ? ip : null);
    return json({ ok: true });
  });
}
