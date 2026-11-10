import { z } from "zod";
import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { setDisabledCategories } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ disabled: z.array(z.string().max(32)).max(64) });

export async function PUT(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await requireUser();
    const input = await readJson(req, schema);
    const disabled = await setDisabledCategories(user.id, input.disabled);
    return json({ ok: true, disabled });
  });
}
