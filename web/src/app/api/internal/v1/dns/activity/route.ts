import { z } from "zod";
import { eq, sql as dsql } from "drizzle-orm";
import { handle, json, readJson } from "@/lib/http";
import { authenticateNode, recordNodeHealth } from "@/lib/nodes";
import { db, schema } from "@/lib/db/client";
import { recordDynamicAcl } from "@/lib/acl";
import { enqueueAdminMail } from "@/lib/mail";
import { adminAlertMail } from "@/lib/mail-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  node: z.string().max(64).optional(),
  ts: z.number().optional(),
  acl: z.array(z.object({ ip: z.string().max(45), token: z.string().max(32).nullable().optional(), user_id: z.string().max(64).nullable().optional() })).max(5000).default([]),
  activity: z
    .array(
      z.object({
        token: z.string().max(32).nullable().optional(),
        user_id: z.string().max(64).nullable().optional(),
        ip_hash: z.string().max(32),
        queries: z.number().int().min(0),
        first_seen: z.number(),
        last_seen: z.number(),
      }),
    )
    .max(20000)
    .default([]),
  alerts: z.array(z.object({ type: z.string().max(64), token: z.string().max(32).nullable().optional(), user_id: z.string().max(64).nullable().optional(), count: z.number().optional() })).max(100).default([]),
  health: z.unknown().optional(),
});

/** Приём отчётов pro_dns.py: новые IP для ACL, активность токенов, алерты, здоровье. */
export async function POST(req: Request) {
  return handle(async () => {
    const node = await authenticateNode(req);
    const body = await readJson(req, bodySchema);
    const now = new Date();

    // token -> user_id, если нода прислала только токен
    const tokens = new Set<string>();
    for (const a of body.acl) if (a.token && !a.user_id) tokens.add(a.token);
    for (const a of body.activity) if (a.token && !a.user_id) tokens.add(a.token);
    const tokenUser = new Map<string, string>();
    if (tokens.size) {
      const rows = await db().select({ token: schema.accessTokens.token, userId: schema.accessTokens.userId }).from(schema.accessTokens);
      for (const r of rows) if (tokens.has(r.token)) tokenUser.set(r.token, r.userId);
    }
    const userOf = (e: { token?: string | null; user_id?: string | null }) => e.user_id ?? (e.token ? tokenUser.get(e.token) ?? null : null);

    const aclEntries = body.acl.map((a) => ({ ip: a.ip, userId: userOf(a) }));
    const newIps = await recordDynamicAcl(aclEntries, now);

    for (const a of body.activity) {
      const userId = userOf(a);
      if (!userId) continue;
      const day = new Date(a.last_seen * 1000).toISOString().slice(0, 10);
      await db()
        .insert(schema.tokenActivity)
        .values({ userId, day, ipHash: a.ip_hash, firstSeen: new Date(a.first_seen * 1000), lastSeen: new Date(a.last_seen * 1000), queries: a.queries })
        .onConflictDoUpdate({
          target: [schema.tokenActivity.userId, schema.tokenActivity.day, schema.tokenActivity.ipHash],
          set: {
            lastSeen: new Date(a.last_seen * 1000),
            queries: dsql`${schema.tokenActivity.queries} + ${a.queries}`,
          },
        });
    }

    for (const alert of body.alerts) {
      const userId = userOf(alert);
      let email = "?";
      if (userId) {
        const [u] = await db().select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
        email = u?.email ?? userId;
      }
      const t = adminAlertMail(`DNS-алерт ${alert.type}`, `Нода: ${node.name}\nПользователь: ${email}\nТип: ${alert.type}\nЗначение: ${alert.count ?? "-"}`);
      await enqueueAdminMail(t.subject, t.text, t.html);
    }

    if (body.health !== undefined) await recordNodeHealth(node.id, body.health);
    return json({ ok: true, new_ips: newIps });
  });
}
