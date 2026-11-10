import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { cancelUserSubscription } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await requireUser();
    await cancelUserSubscription(user.id, user.email);
    return json({ ok: true });
  });
}
