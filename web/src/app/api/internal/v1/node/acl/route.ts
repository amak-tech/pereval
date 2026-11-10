import { handle, json } from "@/lib/http";
import { authenticateNode } from "@/lib/nodes";
import { aclVersion, buildAclSnapshot } from "@/lib/acl";
import { CHANNEL_ACL, waitForVersionChange } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Long-poll ACL для pro_node_agent.py: ?version=N&wait=25 → 200 или 304. */
export async function GET(req: Request) {
  return handle(async () => {
    await authenticateNode(req);
    const url = new URL(req.url);
    const known = Number(url.searchParams.get("version") ?? "0") || 0;
    const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? "0") || 0, 0), 25);
    const current = wait > 0 && known > 0 ? await waitForVersionChange(CHANNEL_ACL, known, aclVersion, wait * 1000) : await aclVersion();
    if (known > 0 && current === known) return new Response(null, { status: 304, headers: { "Cache-Control": "no-store" } });
    return json(await buildAclSnapshot());
  });
}
