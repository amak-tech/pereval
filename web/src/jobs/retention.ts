import { and, gte, isNull, like, lt, or } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { MAX_MAIL_ATTEMPTS } from "@/lib/mail";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type RetentionConfig = {
  webhookDays: number;
  activityDays: number;
  mailDays: number;
  auditDays: number;
  tokenRotationGraceHours: number;
};

export type RetentionCutoffs = {
  now: Date;
  webhooks: Date;
  activity: Date;
  mail: Date;
  audit: Date;
  revokedTokens: Date;
  certwatchSettings: Date;
};

export type RetentionResult = {
  webhooks: number;
  activity: number;
  mail: number;
  sessions: number;
  verificationTokens: number;
  revokedTokens: number;
  audit: number;
  settings: number;
};

/** Вычисляет граничные даты очистки таблиц БД с учётом минимально безопасных буферов. */
export function computeRetentionCutoffs(now: Date, cfg: RetentionConfig): RetentionCutoffs {
  const t = now.getTime();
  const revokedTokensMs = Math.max(30 * DAY_MS, (cfg.tokenRotationGraceHours + 24) * HOUR_MS);
  return {
    now,
    webhooks: new Date(t - cfg.webhookDays * DAY_MS),
    activity: new Date(t - cfg.activityDays * DAY_MS),
    mail: new Date(t - cfg.mailDays * DAY_MS),
    audit: new Date(t - cfg.auditDays * DAY_MS),
    revokedTokens: new Date(t - revokedTokensMs),
    certwatchSettings: new Date(t - 120 * DAY_MS),
  };
}

/**
 * Ежедневная очистка временных и исторических записей БД:
 *  - webhook_events старше RETENTION_WEBHOOK_DAYS (90 дн.);
 *  - token_activity старше RETENTION_ACTIVITY_DAYS (35 дн., KPI в админке берёт 30 дн.);
 *  - mail_outbox (отправленные и исчерпавшие попытки) старше RETENTION_MAIL_DAYS (30 дн.);
 *  - протухшие сессии Auth.js и одноразовые ссылки входа;
 *  - отозванные после ротации access_tokens старше 30 дн. (и строго за пределами grace-окна);
 *  - audit_log старше RETENTION_AUDIT_DAYS (180 дн.);
 *  - одноразовые маркеры digest:* (30 дн.) и certwatch:* (120 дн.) в settings.
 */
export async function cleanupRetention(now: Date = new Date()): Promise<RetentionResult> {
  const e = env();
  const cutoffs = computeRetentionCutoffs(now, {
    webhookDays: e.RETENTION_WEBHOOK_DAYS,
    activityDays: e.RETENTION_ACTIVITY_DAYS,
    mailDays: e.RETENTION_MAIL_DAYS,
    auditDays: e.RETENTION_AUDIT_DAYS,
    tokenRotationGraceHours: e.TOKEN_ROTATION_GRACE_HOURS,
  });

  const webhooks = await db()
    .delete(schema.webhookEvents)
    .where(lt(schema.webhookEvents.receivedAt, cutoffs.webhooks))
    .returning({ id: schema.webhookEvents.id });
  const activity = await db()
    .delete(schema.tokenActivity)
    .where(lt(schema.tokenActivity.lastSeen, cutoffs.activity))
    .returning({ d: schema.tokenActivity.day });
  const mail = await db()
    .delete(schema.mailOutbox)
    .where(
      or(
        lt(schema.mailOutbox.sentAt, cutoffs.mail),
        and(
          isNull(schema.mailOutbox.sentAt),
          gte(schema.mailOutbox.attempts, MAX_MAIL_ATTEMPTS),
          lt(schema.mailOutbox.createdAt, cutoffs.mail),
        ),
      ),
    )
    .returning({ id: schema.mailOutbox.id });
  const sessions = await db()
    .delete(schema.sessions)
    .where(lt(schema.sessions.expires, cutoffs.now))
    .returning({ t: schema.sessions.sessionToken });
  const verificationTokens = await db()
    .delete(schema.verificationTokens)
    .where(lt(schema.verificationTokens.expires, cutoffs.now))
    .returning({ t: schema.verificationTokens.token });
  const revokedTokens = await db()
    .delete(schema.accessTokens)
    .where(lt(schema.accessTokens.revokedAt, cutoffs.revokedTokens))
    .returning({ id: schema.accessTokens.id });
  const audit = await db()
    .delete(schema.auditLog)
    .where(lt(schema.auditLog.at, cutoffs.audit))
    .returning({ id: schema.auditLog.id });
  const settings = await db()
    .delete(schema.settings)
    .where(
      or(
        and(like(schema.settings.key, "digest:%"), lt(schema.settings.updatedAt, cutoffs.mail)),
        and(like(schema.settings.key, "certwatch:%"), lt(schema.settings.updatedAt, cutoffs.certwatchSettings)),
      ),
    )
    .returning({ key: schema.settings.key });

  return {
    webhooks: webhooks.length,
    activity: activity.length,
    mail: mail.length,
    sessions: sessions.length,
    verificationTokens: verificationTokens.length,
    revokedTokens: revokedTokens.length,
    audit: audit.length,
    settings: settings.length,
  };
}
