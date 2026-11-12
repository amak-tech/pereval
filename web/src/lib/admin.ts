import { isIP } from "node:net";
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { createLoginLink, ensureUserByEmail } from "@/lib/auth-core";
import { MAX_MAIL_ATTEMPTS, enqueueAdminMail, enqueueMail, outboxStats } from "@/lib/mail";
import { adminAlertMail, magicLinkMail } from "@/lib/mail-templates";
import { bumpPolicyVersion, policyVersion, userAccessStates } from "@/lib/policy";
import { aclVersion, bumpAclVersion } from "@/lib/acl";
import * as billing from "@/lib/billing";
import { accessUntil, addPeriod, type DnsMode } from "@/lib/subscription";
import { createNode } from "@/lib/nodes";
import { removeBoundIp, rotateToken } from "@/lib/account";
import { daysLeft, loadPublishedCert } from "@/lib/cert";
import { setSetting } from "@/lib/settings";
import {
  getDefaultNodeMaxClients,
  getNodeWatchStatus,
  NODE_MAX_CLIENTS_SETTING_KEY,
  type NodeWatchReport,
} from "@/jobs/nodewatch";
import type { NodeKind, SubscriptionStatus } from "@/lib/db/schema";
import { NODE_KINDS } from "@/lib/admin-constants";

export { NODE_KINDS };

/**
 * Админ-панель (/admin) и админ-CLI: данные и действия поверх БД.
 * Без импорта next-auth — модуль попадает в бандл scripts/admin.ts (esbuild, чистый Node).
 * Проверка прав — в admin-auth.ts; здесь только «что сделать», с записью в audit_log.
 */

// ---------------------------------------------------------------- кто админ

export function parseAdminEmails(adminEmails: string, adminEmail: string): Set<string> {
  return new Set(
    `${adminEmails},${adminEmail}`
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );
}

export function adminEmails(): Set<string> {
  const e = env();
  return parseAdminEmails(e.ADMIN_EMAILS, e.ADMIN_EMAIL);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && adminEmails().has(email.toLowerCase());
}

export type Admin = { id: string | null; email: string };

export const PAGE_SIZE = 50;

// ---------------------------------------------------------------- журнал

export async function audit(admin: Admin, action: string, details: Record<string, unknown> = {}): Promise<void> {
  await db()
    .insert(schema.auditLog)
    .values({ userId: admin.id, action, details: { admin: admin.email, ...details } });
}

export async function listAudit(page = 1): Promise<{ rows: (typeof schema.auditLog.$inferSelect)[]; total: number }> {
  const [c] = await db().select({ n: dsql<number>`count(*)::int` }).from(schema.auditLog);
  const rows = await db()
    .select()
    .from(schema.auditLog)
    .orderBy(desc(schema.auditLog.at))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return { rows, total: c?.n ?? 0 };
}

// ---------------------------------------------------------------- подписки: выбор «лучшей»

const STATUS_RANK: Record<SubscriptionStatus, number> = { active: 5, past_due: 4, cancelled: 3, pending: 2, expired: 1 };

type Sub = typeof schema.subscriptions.$inferSelect;

export function bestSubscription<T extends Sub>(subs: T[]): T | null {
  let best: T | null = null;
  for (const s of subs) {
    if (!best) {
      best = s;
      continue;
    }
    const rank = STATUS_RANK[s.status] - STATUS_RANK[best.status];
    if (rank > 0 || (rank === 0 && s.updatedAt.getTime() > best.updatedAt.getTime())) best = s;
  }
  return best;
}

/** Конец доступа после ручной выдачи: от текущего конца, если он ещё не наступил; 30 дней = календарный месяц. */
export function grantPeriodEnd(existingEnd: Date | null, now: Date, days: number): Date {
  const base = existingEnd && existingEnd.getTime() > now.getTime() ? existingEnd : now;
  return days === 30 ? addPeriod(base, "MONTHLY") : new Date(base.getTime() + days * 86_400_000);
}

// ---------------------------------------------------------------- обзор

export type AdminOverview = {
  users: { total: number; new24h: number; new7d: number };
  subs: Record<string, number>;
  proxyUsers: number;
  dns: { users24h: number; queries24h: number; devices24h: number };
  revenue30d: { currency: string; amount: string; count: number }[];
  leads7d: number;
  mail: { pending: number; failed: number };
  webhooks: { errors7d: number; total7d: number };
  nodes: { id: string; name: string; kind: string; ip: string | null; enabled: boolean; lastSeenAt: Date | null; stale: boolean }[];
  nodewatch: NodeWatchReport | null;
  cert: { daysLeft: number | null; notAfter: Date | null; names: string[] } | null;
  versions: { policy: number; acl: number };
  aclDynamic: number;
  audit: (typeof schema.auditLog.$inferSelect)[];
};

