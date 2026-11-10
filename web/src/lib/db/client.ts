import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "@/lib/env";

/**
 * Единственное подключение к Postgres на процесс. В dev Next.js перезагружает
 * модули при hot reload, поэтому экземпляр кладём в globalThis.
 */
type Db = ReturnType<typeof drizzle<typeof schema>>;

const g = globalThis as unknown as { __perevalSql?: ReturnType<typeof postgres>; __perevalDb?: Db };

export function sql(): ReturnType<typeof postgres> {
  if (!g.__perevalSql) {
    g.__perevalSql = postgres(env().DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return g.__perevalSql;
}

export function db(): Db {
  if (!g.__perevalDb) {
    g.__perevalDb = drizzle(sql(), { schema });
  }
  return g.__perevalDb;
}

export { schema };
