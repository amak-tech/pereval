import { assertSameOrigin, handle, json } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { removeBoundIp } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await requireUser();
    const { id } = await ctx.params;
    await removeBoundIp(user.id, id);
    return json({ ok: true });
  });
}