export const NODE_STALE_MS = 10 * 60_000;

export async function adminOverview(now: Date = new Date()): Promise<AdminOverview> {
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const count = dsql<number>`count(*)::int`;

  const [[total], [new24h], [new7d], subsRows, states, [dns], revenue, [leads], mail, [wh], nodes, nodewatch, cert, policyV, aclV, [acl], audit] = await Promise.all([
    db().select({ n: count }).from(schema.users),
    db().select({ n: count }).from(schema.usersMeta).where(gt(schema.usersMeta.createdAt, dayAgo)),
    db().select({ n: count }).from(schema.usersMeta).where(gt(schema.usersMeta.createdAt, weekAgo)),
    db().select({ status: schema.subscriptions.status, n: count }).from(schema.subscriptions).groupBy(schema.subscriptions.status),
    userAccessStates(now),
    db()
      .select({
        users: dsql<number>`count(distinct ${schema.tokenActivity.userId})::int`,
        devices: dsql<number>`count(distinct ${schema.tokenActivity.ipHash})::int`,
        queries: dsql<number>`coalesce(sum(${schema.tokenActivity.queries}),0)::int`,
      })
      .from(schema.tokenActivity)
      .where(gt(schema.tokenActivity.lastSeen, dayAgo)),
    db()
      .select({
        currency: dsql<string>`coalesce(${schema.invoices.currency}, '?')`,
        amount: dsql<string>`coalesce(sum((${schema.invoices.amount})::numeric),0)::text`,
        count: count,
      })
      .from(schema.invoices)
      .where(and(inArray(schema.invoices.status, ["completed", "subscription-active"]), gt(schema.invoices.updatedAt, monthAgo)))
      .groupBy(schema.invoices.currency),
    db().select({ n: count }).from(schema.leads).where(gt(schema.leads.createdAt, weekAgo)),
    outboxStats(),
    db()
      .select({ total: count, errors: dsql<number>`count(${schema.webhookEvents.error})::int` })
      .from(schema.webhookEvents)
      .where(gt(schema.webhookEvents.receivedAt, weekAgo)),
    db().select().from(schema.nodes).orderBy(asc(schema.nodes.kind), asc(schema.nodes.name)),
    getNodeWatchStatus().catch(() => null),
    loadPublishedCert().catch(() => null),
    policyVersion(),
    aclVersion(),
    db().select({ n: count }).from(schema.aclDynamic).where(gt(schema.aclDynamic.expiresAt, now)),
    db().select().from(schema.auditLog).orderBy(desc(schema.auditLog.at)).limit(10),
  ]);

  let proxyUsers = 0;
  for (const st of states.values()) if (st.mode === "proxy") proxyUsers++;

  return {
    users: { total: total?.n ?? 0, new24h: new24h?.n ?? 0, new7d: new7d?.n ?? 0 },
    subs: Object.fromEntries(subsRows.map((r) => [r.status, r.n])),
    proxyUsers,
    dns: { users24h: dns?.users ?? 0, devices24h: dns?.devices ?? 0, queries24h: dns?.queries ?? 0 },
    revenue30d: revenue.map((r) => ({ currency: r.currency, amount: r.amount, count: r.count })),
    leads7d: leads?.n ?? 0,
    mail,
    webhooks: { total7d: wh?.total ?? 0, errors7d: wh?.errors ?? 0 },
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      ip: n.ip,
      enabled: n.enabled,
      lastSeenAt: n.lastSeenAt,
      stale: n.enabled && (!n.lastSeenAt || now.getTime() - n.lastSeenAt.getTime() > NODE_STALE_MS),
    })),
    nodewatch,
    cert: cert ? { daysLeft: daysLeft(cert.notAfter, now), notAfter: cert.notAfter, names: cert.names } : null,
    versions: { policy: policyV, acl: aclV },
    aclDynamic: acl?.n ?? 0,
    audit,
  };
}

// ---------------------------------------------------------------- пользователи

