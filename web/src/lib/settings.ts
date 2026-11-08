import { eq, sql as dsql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/** Небольшое key/value хранилище в Postgres (версии политики/ACL, кеш цен и т. п.). */

export async function getSetting<T>(key: string): Promise<T | null> {
  const [row] = await db().select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db()
    .insert(schema.settings)
    .values({ key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: value as object, updatedAt: new Date() } });
}

/** Атомарный инкремент целочисленной настройки; возвращает новое значение. */
export async function incrementSetting(key: string): Promise<number> {
  const [row] = await db()
    .insert(schema.settings)
    .values({ key, value: 1, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: dsql`to_jsonb((${schema.settings.value})::text::int + 1)`, updatedAt: new Date() },
    })
    .returning({ value: schema.settings.value });
  return Number(row?.value ?? 1);
}

export async function getIntSetting(key: string, fallback = 1): Promise<number> {
  const v = await getSetting<unknown>(key);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
