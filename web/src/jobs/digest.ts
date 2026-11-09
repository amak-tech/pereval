import { and, gt, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { enqueueAdminMail, outboxStats } from "@/lib/mail";
import { adminAlertMail } from "@/lib/mail-templates";
import { getSetting, setSetting } from "@/lib/settings";
import { certStatus, formatHostLine } from "@/jobs/certwatch";

/** Ежедневный дайджест администратору (в 08:00 по Москве). */
export async function sendDailyDigest(now: Date = new Date()): Promise<{ sent: boolean }> {
  const mskHour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Moscow" }).format(now));
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(now);
  if (mskHour < 8) return { sent: false };
  const key = `digest:${day}`;
  if (await getSetting(key)) return { sent: false };

  const since = new Date(now.getTime() - 86_400_000);
  const events = await db()
    .select({ type: schema.webhookEvents.eventType, n: dsql<number>`count(*)::int`, errors: dsql<number>`count(${schema.webhookEvents.error})::int` })
    .from(schema.webhookEvents)
    .where(gt(schema.webhookEvents.receivedAt, since))
    .groupBy(schema.webhookEvents.eventType);
  const subs = await db()
    .select({ status: schema.subscriptions.status, n: dsql<number>`count(*)::int` })
    .from(schema.subscriptions)
    .groupBy(schema.subscriptions.status);
  const [newUsers] = await db()
    .select({ n: dsql<number>`count(*)::int` })
    .from(schema.usersMeta)
    .where(gt(schema.usersMeta.createdAt, since));
  const [leads] = await db().select({ n: dsql<number>`count(*)::int` }).from(schema.leads).where(gt(schema.leads.createdAt, since));
  const nodesRows = await db().select().from(schema.nodes);
  const mail = await outboxStats();
  const cert = await certStatus(now);
  const [activeUsers] = await db()
    .select({ n: dsql<number>`count(distinct ${schema.tokenActivity.userId})::int` })
    .from(schema.tokenActivity)
    .where(and(gt(schema.tokenActivity.lastSeen, since)));

  const lines = [
    `Сутки до ${now.toISOString()}`,
    ``,
    `Платёжные события:`,
    ...(events.length ? events.map((e) => `  ${e.type}: ${e.n}${e.errors ? ` (ошибок: ${e.errors})` : ""}`) : ["  нет"]),
    ``,
    `Подписки: ${subs.map((s) => `${s.status}=${s.n}`).join(", ") || "нет"}`,
    `Новых пользователей: ${newUsers?.n ?? 0}; активных в DNS за сутки: ${activeUsers?.n ?? 0}; заявок: ${leads?.n ?? 0}`,
    `Почта: в очереди ${mail.pending}, не доставлено ${mail.failed}`,
    ``,
    `Ноды:`,
    ...(nodesRows.length
      ? nodesRows.map((n) => `  ${n.name} (${n.kind}) — последний контакт ${n.lastSeenAt ? n.lastSeenAt.toISOString() : "никогда"}${n.enabled ? "" : " [отключена]"}`)
      : ["  не зарегистрированы"]),
    ``,
    `Единый сертификат${cert.source === "cp" ? " (на CP)" : cert.source === "tls" ? " (по TLS сайта)" : ""}: ${cert.notAfter ? `${cert.daysLeft} дн. (до ${cert.notAfter.toISOString().slice(0, 10)})` : "не определён"}`,
    ...cert.hosts.map(formatHostLine),
  ];
  const t = adminAlertMail(`Дайджест Перевала за ${day}`, lines.join("\n"));
  await enqueueAdminMail(t.subject.replace("⚠️ ", "📊 "), t.text, t.html);
  await setSetting(key, now.toISOString());
  return { sent: true };
}
