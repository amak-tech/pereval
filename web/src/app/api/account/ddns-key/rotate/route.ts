import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { rotateDdnsKey } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await requireUser();
    const key = await rotateDdnsKey(user.id);
    return json({ ok: true, key, login: user.email });
  });
}
