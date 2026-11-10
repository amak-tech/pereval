import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireAdmin } from "@/lib/admin-auth";
import { adminActionSchema, runAdminAction } from "@/lib/admin-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Все мутации админ-панели. Проверка Origin + прав, запись в audit_log — внутри runAdminAction. */
export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const admin = await requireAdmin();
    const input = await readJson(req, adminActionSchema);
    const result = await runAdminAction(admin, input);
    return json({ ok: true, ...result });
  });
}
