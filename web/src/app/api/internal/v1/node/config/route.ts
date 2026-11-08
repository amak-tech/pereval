import { handle, json } from "@/lib/http";
import { authenticateNode } from "@/lib/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Конфигурация ноды (задел под Dedicated: собственные домены арендатора). */
export async function GET(req: Request) {
  return handle(async () => {
    const node = await authenticateNode(req);
    return json({ version: 1, node: node.name, kind: node.kind, extra_domains: [], tenant: node.tenantUserId ?? null });
  });
}
