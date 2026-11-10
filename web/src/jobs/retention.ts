import { lt } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/** Сроки хранения: payload вебхуков 90 дней, активность токенов 35 дней, отправленная почта 30 дней. */
export async function cleanupRetention(now: Date = new Date()): Promise<{ webhooks: number; activity: number; mail: number }> {
  const d90 = new Date(now.getTime() - 90 * 86_400_000);
  const d35 = new Date(now.getTime() - 35 * 86_400_000);
  const d30 = new Date(now.getTime() - 30 * 86_400_000);
  const webhooks = await db().delete(schema.webhookEvents).where(lt(schema.webhookEvents.receivedAt, d90)).returning({ id: schema.webhookEvents.id });
  const activity = await db().delete(schema.tokenActivity).where(lt(schema.tokenActivity.lastSeen, d35)).returning({ d: schema.tokenActivity.day });
  const mail = await db().delete(schema.mailOutbox).where(lt(schema.mailOutbox.sentAt, d30)).returning({ id: schema.mailOutbox.id });
  return { webhooks: webhooks.length, activity: activity.length, mail: mail.length };
}