export const USER_STATUS_FILTERS = ["active", "past_due", "cancelled", "expired", "pending", "none"] as const;
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number];

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date | null;
  lastLoginAt: Date | null;
  status: SubscriptionStatus | null;
  periodEnd: Date | null;
  mode: DnsMode;
  provider: string | null;
  hasToken: boolean;
  ips: number;
  devices24h: number;
  queries24h: number;
  lastSeen: Date | null;
};

export async function listUsers(f: { q?: string; status?: UserStatusFilter; page?: number }, now: Date = new Date()): Promise<{ rows: UserRow[]; total: number }> {
  const page = Math.max(1, f.page ?? 1);
  const conds = [];
  const q = (f.q ?? "").trim();
  if (q) conds.push(ilike(schema.users.email, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
  if (f.status === "none") {
    conds.push(notInArray(schema.users.id, db().select({ id: schema.subscriptions.userId }).from(schema.subscriptions)));
  } else if (f.status) {
    conds.push(inArray(schema.users.id, db().select({ id: schema.subscriptions.userId }).from(schema.subscriptions).where(eq(schema.subscriptions.status, f.status))));
  }
  const where = conds.length ? and(...conds) : undefined;
  const [c] = await db().select({ n: dsql<number>`count(*)::int` }).from(schema.users).where(where);
  const users = await db()
    .select({ u: schema.users, m: schema.usersMeta })
    .from(schema.users)
    .leftJoin(schema.usersMeta, eq(schema.usersMeta.userId, schema.users.id))
    .where(where)
    .orderBy(dsql`${schema.usersMeta.createdAt} desc nulls last`, desc(schema.users.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  const ids = users.map((r) => r.u.id);
  if (!ids.length) return { rows: [], total: c?.n ?? 0 };

  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [subs, tokens, ips, activity, states] = await Promise.all([
    db().select().from(schema.subscriptions).where(inArray(schema.subscriptions.userId, ids)),
    db().select({ userId: schema.accessTokens.userId }).from(schema.accessTokens).where(and(inArray(schema.accessTokens.userId, ids), isNull(schema.accessTokens.revokedAt))),
    db().select({ userId: schema.boundIps.userId, n: dsql<number>`count(*)::int` }).from(schema.boundIps).where(inArray(schema.boundIps.userId, ids)).groupBy(schema.boundIps.userId),
    db()
      .select({
        userId: schema.tokenActivity.userId,
        devices: dsql<number>`count(distinct ${schema.tokenActivity.ipHash})::int`,
        queries: dsql<number>`coalesce(sum(${schema.tokenActivity.queries}),0)::int`,
        last: dsql<Date | string | null>`max(${schema.tokenActivity.lastSeen})`,
      })
      .from(schema.tokenActivity)
      .where(and(inArray(schema.tokenActivity.userId, ids), gt(schema.tokenActivity.lastSeen, dayAgo)))
      .groupBy(schema.tokenActivity.userId),
    userAccessStates(now),
  ]);
  const subsBy = new Map<string, Sub[]>();
  for (const s of subs) subsBy.set(s.userId, [...(subsBy.get(s.userId) ?? []), s]);
  const tokenSet = new Set(tokens.map((t) => t.userId));
  const ipsBy = new Map(ips.map((r) => [r.userId, r.n]));
  const actBy = new Map(activity.map((a) => [a.userId, a]));

  return {
    total: c?.n ?? 0,
    rows: users.map(({ u, m }) => {
      const best = bestSubscription(subsBy.get(u.id) ?? []);
      const a = actBy.get(u.id);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        createdAt: m?.createdAt ?? null,
        lastLoginAt: m?.lastLoginAt ?? null,
        status: best?.status ?? null,
        periodEnd: best?.periodEnd ?? null,
        mode: states.get(u.id)?.mode ?? "plain",
        provider: best?.provider ?? null,
        hasToken: tokenSet.has(u.id),
        ips: ipsBy.get(u.id) ?? 0,
        devices24h: a?.devices ?? 0,
        queries24h: a?.queries ?? 0,
        lastSeen: a?.last ? new Date(a.last) : null,
      };
    }),
  };
}

export type UserDetail = {
  user: typeof schema.users.$inferSelect;
  meta: typeof schema.usersMeta.$inferSelect | null;
  accounts: { provider: string }[];
  mode: DnsMode;
  accessUntil: Date | null;
  subscriptions: Sub[];
  invoices: (typeof schema.invoices.$inferSelect)[];
  tokens: (typeof schema.accessTokens.$inferSelect)[];
  boundIps: (typeof schema.boundIps.$inferSelect)[];
  ddnsKey: { createdAt: Date; lastUsedAt: Date | null } | null;
  disabledCategories: string[];
  activity: { day: string; devices: number; queries: number }[];
  aclDynamic: { ip: string; expiresAt: Date }[];
  webhooks: (typeof schema.webhookEvents.$inferSelect)[];
  audit: (typeof schema.auditLog.$inferSelect)[];
};

export async function userDetail(userId: string, now: Date = new Date()): Promise<UserDetail | null> {
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return null;
  const twoWeeks = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const [[meta], accounts, subscriptions, invoices, tokens, boundIps, [ddnsKey], [policy], activity, aclDynamic, auditRows] = await Promise.all([
    db().select().from(schema.usersMeta).where(eq(schema.usersMeta.userId, userId)).limit(1),
    db().select({ provider: schema.accounts.provider }).from(schema.accounts).where(eq(schema.accounts.userId, userId)),
    db().select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId)).orderBy(desc(schema.subscriptions.updatedAt)),
    db()
      .select()
      .from(schema.invoices)
      .where(or(eq(schema.invoices.userId, userId), eq(schema.invoices.email, user.email)))
      .orderBy(desc(schema.invoices.createdAt))
      .limit(50),
    db().select().from(schema.accessTokens).where(eq(schema.accessTokens.userId, userId)).orderBy(desc(schema.accessTokens.createdAt)),
    db().select().from(schema.boundIps).where(eq(schema.boundIps.userId, userId)).orderBy(asc(schema.boundIps.createdAt)),
    db().select({ createdAt: schema.ddnsKeys.createdAt, lastUsedAt: schema.ddnsKeys.lastUsedAt }).from(schema.ddnsKeys).where(eq(schema.ddnsKeys.userId, userId)).limit(1),
    db().select().from(schema.userPolicy).where(eq(schema.userPolicy.userId, userId)).limit(1),
    db()
      .select({
        day: schema.tokenActivity.day,
        devices: dsql<number>`count(distinct ${schema.tokenActivity.ipHash})::int`,
        queries: dsql<number>`coalesce(sum(${schema.tokenActivity.queries}),0)::int`,
      })
      .from(schema.tokenActivity)
      .where(and(eq(schema.tokenActivity.userId, userId), gt(schema.tokenActivity.day, twoWeeks)))
      .groupBy(schema.tokenActivity.day)
      .orderBy(desc(schema.tokenActivity.day)),
    db().select({ ip: schema.aclDynamic.ip, expiresAt: schema.aclDynamic.expiresAt }).from(schema.aclDynamic).where(and(eq(schema.aclDynamic.userId, userId), gt(schema.aclDynamic.expiresAt, now))),
    db()
      .select()
      .from(schema.auditLog)
      .where(or(eq(schema.auditLog.userId, userId), dsql`${schema.auditLog.details}->>'targetUserId' = ${userId}`))
      .orderBy(desc(schema.auditLog.at))
      .limit(30),
  ]);
  const contracts = [...new Set([...subscriptions.map((s) => s.parentContractId), ...invoices.map((i) => i.id)].filter((x): x is string => !!x))];
  const webhooks = contracts.length
    ? await db().select().from(schema.webhookEvents).where(inArray(schema.webhookEvents.contractId, contracts)).orderBy(desc(schema.webhookEvents.receivedAt)).limit(50)
    : [];
  const best = bestSubscription(subscriptions);
  const states = await userAccessStates(now);
  return {
    user,
    meta: meta ?? null,
    accounts,
    mode: states.get(userId)?.mode ?? "plain",
    accessUntil: best ? accessUntil(best.status, best.periodEnd, env().GRACE_DAYS) : null,
    subscriptions,
    invoices,
    tokens,
    boundIps,
    ddnsKey: ddnsKey ?? null,
    disabledCategories: policy?.disabledCategories ?? [],
    activity,
    aclDynamic: aclDynamic.map((a) => ({ ip: String(a.ip), expiresAt: a.expiresAt })),
    webhooks,
    audit: auditRows,
  };
}

async function userById(userId: string) {
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) throw new HttpError(404, "Пользователь не найден.", "not_found");
  return user;
}

