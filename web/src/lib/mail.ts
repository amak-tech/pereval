import nodemailer, { type Transporter } from "nodemailer";
import { and, asc, eq, isNull, lte, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * Почта через outbox: письмо сначала попадает в таблицу mail_outbox, а отправляет
 * его планировщик (jobs/outbox.ts) с ретраями. Так падение SMTP не теряет письма
 * и не тормозит обработчики вебхуков.
 */
export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};

export async function enqueueMail(msg: MailMessage): Promise<string> {
  const [row] = await db()
    .insert(schema.mailOutbox)
    .values({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html ?? null, replyTo: msg.replyTo ?? null })
    .returning({ id: schema.mailOutbox.id });
  return row?.id ?? "";
}

export async function enqueueAdminMail(subject: string, text: string, html?: string, replyTo?: string): Promise<void> {
  const admin = env().ADMIN_EMAIL;
  if (!admin) return;
  await enqueueMail({ to: admin, subject, text, html, replyTo });
}

/** Задержки между попытками: 1м, 5м, 30м, затем каждые 2 ч; максимум 10 попыток. */
export function nextAttemptDelayMs(attempts: number): number {
  if (attempts <= 1) return 60_000;
  if (attempts === 2) return 5 * 60_000;
  if (attempts === 3) return 30 * 60_000;
  return 2 * 3_600_000;
}

export const MAX_MAIL_ATTEMPTS = 10;

let transporter: Transporter | null = null;

function transport(): Transporter {
  if (transporter) return transporter;
  const e = env();
  transporter = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_PORT === 465,
    auth: e.SMTP_USERNAME ? { user: e.SMTP_USERNAME, pass: e.SMTP_PASSWORD } : undefined,
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transporter;
}

export function fromHeader(): string {
  const e = env();
  return `"${e.MAIL_FROM_NAME.replace(/"/g, "")}" <${e.MAIL_FROM}>`;
}

export function smtpConfigured(): boolean {
  const e = env();
  return !!(e.SMTP_HOST && (e.SMTP_USERNAME || e.SMTP_HOST === "localhost" || e.SMTP_HOST === "127.0.0.1"));
}

/** Отправляет до `limit` писем из outbox. Возвращает число успешно отправленных. */
export async function sendPendingMail(limit = 20, now: Date = new Date()): Promise<number> {
  const rows = await db()
    .select()
    .from(schema.mailOutbox)
    .where(and(isNull(schema.mailOutbox.sentAt), lte(schema.mailOutbox.nextAttemptAt, now)))
    .orderBy(asc(schema.mailOutbox.createdAt))
    .limit(limit);
  let sent = 0;
  for (const row of rows) {
    if (row.attempts >= MAX_MAIL_ATTEMPTS) continue;
    try {
      if (!smtpConfigured()) {
        throw new Error("SMTP не настроен (SMTP_USERNAME/SMTP_PASSWORD)");
      }
      await transport().sendMail({
        from: fromHeader(),
        to: row.to,
        subject: row.subject,
        text: row.text,
        html: row.html ?? undefined,
        replyTo: row.replyTo ?? undefined,
      });
      await db()
        .update(schema.mailOutbox)
        .set({ sentAt: now, attempts: row.attempts + 1, lastError: null })
        .where(eq(schema.mailOutbox.id, row.id));
      sent++;
    } catch (err) {
      const attempts = row.attempts + 1;
      await db()
        .update(schema.mailOutbox)
        .set({
          attempts,
          lastError: String((err as Error)?.message ?? err).slice(0, 500),
          nextAttemptAt: new Date(now.getTime() + nextAttemptDelayMs(attempts)),
        })
        .where(eq(schema.mailOutbox.id, row.id));
      console.warn(`[mail] попытка ${attempts} для ${row.id} не удалась: ${(err as Error)?.message ?? err}`);
    }
  }
  return sent;
}

export async function outboxStats(): Promise<{ pending: number; failed: number }> {
  const [pending] = await db()
    .select({ n: dsql<number>`count(*)::int` })
    .from(schema.mailOutbox)
    .where(and(isNull(schema.mailOutbox.sentAt), lte(schema.mailOutbox.attempts, MAX_MAIL_ATTEMPTS - 1)));
  const [failed] = await db()
    .select({ n: dsql<number>`count(*)::int` })
    .from(schema.mailOutbox)
    .where(and(isNull(schema.mailOutbox.sentAt), lte(dsql`${MAX_MAIL_ATTEMPTS}`, schema.mailOutbox.attempts)));
  return { pending: pending?.n ?? 0, failed: failed?.n ?? 0 };
}
