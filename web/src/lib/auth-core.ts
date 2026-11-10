/**
 * Пользователи и ссылки входа БЕЗ импорта next-auth: этот модуль нужен биллингу (вебхуки,
 * onboarding-письмо) и админ-CLI, которые работают в бандлах jobs/admin под чистым Node —
 * а next-auth тянет "next/server" и в Node ESM не резолвится. auth.ts реэкспортирует всё отсюда.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { hashAuthToken } from "@/lib/crypto";

/** Пользователь по email (lower-case) или null. */
export async function findUserByEmail(email: string) {
  const [row] = await db().select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1);
  return row ?? null;
}

/** Создаёт пользователя (если нет) и возвращает его. Используется вебхуком оплаты и лидами. */
export async function ensureUserByEmail(email: string) {
  const lower = email.toLowerCase();
  const existing = await findUserByEmail(lower);
  if (existing) return existing;
  const [created] = await db().insert(schema.users).values({ email: lower }).onConflictDoNothing().returning();
  if (created) {
    await db().insert(schema.usersMeta).values({ userId: created.id }).onConflictDoNothing();
    return created;
  }
  return (await findUserByEmail(lower))!;
}

/**
 * Одноразовая ссылка входа, совместимая с Auth.js (Nodemailer-провайдер):
 * в verification_tokens хранится sha256(token + AUTH_SECRET), как делает @auth/core.
 */
export async function createLoginLink(email: string, ttlSeconds: number, callbackPath = "/account"): Promise<string> {
  const e = env();
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const lower = email.toLowerCase();
  await db().insert(schema.verificationTokens).values({
    identifier: lower,
    token: hashAuthToken(token, e.AUTH_SECRET),
    expires: new Date(Date.now() + ttlSeconds * 1000),
  });
  const callbackUrl = `${e.PUBLIC_ORIGIN}${callbackPath}`;
  const url = `${e.PUBLIC_ORIGIN}/api/auth/callback/nodemailer?callbackUrl=${encodeURIComponent(callbackUrl)}&token=${token}&email=${encodeURIComponent(lower)}`;
  return `${e.PUBLIC_ORIGIN}/account/verify?u=${encodeURIComponent(url)}`;
}