/** Выдать/продлить доступ вручную (без оплаты): подписка provider=manual, токен, push на ноды. */
export async function grantAccess(admin: Admin, userId: string, days: number, now: Date = new Date()): Promise<{ email: string; periodEnd: Date; token: string }> {
  if (!Number.isFinite(days) || days < 1 || days > 3660) throw new HttpError(400, "Срок — от 1 до 3660 дней.", "bad_days");
  const user = await userById(userId);
  const subs = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
  const existing = bestSubscription(subs);
  const periodEnd = grantPeriodEnd(existing?.periodEnd ?? null, now, days);
  if (existing) {
    await db().update(schema.subscriptions).set({ status: "active", periodEnd, cancelledAt: null, updatedAt: now }).where(eq(schema.subscriptions.id, existing.id));
  } else {
    await db().insert(schema.subscriptions).values({ userId, provider: "manual", status: "active", startedAt: now, periodEnd, updatedAt: now });
  }
  const token = await billing.ensureAccessToken(userId);
  await bumpPolicyVersion("admin.grant");
  await bumpAclVersion("admin.grant");
  await audit(admin, "admin.grant", { targetUserId: userId, email: user.email, days, periodEnd: periodEnd.toISOString() });
  return { email: user.email, periodEnd, token };
}

export async function grantAccessByEmail(admin: Admin, email: string, days: number): Promise<{ email: string; periodEnd: Date; token: string }> {
  const user = await ensureUserByEmail(email);
  return grantAccess(admin, user.id, days);
}

