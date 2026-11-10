import { and, desc, eq, gt, isNull, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { catalog, allCategoryIds } from "@/lib/catalog";
import { accessUntil, dnsMode } from "@/lib/subscription";
import { bumpPolicyVersion } from "@/lib/policy";
import { bumpAclVersion } from "@/lib/acl";
import { ensureAccessToken } from "@/lib/billing";
import { generateAccessToken, generateSecret, hashSecret } from "@/lib/crypto";
import { isPublicIPv4 } from "@/lib/ip";
import { resolveDdnsHostname } from "@/lib/ddns";

/** Личный кабинет: сводка и мутации (токен, IP/DDNS, категории). */

export type AccountSummary = {
  email: string;
  subscription: {
    status: string | null;
    accessUntil: string | null;
    periodEnd: string | null;
    currency: string | null;
    cancelledAt: string | null;
    canCancel: boolean;
    canRenew: boolean;
    mode: "proxy" | "plain" | "deny";
  };
  token: string | null;
  previousToken: { token: string; validUntil: string } | null;
  dns: { dohUrl: string | null; dotHost: string | null; dnsIp: string; proDomain: string };
  boundIps: { id: string; kind: string; ip: string | null; hostname: string | null; label: string; lastResolvedAt: string | null; lastError: string | null }[];
  maxBoundIps: number;
  detectedIp: string | null;
  lastDnsIpHash: string | null;
  ddns: { login: string; hasKey: boolean; updateUrl: string };
  categories: { id: string; name: string; tier: string; pool: string; enabled: boolean; serviceCount: number }[];
  activity: { devices24h: number; queries24h: number; lastSeen: string | null };
};

export async function accountSummary(userId: string, email: string, detectedIp: string | null): Promise<AccountSummary> {
  const e = env();
  const now = new Date();
  const subs = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId)).orderBy(desc(schema.subscriptions.updatedAt));
  const rank: Record<string, number> = { active: 5, past_due: 4, cancelled: 3, pending: 2, expired: 1 };
  const sub = subs.sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0))[0] ?? null;
  const mode = dnsMode(sub?.status ?? null, sub?.periodEnd ?? null, e.GRACE_DAYS, now);
  const until = sub ? accessUntil(sub.status, sub.periodEnd, e.GRACE_DAYS) : null;

  const tokens = await db().select().from(schema.accessTokens).where(eq(schema.accessTokens.userId, userId)).orderBy(desc(schema.accessTokens.createdAt));
  const active = tokens.find((t) => !t.revokedAt) ?? null;
  const graceCut = new Date(now.getTime() - e.TOKEN_ROTATION_GRACE_HOURS * 3_600_000);
  const prev = tokens.find((t) => t.revokedAt && t.revokedAt.getTime() > graceCut.getTime()) ?? null;

  const ips = await db().select().from(schema.boundIps).where(eq(schema.boundIps.userId, userId)).orderBy(schema.boundIps.createdAt);
  const [policy] = await db().select().from(schema.userPolicy).where(eq(schema.userPolicy.userId, userId)).limit(1);
  const disabled = new Set(policy?.disabledCategories ?? []);
  const [ddnsKey] = await db().select().from(schema.ddnsKeys).where(eq(schema.ddnsKeys.userId, userId)).limit(1);

  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [act] = await db()
    .select({
      devices: dsql<number>`count(distinct ${schema.tokenActivity.ipHash})::int`,
      queries: dsql<number>`coalesce(sum(${schema.tokenActivity.queries}),0)::int`,
      last: dsql<Date | null>`max(${schema.tokenActivity.lastSeen})`,
    })
    .from(schema.tokenActivity)
    .where(and(eq(schema.tokenActivity.userId, userId), gt(schema.tokenActivity.lastSeen, dayAgo)));

  const proDomain = catalog.pro?.domain ?? e.PRO_DOMAIN;
  const dnsIp = catalog.pro?.dns_ip ?? e.PRO_DNS_IP;
  return {
    email,
    subscription: {
      status: sub?.status ?? null,
      accessUntil: until?.toISOString() ?? null,
      periodEnd: sub?.periodEnd?.toISOString() ?? null,
      currency: sub?.currency ?? null,
      cancelledAt: sub?.cancelledAt?.toISOString() ?? null,
      canCancel: sub?.status === "active" || sub?.status === "past_due",
      canRenew: !sub || sub.status === "expired" || sub.status === "cancelled" || sub.status === "pending",
      mode,
    },
    token: active?.token ?? null,
    previousToken: prev ? { token: prev.token, validUntil: new Date(prev.revokedAt!.getTime() + e.TOKEN_ROTATION_GRACE_HOURS * 3_600_000).toISOString() } : null,
    dns: {
      dohUrl: active ? `https://${proDomain}/dns/${active.token}` : null,
      dotHost: active ? `${active.token}.${proDomain}` : null,
      dnsIp,
      proDomain,
    },
    boundIps: ips.map((b) => ({
      id: b.id,
      kind: b.kind,
      ip: b.ip ? String(b.ip) : null,
      hostname: b.hostname,
      label: b.label,
      lastResolvedAt: b.lastResolvedAt?.toISOString() ?? null,
      lastError: b.lastError,
    })),
    maxBoundIps: e.MAX_BOUND_IPS,
    detectedIp,
    lastDnsIpHash: null,
    ddns: { login: email, hasKey: !!ddnsKey, updateUrl: `${e.PUBLIC_ORIGIN}/nic/update` },
    categories: catalog.categories.map((c) => ({
      id: c.id,
      name: c.name,
      tier: c.tier,
      pool: c.pool,
      enabled: !disabled.has(c.id),
      serviceCount: c.services.length,
    })),
    activity: { devices24h: act?.devices ?? 0, queries24h: act?.queries ?? 0, lastSeen: act?.last ? new Date(act.last).toISOString() : null },
  };
}

