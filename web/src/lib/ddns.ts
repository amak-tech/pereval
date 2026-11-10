import { Resolver } from "node:dns/promises";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { hashSecret, safeEqual } from "@/lib/crypto";
import { isPublicIPv4 } from "@/lib/ip";
import { bumpPolicyVersion } from "@/lib/policy";
import { bumpAclVersion, recordDynamicAcl } from "@/lib/acl";
import { enqueueMail } from "@/lib/mail";
import { ddnsFailingMail } from "@/lib/mail-templates";

/**
 * DDNS для динамических IP Pro-пользователей:
 *  1) опрос DDNS-имени (DuckDNS, No-IP, Keenetic, MikroTik, ASUS...) раз в минуту;
 *  2) push от роутера по протоколу DynDNS2: GET /nic/update?hostname=...&myip=... с HTTP Basic.
 */

const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

export async function resolveDdnsHostname(hostname: string): Promise<string | null> {
  try {
    const addrs = await resolver.resolve4(hostname);
    const ip = addrs.find((a) => isPublicIPv4(a));
    return ip ?? null;
  } catch {
    return null;
  }
}

/** Применяет новый IP к записи bound_ips; старый IP оставляем в динамическом ACL ещё на TTL. */
export async function applyBoundIpChange(rowId: string, userId: string, oldIp: string | null, newIp: string, now: Date = new Date()): Promise<boolean> {
  if (oldIp === newIp) {
    await db().update(schema.boundIps).set({ lastResolvedAt: now, lastError: null, updatedAt: now }).where(eq(schema.boundIps.id, rowId));
    return false;
  }
  // IP уже привязан к другой записи? — не трогаем
  const [clash] = await db().select({ id: schema.boundIps.id }).from(schema.boundIps).where(eq(schema.boundIps.ip, newIp)).limit(1);
  if (clash && clash.id !== rowId) {
    await db().update(schema.boundIps).set({ lastError: `IP ${newIp} уже привязан к другой записи`, updatedAt: now }).where(eq(schema.boundIps.id, rowId));
    return false;
  }
  await db().update(schema.boundIps).set({ ip: newIp, lastResolvedAt: now, lastError: null, updatedAt: now }).where(eq(schema.boundIps.id, rowId));
  if (oldIp) await recordDynamicAcl([{ ip: oldIp, userId }], now);
  await bumpPolicyVersion("ddns.change");
  await bumpAclVersion("ddns.change");
  return true;
}

/** Планировщик: перерезолвить все ddns_host. */
export async function refreshDdnsHosts(now: Date = new Date()): Promise<{ checked: number; changed: number; failed: number }> {
  const rows = await db()
    .select()
    .from(schema.boundIps)
    .where(and(eq(schema.boundIps.kind, "ddns_host"), isNotNull(schema.boundIps.hostname)));
  let changed = 0;
  let failed = 0;
  for (const row of rows) {
    const ip = await resolveDdnsHostname(row.hostname!);
    if (!ip) {
      failed++;
      const err = "не резолвится";
      const stale = row.lastResolvedAt && now.getTime() - row.lastResolvedAt.getTime() > 86_400_000;
      const alreadyNotified = row.lastError?.includes("[уведомлено]");
      await db()
        .update(schema.boundIps)
        .set({ lastError: stale && !alreadyNotified ? `${err} [уведомлено]` : err, updatedAt: now })
        .where(eq(schema.boundIps.id, row.id));
      if (stale && !alreadyNotified) {
        const [user] = await db().select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
        if (user) {
          const tpl = ddnsFailingMail(row.hostname!, err);
          await enqueueMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
        }
      }
      continue;
    }
    if (await applyBoundIpChange(row.id, row.userId, row.ip ? String(row.ip) : null, ip, now)) changed++;
  }
  return { checked: rows.length, changed, failed };
}

// ---------------------------------------------------------------- DynDNS2

export type DynDnsAuth = { login: string; password: string } | null;

export function parseBasicAuth(header: string | null): DynDnsAuth {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!m?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx <= 0) return null;
  return { login: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

export type DynDnsOutcome = { body: "good" | "nochg" | "badauth" | "abuse" | "nohost" | "911" | "dnserr"; ip?: string; status: number };

/**
 * Обработка DynDNS2-запроса: логин = email (или user id), пароль = DDNS-ключ из кабинета.
 * Обновляется запись kind=ddns_push пользователя (если несколько — все).
 */
export async function handleDynDnsUpdate(auth: DynDnsAuth, myip: string | null, requestIp: string, now: Date = new Date()): Promise<DynDnsOutcome> {
  if (!auth) return { body: "badauth", status: 401 };
  const login = auth.login.trim().toLowerCase();
  const [user] = login.includes("@")
    ? await db().select().from(schema.users).where(eq(schema.users.email, login)).limit(1)
    : await db().select().from(schema.users).where(eq(schema.users.id, login)).limit(1);
  if (!user) return { body: "badauth", status: 401 };
  const [key] = await db().select().from(schema.ddnsKeys).where(eq(schema.ddnsKeys.userId, user.id)).limit(1);
  if (!key || !safeEqual(key.keyHash, hashSecret(auth.password))) return { body: "badauth", status: 401 };
  const ip = (myip ?? "").trim() || requestIp;
  if (!isPublicIPv4(ip)) return { body: "dnserr", status: 400 };
  const rows = await db()
    .select()
    .from(schema.boundIps)
    .where(and(eq(schema.boundIps.userId, user.id), eq(schema.boundIps.kind, "ddns_push")));
  if (!rows.length) return { body: "nohost", status: 404 };
  let changed = false;
  for (const row of rows) {
    if (await applyBoundIpChange(row.id, user.id, row.ip ? String(row.ip) : null, ip, now)) changed = true;
  }
  await db().update(schema.ddnsKeys).set({ lastUsedAt: now }).where(eq(schema.ddnsKeys.userId, user.id));
  return { body: changed ? "good" : "nochg", ip, status: 200 };
}