/** Отключить доступ: все подписки → expired. Подписку в lava.top не отменяет (для этого — кабинет пользователя или lava.top). */
export async function revokeAccess(admin: Admin, userId: string): Promise<{ email: string }> {
  const user = await userById(userId);
  await db().update(schema.subscriptions).set({ status: "expired", updatedAt: new Date() }).where(eq(schema.subscriptions.userId, userId));
  await bumpPolicyVersion("admin.revoke");
  await bumpAclVersion("admin.revoke");
  await audit(admin, "admin.revoke", { targetUserId: userId, email: user.email });
  return { email: user.email };
}

/** Ссылка входа: письмо в очередь + сам URL (для ручной выдачи в мессенджер). */
export async function issueLoginLink(admin: Admin, userId: string): Promise<{ email: string; url: string }> {
  const user = await userById(userId);
  const url = await createLoginLink(user.email, 24 * 3600);
  const tpl = magicLinkMail(url);
  await enqueueMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  await audit(admin, "admin.login_link", { targetUserId: userId, email: user.email });
  return { email: user.email, url };
}

export async function adminRotateToken(admin: Admin, userId: string): Promise<{ token: string }> {
  const user = await userById(userId);
  const token = await rotateToken(userId);
  await audit(admin, "admin.rotate_token", { targetUserId: userId, email: user.email });
  return { token };
}

export async function adminRemoveBoundIp(admin: Admin, userId: string, ipId: string): Promise<void> {
  await removeBoundIp(userId, ipId);
  await audit(admin, "admin.remove_ip", { targetUserId: userId, ipId });
}

// ---------------------------------------------------------------- биллинг

