import { and, desc, eq, gt, sql as dsql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { catalog } from "@/lib/catalog";
import { db, schema } from "@/lib/db/client";
import { type CheckAccountContext, type CheckContextResponse } from "@/lib/diagnostics";
import { env } from "@/lib/env";
import { handle, json } from "@/lib/http";
import { clientIp, isPublicIPv4 } from "@/lib/ip";
import { dnsMode } from "@/lib/subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadAccountContext(userId: string, detectedIp: string | null): Promise<CheckAccountContext> {
  const e = env();
  const now = new Date();

  const subs = await db()
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.updatedAt));
  const rank: Record<string, number> = { active: 5, past_due: 4, cancelled: 3, pending: 2, expired: 1 };
  const sub = subs.sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0))[0] ?? null;
  const mode = dnsMode(sub?.status ?? null, sub?.periodEnd ?? null, e.GRACE_DAYS, now);

  const tokens = await db()
    .select()
    .from(schema.accessTokens)
    .where(eq(schema.accessTokens.userId, userId))
    .orderBy(desc(schema.accessTokens.createdAt));
  const activeToken = tokens.find((t) => !t.revokedAt) ?? null;

  const ips = await db()
    .select({ ip: schema.boundIps.ip })
    .from(schema.boundIps)
    .where(eq(schema.boundIps.userId, userId));
  const ipBound = Boolean(detectedIp && ips.some((row) => row.ip && String(row.ip) === detectedIp));

  let ipInDynamicAcl = false;
  let dynamicAclExpiresAt: string | null = null;
  if (detectedIp && isPublicIPv4(detectedIp)) {
    const [aclRow] = await db()
      .select({ expiresAt: schema.aclDynamic.expiresAt })
      .from(schema.aclDynamic)
      .where(
        and(
          eq(schema.aclDynamic.userId, userId),
          eq(schema.aclDynamic.ip, detectedIp),
          gt(schema.aclDynamic.expiresAt, now),
        ),
      )
      .limit(1);
    if (aclRow) {
      ipInDynamicAcl = true;
      dynamicAclExpiresAt = aclRow.expiresAt.toISOString();
    }
  }

  const [policy] = await db()
    .select({ disabledCategories: schema.userPolicy.disabledCategories })
    .from(schema.userPolicy)
    .where(eq(schema.userPolicy.userId, userId))
    .limit(1);

  const [act] = await db()
    .select({ last: dsql<Date | null>`max(${schema.tokenActivity.lastSeen})` })
    .from(schema.tokenActivity)
    .where(eq(schema.tokenActivity.userId, userId));

  const proDomain = catalog.pro?.domain ?? e.PRO_DOMAIN;

  return {
    authenticated: true,
    mode,
    subscriptionStatus: sub?.status ?? null,
    ipBound,
    ipInDynamicAcl,
    dynamicAclExpiresAt,
    lastDnsSeenAt: act?.last ? new Date(act.last).toISOString() : null,
    disabledCategories: policy?.disabledCategories ?? [],
    dohUrl: activeToken ? `https://${proDomain}/dns/${activeToken.token}` : null,
    dotHost: activeToken ? `${activeToken.token}.${proDomain}` : null,
  };
}

export async function GET(req: Request) {
  return handle(async () => {
    const e = env();
    const rawIp = clientIp(req.headers);
    const detectedIp = rawIp && rawIp !== "0.0.0.0" ? rawIp : null;

    const originHost = (() => {
      try {
        return new URL(catalog.meta.origin || e.PUBLIC_ORIGIN).hostname;
      } catch {
        return "pereval.top";
      }
    })();
    const checkDomain = catalog.meta.check_domain || `check.${originHost}`;
    const checkUrl = `https://${checkDomain}/ping`;
    const ipv6CheckUrl = e.IPV6_CHECK_URL.trim() || null;

    let account: CheckAccountContext | null = null;
    try {
      const session = await auth();
      if (session?.user?.id) {
        account = await loadAccountContext(session.user.id, detectedIp);
      }
    } catch {
      // Неавторизованный запрос или недоступность сессии не должны ломать диагностику
      account = null;
    }

    const freeWorkers = Array.from(
      new Set([catalog.free.dns_ip, ...catalog.free.workers.map((w) => w.ip)].filter(Boolean)),
    );
    const proWorkers = catalog.pro
      ? Array.from(new Set(catalog.pro.workers.map((w) => w.ip).filter(Boolean)))
      : [];

    const payload: CheckContextResponse = {
      detectedIp,
      checkDomain,
      checkUrl,
      ipv6CheckUrl,
      free: {
        domain: catalog.free.domain || e.FREE_DOMAIN,
        dnsIp: catalog.free.dns_ip || e.FREE_DNS_IP,
        dohUrl: catalog.free.doh_url,
        dotHost: catalog.free.dot_host,
        workerIps: freeWorkers,
      },
      pro: catalog.pro
        ? {
            domain: catalog.pro.domain || e.PRO_DOMAIN,
            dnsIp: catalog.pro.dns_ip || e.PRO_DNS_IP,
            workerIps: proWorkers,
          }
        : null,
      account,
    };

    return json(payload);
  });
}
