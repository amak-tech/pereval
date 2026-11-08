import { json } from "@/lib/http";
import { catalog } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Серверный прокси к JSON статистики Free-кластера и здоровью Pro-ноды:
 * одна точка для страницы /stats и бейджа нагрузки на лендинге, кеш 5 с.
 */
type Cached = { at: number; data: unknown };
const cache = new Map<string, Cached>();

async function fetchJson(url: string): Promise<unknown> {
  const c = cache.get(url);
  if (c && Date.now() - c.at < 5_000) return c.data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } catch {
    return c?.data ?? null;
  }
}

export async function GET() {
  const freeBase = `https://${catalog.free.domain}`;
  const [stats, health, proHealth] = await Promise.all([
    fetchJson(`${freeBase}/stats.json`),
    fetchJson(`${freeBase}/cluster-health.json`),
    catalog.pro ? fetchJson(`https://${catalog.pro.domain}/pro-health.json`) : Promise.resolve(null),
  ]);
  return json({ ok: true, fetchedAt: new Date().toISOString(), stats, cluster: health, pro: proHealth }, { headers: { "Cache-Control": "public, max-age=5" } });
}