export async function rotateToken(userId: string): Promise<string> {
  const now = new Date();
  await db().update(schema.accessTokens).set({ revokedAt: now }).where(and(eq(schema.accessTokens.userId, userId), isNull(schema.accessTokens.revokedAt)));
  let token = "";
  for (let i = 0; i < 5 && !token; i++) {
    const candidate = generateAccessToken();
    const rows = await db().insert(schema.accessTokens).values({ userId, token: candidate }).onConflictDoNothing().returning({ token: schema.accessTokens.token });
    token = rows[0]?.token ?? "";
  }
  if (!token) throw new HttpError(500, "Не удалось выпустить токен.", "token");
  await bumpPolicyVersion("token.rotate");
  return token;
}

export async function ensureTokenForUser(userId: string): Promise<string> {
  return ensureAccessToken(userId);
}

export type AddBoundIpInput = { kind: "static" | "ddns_host" | "ddns_push"; ip?: string; hostname?: string; label?: string };

export async function addBoundIp(userId: string, input: AddBoundIpInput, detectedIp: string | null): Promise<void> {
  const e = env();
  const existing = await db().select().from(schema.boundIps).where(eq(schema.boundIps.userId, userId));
  if (existing.length >= e.MAX_BOUND_IPS) throw new HttpError(409, `Можно привязать не больше ${e.MAX_BOUND_IPS} адресов.`, "limit");
  const label = (input.label ?? "").trim().slice(0, 60);
  const now = new Date();
  if (input.kind === "static") {
    const ip = (input.ip ?? detectedIp ?? "").trim();
    if (!isPublicIPv4(ip)) throw new HttpError(400, "Нужен публичный IPv4-адрес.", "bad_ip");
    await insertIp(userId, "static", ip, null, label, now);
  } else if (input.kind === "ddns_host") {
    const host = (input.hostname ?? "").trim().toLowerCase();
    if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(host)) throw new HttpError(400, "Некорректное DDNS-имя.", "bad_host");
    const ip = await resolveDdnsHostname(host);
    if (!ip) throw new HttpError(400, "Имя не резолвится в публичный IPv4. Проверьте настройки DDNS.", "unresolvable");
    await insertIp(userId, "ddns_host", ip, host, label || host, now);
  } else {
    // ddns_push: IP появится после первого запроса роутера на /nic/update
    await db().insert(schema.boundIps).values({ userId, kind: "ddns_push", ip: null, hostname: null, label: label || "Роутер (DynDNS2)", updatedAt: now });
    await ensureDdnsKey(userId);
  }
  await bumpPolicyVersion("ip.add");
  await bumpAclVersion("ip.add");
}

async function insertIp(userId: string, kind: "static" | "ddns_host", ip: string, hostname: string | null, label: string, now: Date) {
  const rows = await db()
    .insert(schema.boundIps)
    .values({ userId, kind, ip, hostname, label, lastResolvedAt: hostname ? now : null, updatedAt: now })
    .onConflictDoNothing({ target: schema.boundIps.ip })
    .returning({ id: schema.boundIps.id });
  if (!rows[0]) throw new HttpError(409, "Этот IP уже привязан (возможно, к другому аккаунту).", "ip_taken");
}

export async function removeBoundIp(userId: string, id: string): Promise<void> {
  const deleted = await db()
    .delete(schema.boundIps)
    .where(and(eq(schema.boundIps.id, id), eq(schema.boundIps.userId, userId)))
    .returning({ id: schema.boundIps.id });
  if (!deleted.length) throw new HttpError(404, "Запись не найдена.", "not_found");
  await bumpPolicyVersion("ip.remove");
  await bumpAclVersion("ip.remove");
}

export async function setDisabledCategories(userId: string, disabled: string[]): Promise<string[]> {
  const known = new Set(allCategoryIds());
  const clean = [...new Set(disabled.filter((c) => known.has(c)))];
  await db()
    .insert(schema.userPolicy)
    .values({ userId, disabledCategories: clean, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.userPolicy.userId, set: { disabledCategories: clean, updatedAt: new Date() } });
  await bumpPolicyVersion("categories");
  return clean;
}

/** Выпускает (или перевыпускает) DDNS-ключ; возвращает ключ открытым текстом один раз. */
export async function rotateDdnsKey(userId: string): Promise<string> {
  const key = generateSecret(18);
  await db()
    .insert(schema.ddnsKeys)
    .values({ userId, keyHash: hashSecret(key) })
    .onConflictDoUpdate({ target: schema.ddnsKeys.userId, set: { keyHash: hashSecret(key), createdAt: new Date() } });
  return key;
}

async function ensureDdnsKey(userId: string): Promise<void> {
  const [existing] = await db().select().from(schema.ddnsKeys).where(eq(schema.ddnsKeys.userId, userId)).limit(1);
  if (!existing) await rotateDdnsKey(userId);
}