export async function listSubscriptions(f: { status?: SubscriptionStatus; page?: number }) {
  const page = Math.max(1, f.page ?? 1);
  const where = f.status ? eq(schema.subscriptions.status, f.status) : undefined;
  const [c] = await db().select({ n: dsql<number>`count(*)::int` }).from(schema.subscriptions).where(where);
  const rows = await db()
    .select({ s: schema.subscriptions, email: schema.users.email })
    .from(schema.subscriptions)
    .leftJoin(schema.users, eq(schema.users.id, schema.subscriptions.userId))
    .where(where)
    .orderBy(desc(schema.subscriptions.updatedAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return { rows, total: c?.n ?? 0 };
}

export async function listInvoices(limit = 100) {
  return db().select().from(schema.invoices).orderBy(desc(schema.invoices.createdAt)).limit(limit);
}

export async function listWebhookEvents(f: { onlyErrors?: boolean; page?: number }) {
  const page = Math.max(1, f.page ?? 1);
  const where = f.onlyErrors ? isNotNull(schema.webhookEvents.error) : undefined;
  const [c] = await db().select({ n: dsql<number>`count(*)::int` }).from(schema.webhookEvents).where(where);
  const rows = await db()
    .select()
    .from(schema.webhookEvents)
    .where(where)
    .orderBy(desc(schema.webhookEvents.receivedAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return { rows, total: c?.n ?? 0 };
}

/** Переиграть сохранённый вебхук lava.top (например, после ошибки обработки). */
export async function replayWebhookEvent(admin: Admin, id: string): Promise<{ type: string }> {
  const [ev] = await db().select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, id)).limit(1);
  if (!ev) throw new HttpError(404, "Событие не найдено.", "not_found");
  const parsed = billing.parseWebhook(ev.payload);
  if (!parsed) throw new HttpError(400, "Не удалось разобрать payload события.", "bad_payload");
  try {
    if (parsed.kind === "envelope") await billing.handleRefundOrChargeback(parsed.data);
    else if (parsed.type === "payment.success") await (parsed.data.parentContractId ? billing.handleRenewalSuccess(parsed.data) : billing.handleFirstPayment(parsed.data));
    else if (parsed.type === "subscription.recurring.payment.success") await billing.handleRenewalSuccess(parsed.data);
    else if (parsed.type === "subscription.recurring.payment.failed") await billing.handleRenewalFailed(parsed.data);
    else if (parsed.type === "subscription.cancelled") await billing.handleCancelled(parsed.data);
    else if (parsed.type === "payment.failed") await billing.handlePaymentFailed(parsed.data);
    else throw new HttpError(400, `Неизвестный тип события ${parsed.type}.`, "unknown_type");
    await db().update(schema.webhookEvents).set({ processedAt: new Date(), error: null }).where(eq(schema.webhookEvents.id, id));
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    await db().update(schema.webhookEvents).set({ processedAt: new Date(), error: msg }).where(eq(schema.webhookEvents.id, id));
    throw err;
  }
  await audit(admin, "admin.webhook_replay", { eventId: id, type: parsed.type, contractId: ev.contractId });
  return { type: parsed.type };
}

export async function adminReconcile(admin: Admin) {
  const r = await billing.reconcileSubscriptions();
  await audit(admin, "admin.reconcile", r);
  return r;
}

export async function adminRefreshPlans(admin: Admin) {
  const plans = await billing.getPlans(true);
  await audit(admin, "admin.refresh_plans", { pro: plans.pro });
  return plans;
}

// ---------------------------------------------------------------- ноды и инфраструктура

const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export async function listNodes() {
  return db().select().from(schema.nodes).orderBy(asc(schema.nodes.kind), asc(schema.nodes.name));
}

export async function addNode(admin: Admin, name: string, kind: string, ip: string | null): Promise<{ id: string; secret: string }> {
  if (!NODE_NAME_RE.test(name)) throw new HttpError(400, "Имя ноды: латиница, цифры и дефис, до 40 символов.", "bad_name");
  if (!NODE_KINDS.includes(kind as NodeKind)) throw new HttpError(400, `Тип ноды: ${NODE_KINDS.join(" | ")}.`, "bad_kind");
  const cleanIp = (ip ?? "").trim() || null;
  if (cleanIp && !isIP(cleanIp)) throw new HttpError(400, "Некорректный IP-адрес.", "bad_ip");
  const [dup] = await db().select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.name, name)).limit(1);
  if (dup) throw new HttpError(409, "Нода с таким именем уже есть.", "duplicate");
  const created = await createNode(name, kind as NodeKind, cleanIp);
  await audit(admin, "admin.node_add", { nodeId: created.id, name, kind, ip: cleanIp });
  return created;
}

export async function setNodeEnabled(admin: Admin, id: string, enabled: boolean): Promise<{ name: string }> {
  const [row] = await db().update(schema.nodes).set({ enabled }).where(eq(schema.nodes.id, id)).returning({ name: schema.nodes.name });
  if (!row) throw new HttpError(404, "Нода не найдена.", "not_found");
  await audit(admin, enabled ? "admin.node_enable" : "admin.node_disable", { nodeId: id, name: row.name });
  return row;
}

export async function deleteNode(admin: Admin, id: string): Promise<{ name: string }> {
  const [row] = await db().delete(schema.nodes).where(eq(schema.nodes.id, id)).returning({ name: schema.nodes.name });
  if (!row) throw new HttpError(404, "Нода не найдена.", "not_found");
  await audit(admin, "admin.node_delete", { nodeId: id, name: row.name });
  return row;
}

/** Принудительно разбудить long-poll нод: новая версия политики или ACL без изменения данных. */
export async function pushToNodes(admin: Admin, what: "policy" | "acl"): Promise<number> {
  const v = what === "policy" ? await bumpPolicyVersion("admin.push") : await bumpAclVersion("admin.push");
  await audit(admin, `admin.push_${what}`, { version: v });
  return v;
}

