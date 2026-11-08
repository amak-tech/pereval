/**
 * Простой in-memory rate limiter (скользящее окно). Процесс один (uvicorn-подобный
 * single worker), поэтому общая карта в памяти достаточна; грубая защита на уровне
 * nginx (limit_req) дублирует это снаружи.
 */
type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (b.hits.length === 0 || (b.hits[b.hits.length - 1] ?? 0) < now - 3_600_000) {
      buckets.delete(key);
    }
  }
}

/** true = разрешено; false = превышен лимит `max` событий за `windowMs`. */
export function allow(key: string, max: number, windowMs: number, now: number = Date.now()): boolean {
  sweep(now);
  const b = buckets.get(key) ?? { hits: [] };
  b.hits = b.hits.filter((t) => t > now - windowMs);
  if (b.hits.length >= max) {
    buckets.set(key, b);
    return false;
  }
  b.hits.push(now);
  buckets.set(key, b);
  return true;
}

/** Остаток cooldown в секундах для ключа (0 — можно). */
export function cooldownLeft(key: string, cooldownMs: number, now: number = Date.now()): number {
  const b = buckets.get(key);
  const last = b?.hits[b.hits.length - 1];
  if (!last) return 0;
  const left = last + cooldownMs - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export function touch(key: string, now: number = Date.now()): void {
  const b = buckets.get(key) ?? { hits: [] };
  b.hits.push(now);
  buckets.set(key, b);
}

/** Для тестов. */
export function resetRateLimits(): void {
  buckets.clear();
}
