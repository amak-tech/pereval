import { and, gt, isNotNull, isNull, or } from "drizzle-orm";
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
  qps_limit?: number;
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
  const disabledBy = new Map(policies.map((p) => [p.userId, p.disabledCategories]));
  const grace = env().GRACE_DAYS;
  const out = new Map<string, UserAccessState>();
  for (const [userId, s] of best) {
    out.set(userId, {
      userId,
      status: s.status,
      periodEnd: s.periodEnd,
      mode: dnsMode(s.status, s.periodEnd, grace, now),
      disabled: disabledBy.get(userId) ?? [],
    });
  }
  // пользователи с токенами/IP, но без подписки (например, созданные админом) — plain
  return out;
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

  const entryFor = (userId: string): PolicyEntry => {
    const st = states.get(userId);
    return {
      user_id: userId,
      mode: st?.mode ?? "plain",
      disabled_categories: st?.disabled ?? [],
      qps_limit: 50,
    };
  };

  const tokenMap: Record<string, PolicyEntry> = {};
  for (const t of tokens) tokenMap[t.token] = entryFor(t.userId);
  const ipMap: Record<string, PolicyEntry> = {};
  for (const b of ips) if (b.ip) ipMap[String(b.ip)] = entryFor(b.userId);

  return { version, generated_at: now.toISOString(), tokens: tokenMap, ips: ipMap, workers: null };
}
