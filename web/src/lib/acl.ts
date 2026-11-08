import { gt, isNotNull, lte, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { CHANNEL_ACL, notify } from "@/lib/bus";
import { getIntSetting, incrementSetting } from "@/lib/settings";
import { userAccessStates } from "@/lib/policy";

/**
 * ACL для Pro-воркеров: какие IP могут подключаться к портам 80/443.
 * static  — привязанные IP пользователей в режиме proxy;
 * dynamic — IP, с которых недавно приходили аутентифицированные DNS-запросы.
 */
export const ACL_VERSION_KEY = "acl_version";

export type AclSnapshot = {
  version: number;
  static: string[];
  dynamic: { ip: string; expires_at: string }[];
};

export async function aclVersion(): Promise<number> {
  return getIntSetting(ACL_VERSION_KEY, 1);
}

export async function bumpAclVersion(reason: string): Promise<number> {
  const v = await incrementSetting(ACL_VERSION_KEY);
  await notify(CHANNEL_ACL, `${v}:${reason}`);
  return v;
}

export async function buildAclSnapshot(now: Date = new Date()): Promise<AclSnapshot> {
  const version = await aclVersion();
  const states = await userAccessStates(now);
  const bound = await db().select().from(schema.boundIps).where(isNotNull(schema.boundIps.ip));
  const staticIps = new Set<string>();
  for (const b of bound) {
    if (!b.ip) continue;
    if (states.get(b.userId)?.mode === "proxy") staticIps.add(String(b.ip));
  }
  const dyn = await db().select().from(schema.aclDynamic).where(gt(schema.aclDynamic.expiresAt, now));
  return {
    version,
    static: [...staticIps].sort(),
    dynamic: dyn.map((d) => ({ ip: String(d.ip), expires_at: d.expiresAt.toISOString() })).sort((a, b) => a.ip.localeCompare(b.ip)),
  };
}

/**
 * Регистрирует IP, с которых пришли DNS-запросы proxy-пользователей.
 * Новые IP будят long-poll воркеров немедленно; продление TTL версию не меняет.
 */
export async function recordDynamicAcl(entries: { ip: string; userId: string | null }[], now: Date = new Date()): Promise<number> {
  if (entries.length === 0) return 0;
  const ttl = env().ACL_DYNAMIC_TTL_MINUTES * 60_000;
  const expires = new Date(now.getTime() + ttl);
  let inserted = 0;
  for (const e of entries) {
    const rows = await db()
      .insert(schema.aclDynamic)
      .values({ ip: e.ip, userId: e.userId, expiresAt: expires, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.aclDynamic.ip,
        set: { expiresAt: expires, updatedAt: now, userId: e.userId },
      })
      .returning({ inserted: dsql<boolean>`(xmax = 0)` });
    if (rows[0]?.inserted) inserted++;
  }
  if (inserted > 0) await bumpAclVersion(`dynamic+${inserted}`);
  return inserted;
}

/** Удаляет истёкшие динамические записи; при изменениях поднимает версию ACL. */
export async function expireDynamicAcl(now: Date = new Date()): Promise<number> {
  const deleted = await db().delete(schema.aclDynamic).where(lte(schema.aclDynamic.expiresAt, now)).returning({ ip: schema.aclDynamic.ip });
  if (deleted.length > 0) await bumpAclVersion(`expired-${deleted.length}`);
  return deleted.length;
}
