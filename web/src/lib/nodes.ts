import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { hashSecret, generateSecret } from "@/lib/crypto";
import { HttpError } from "@/lib/http";
import type { NodeKind } from "@/lib/db/schema";

/** Аутентификация нод data plane по `Authorization: Bearer <secret>`. */
export async function authenticateNode(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m?.[1]) throw new HttpError(401, "Нужен Bearer-секрет ноды.", "unauthorized");
  const hash = hashSecret(m[1]);
  const [node] = await db().select().from(schema.nodes).where(eq(schema.nodes.secretHash, hash)).limit(1);
  if (!node || !node.enabled) throw new HttpError(401, "Неизвестная или отключённая нода.", "unauthorized");
  await db().update(schema.nodes).set({ lastSeenAt: new Date() }).where(eq(schema.nodes.id, node.id));
  return node;
}

/** Регистрирует ноду и возвращает секрет (показывается один раз). */
export async function createNode(name: string, kind: NodeKind, ip: string | null): Promise<{ id: string; secret: string }> {
  const secret = generateSecret(32);
  const [row] = await db()
    .insert(schema.nodes)
    .values({ name, kind, ip, secretHash: hashSecret(secret) })
    .returning({ id: schema.nodes.id });
  return { id: row?.id ?? "", secret };
}

export async function recordNodeHealth(nodeId: string, health: unknown): Promise<void> {
  await db().update(schema.nodes).set({ lastHealth: health as object, lastSeenAt: new Date() }).where(eq(schema.nodes.id, nodeId));
}
