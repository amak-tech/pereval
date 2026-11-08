import { handle, json } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { clientIp, isPublicIPv4 } from "@/lib/ip";
import { accountSummary } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser();
    const ip = clientIp(req.headers);
    const summary = await accountSummary(user.id, user.email, isPublicIPv4(ip) ? ip : null);
    return json({ ok: true, ...summary });
  });
}
