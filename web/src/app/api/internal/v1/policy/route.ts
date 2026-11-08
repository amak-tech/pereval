import { handle, json } from "@/lib/http";
import { authenticateNode } from "@/lib/nodes";
import { buildPolicySnapshot, policyVersion } from "@/lib/policy";
import { CHANNEL_POLICY, waitForVersionChange } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Long-poll политики DNS для pro_dns.py: ?version=N&wait=25 → 200 с новой версией или 304. */
export async function GET(req: Request) {
  return handle(async () => {
    await authenticateNode(req);
    const url = new URL(req.url);
    const known = Number(url.searchParams.get("version") ?? "0") || 0;
    const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? "0") || 0, 0), 25);
    const current = wait > 0 && known > 0 ? await waitForVersionChange(CHANNEL_POLICY, known, policyVersion, wait * 1000) : await policyVersion();
    if (known > 0 && current === known) return new Response(null, { status: 304, headers: { "Cache-Control": "no-store" } });
    const snapshot = await buildPolicySnapshot();
    return json(snapshot);
  });
}
