import { handle, json, HttpError } from "@/lib/http";
import { requireAdmin } from "@/lib/admin-auth";
import { buildPolicySnapshot } from "@/lib/policy";
import { buildAclSnapshot } from "@/lib/acl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Снапшот политики/ACL в том виде, в каком его получают ноды: ?kind=policy|acl. */
export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin();
    const kind = new URL(req.url).searchParams.get("kind");
    if (kind === "policy") return json(await buildPolicySnapshot());
    if (kind === "acl") return json(await buildAclSnapshot());
    throw new HttpError(400, "kind=policy|acl", "bad_kind");
  });
}
