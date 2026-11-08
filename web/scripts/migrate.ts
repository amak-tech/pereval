/** Применяет миграции Drizzle при старте контейнера (без drizzle-kit в рантайме). */
import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "@/lib/db/client";

async function main() {
  const folder = existsSync("./migrations") ? "./migrations" : "./src/lib/db/migrations";
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await sql()`select 1`;
      break;
    } catch (err) {
      if (attempt === 30) throw err;
      console.log(`[migrate] БД недоступна (${attempt}/30): ${(err as Error)?.message ?? err} — жду…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await migrate(db(), { migrationsFolder: folder });
  console.log("[migrate] миграции применены");
  await sql().end({ timeout: 2 });
}

main().catch(async (err) => {
  console.error("[migrate] ошибка:", err);
  await sql().end({ timeout: 2 }).catch(() => undefined);
  process.exit(1);
});
