import { sql } from "@/lib/db/client";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await sql()`select 1`;
    return json({ ok: true, db: true });
  } catch (err) {
    return json({ ok: false, db: false, error: String((err as Error)?.message ?? err) }, { status: 503 });
  }
}