export { getDefaultNodeMaxClients, getNodeWatchStatus };

export async function setNodeMaxClients(admin: Admin, maxClients: number): Promise<{ maxClients: number }> {
  const n = Math.floor(maxClients);
  if (!Number.isFinite(n) || n < 1 || n > 100_000) {
    throw new HttpError(400, "Порог клиентов должен быть от 1 до 100 000.", "bad_max_clients");
  }
  await setSetting(NODE_MAX_CLIENTS_SETTING_KEY, n);
  await audit(admin, "admin.node_max_clients", { maxClients: n });
  return { maxClients: n };
}

// ---------------------------------------------------------------- почта

export type MailState = "pending" | "failed" | "sent";

export async function listMail(f: { state?: MailState; page?: number }) {
  const page = Math.max(1, f.page ?? 1);
  const where =
    f.state === "sent"
      ? isNotNull(schema.mailOutbox.sentAt)
      : f.state === "failed"
        ? and(isNull(schema.mailOutbox.sentAt), lte(dsql`${MAX_MAIL_ATTEMPTS}`, schema.mailOutbox.attempts))
        : f.state === "pending"
          ? and(isNull(schema.mailOutbox.sentAt), lte(schema.mailOutbox.attempts, MAX_MAIL_ATTEMPTS - 1))
          : undefined;
  const [c] = await db().select({ n: dsql<number>`count(*)::int` }).from(schema.mailOutbox).where(where);
  const rows = await db()
    .select({
      id: schema.mailOutbox.id,
      to: schema.mailOutbox.to,
      subject: schema.mailOutbox.subject,
      text: schema.mailOutbox.text,
      createdAt: schema.mailOutbox.createdAt,
      sentAt: schema.mailOutbox.sentAt,
      attempts: schema.mailOutbox.attempts,
      nextAttemptAt: schema.mailOutbox.nextAttemptAt,
      lastError: schema.mailOutbox.lastError,
    })
    .from(schema.mailOutbox)
    .where(where)
    .orderBy(desc(schema.mailOutbox.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return { rows, total: c?.n ?? 0, stats: await outboxStats() };
}

/** Сбросить попытки: письмо уйдёт при следующем проходе outbox (≤ 15 с). */
export async function retryMail(admin: Admin, id: string): Promise<void> {
  const [row] = await db()
    .update(schema.mailOutbox)
    .set({ attempts: 0, nextAttemptAt: new Date(), lastError: null })
    .where(and(eq(schema.mailOutbox.id, id), isNull(schema.mailOutbox.sentAt)))
    .returning({ to: schema.mailOutbox.to });
  if (!row) throw new HttpError(404, "Письмо не найдено или уже отправлено.", "not_found");
  await audit(admin, "admin.mail_retry", { mailId: id, to: row.to });
}

export async function deleteMail(admin: Admin, id: string): Promise<void> {
  const [row] = await db().delete(schema.mailOutbox).where(eq(schema.mailOutbox.id, id)).returning({ to: schema.mailOutbox.to });
  if (!row) throw new HttpError(404, "Письмо не найдено.", "not_found");
  await audit(admin, "admin.mail_delete", { mailId: id, to: row.to });
}

export async function sendTestMail(admin: Admin): Promise<{ to: string }> {
  const t = adminAlertMail("Тестовое письмо из админ-панели", `Отправлено ${new Date().toISOString()} администратором ${admin.email}. Если вы это читаете — SMTP и outbox работают.`);
  await enqueueAdminMail(t.subject.replace("⚠️ ", "✅ "), t.text, t.html);
  await audit(admin, "admin.mail_test", {});
  return { to: env().ADMIN_EMAIL };
}

// ---------------------------------------------------------------- заявки

export async function listLeads(page = 1) {
  const [c] = await db().select({ n: dsql<number>`count(*)::int` }).from(schema.leads);
  const rows = await db()
    .select()
    .from(schema.leads)
    .orderBy(desc(schema.leads.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  const emails = [...new Set(rows.map((r) => r.email))];
  const users = emails.length ? await db().select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.email, emails)) : [];
  const userBy = new Map(users.map((u) => [u.email, u.id]));
  return { rows: rows.map((r) => ({ ...r, userId: userBy.get(r.email) ?? null })), total: c?.n ?? 0 };
}
