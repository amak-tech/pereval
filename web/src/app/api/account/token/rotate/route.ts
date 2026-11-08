import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { rotateToken } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await requireUser();
    const token = await rotateToken(user.id);
    return json({ ok: true, token });
  });
}
