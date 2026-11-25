import { describe, expect, it } from "vitest";
import { computeRetentionCutoffs } from "@/jobs/retention";
import { env, resetEnvCache } from "@/lib/env";

describe("computeRetentionCutoffs", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");

  it("вычисляет граничные даты хранения для всех служебных таблиц", () => {
    const cutoffs = computeRetentionCutoffs(now, {
      webhookDays: 90,
      activityDays: 35,
      mailDays: 30,
      auditDays: 180,
      tokenRotationGraceHours: 48,
    });

    expect(cutoffs.now).toEqual(now);
    expect(cutoffs.webhooks.toISOString()).toBe("2026-08-27T12:00:00.000Z");
    expect(cutoffs.activity.toISOString()).toBe("2026-10-21T12:00:00.000Z");
    expect(cutoffs.mail.toISOString()).toBe("2026-10-26T12:00:00.000Z");
    expect(cutoffs.audit.toISOString()).toBe("2026-05-29T12:00:00.000Z");
    // 48h grace < 30d minimum -> держим отозванные токены 30 суток
    expect(cutoffs.revokedTokens.toISOString()).toBe("2026-10-26T12:00:00.000Z");
    expect(cutoffs.certwatchSettings.toISOString()).toBe("2026-07-28T12:00:00.000Z");
  });

  it("не удаляет отозванные токены раньше окончания расширенного grace-периода", () => {
    const cutoffs = computeRetentionCutoffs(now, {
      webhookDays: 90,
      activityDays: 35,
      mailDays: 30,
      auditDays: 180,
      tokenRotationGraceHours: 24 * 40, // 40 суток
    });

    // 40 суток + 24 ч буфер = 41 сутки
    expect(cutoffs.revokedTokens.toISOString()).toBe("2026-10-15T12:00:00.000Z");
  });

  it("подставляет корректные дефолты RETENTION_* из env", () => {
    resetEnvCache();
    const e = env();
    expect(e.RETENTION_WEBHOOK_DAYS).toBe(90);
    expect(e.RETENTION_ACTIVITY_DAYS).toBe(35);
    expect(e.RETENTION_MAIL_DAYS).toBe(30);
    expect(e.RETENTION_AUDIT_DAYS).toBe(180);
  });
});
