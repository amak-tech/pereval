import { and, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { adminEmails } from "@/lib/admin-emails";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { CHANNEL_POLICY, notify } from "@/lib/bus";
import { getIntSetting, incrementSetting } from "@/lib/settings";
import { dnsMode, type DnsMode } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/db/schema";

/**
 * Политика DNS для pro_dns.py: какие токены и IP кому принадлежат, в каком режиме
 * (proxy/plain/deny) и какие категории у пользователя выключены.
 */
export type PolicyEntry = {
  user_id: string;
  mode: DnsMode;
  disabled_categories: string[];
  preferred_region?: string | null;
  qps_limit?: number;
  is_admin?: boolean;
};

export type PolicySnapshot = {
  version: number;
  generated_at: string;
  tokens: Record<string, PolicyEntry>;
  ips: Record<string, PolicyEntry>;
  workers: null;
};

export const POLICY_VERSION_KEY = "policy_version";
const STATUS_RANK: Record<SubscriptionStatus, number> = { active: 5, past_due: 4, cancelled: 3, pending: 2, expired: 1 };

export async function policyVersion(): Promise<number> {
  return getIntSetting(POLICY_VERSION_KEY, 1);
}

export async function bumpPolicyVersion(reason: string): Promise<number> {
  const v = await incrementSetting(POLICY_VERSION_KEY);
  await notify(CHANNEL_POLICY, `${v}:${reason}`);
  return v;
}

export type UserAccessState = {
  userId: string;
  mode: DnsMode;
  status: SubscriptionStatus | null;
  periodEnd: Date | null;
  disabled: string[];
  preferredRegion: string | null;
};

/** Лучшая (определяющая доступ) подписка для каждого пользователя. */
export async function userAccessStates(now: Date = new Date()): Promise<Map<string, UserAccessState>> {
  const subs = await db().select().from(schema.subscriptions);
  const best = new Map<string, (typeof subs)[number]>();
  for (const s of subs) {
    const prev = best.get(s.userId);
    if (!prev) {
      best.set(s.userId, s);
      continue;
    }
    const rank = STATUS_RANK[s.status] - STATUS_RANK[prev.status];
    if (rank > 0 || (rank === 0 && s.updatedAt.getTime() > prev.updatedAt.getTime())) best.set(s.userId, s);
  }
  const policies = await db().select().from(schema.userPolicy);
  const policyBy = new Map(policies.map((p) => [p.userId, p]));
  const grace = env().GRACE_DAYS;
  const out = new Map<string, UserAccessState>();
  for (const [userId, s] of best) {
    const up = policyBy.get(userId);
    out.set(userId, {
      userId,
      status: s.status,
      periodEnd: s.periodEnd,
      mode: dnsMode(s.status, s.periodEnd, grace, now),
      disabled: up?.disabledCategories ?? [],
      preferredRegion: up?.preferredRegion ?? null,
    });
  }
  // пользователи с токенами/IP, но без подписки (например, созданные админом) — plain
  return out;
}

export function buildPolicyEntry(
  userId: string,
  states: ReadonlyMap<string, Pick<UserAccessState, "mode" | "disabled"> & { preferredRegion?: string | null }>,
  adminUserIds: ReadonlySet<string>,
): PolicyEntry {
  const st = states.get(userId);
  const entry: PolicyEntry = {
    user_id: userId,
    mode: st?.mode ?? "plain",
    disabled_categories: st?.disabled ?? [],
    qps_limit: 50,
  };
  if (st?.preferredRegion) entry.preferred_region = st.preferredRegion;
  if (adminUserIds.has(userId)) entry.is_admin = true;
  return entry;
}

export async function buildPolicySnapshot(now: Date = new Date()): Promise<PolicySnapshot> {
  const version = await policyVersion();
  const states = await userAccessStates(now);
  const graceCut = new Date(now.getTime() - env().TOKEN_ROTATION_GRACE_HOURS * 3_600_000);
  const tokens = await db()
    .select()
    .from(schema.accessTokens)
    .where(or(isNull(schema.accessTokens.revokedAt), gt(schema.accessTokens.revokedAt, graceCut)));
  const ips = await db()
    .select()
    .from(schema.boundIps)
    .where(and(isNotNull(schema.boundIps.ip)));

  const adminUserIds = new Set<string>();
  const admins = adminEmails();
  if (admins.size > 0) {
    const userIds = new Set<string>();
    for (const t of tokens) userIds.add(t.userId);
    for (const b of ips) if (b.ip) userIds.add(b.userId);
    if (userIds.size > 0) {
      const users = await db()
        .select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, [...userIds]));
      for (const u of users) {
        if (admins.has(u.email.toLowerCase())) adminUserIds.add(u.id);
      }
    }
  }

  const tokenMap: Record<string, PolicyEntry> = {};
  for (const t of tokens) tokenMap[t.token] = buildPolicyEntry(t.userId, states, adminUserIds);
  const ipMap: Record<string, PolicyEntry> = {};
  for (const b of ips) if (b.ip) ipMap[String(b.ip)] = buildPolicyEntry(b.userId, states, adminUserIds);

  return { version, generated_at: now.toISOString(), tokens: tokenMap, ips: ipMap, workers: null };
}
