const DEFAULT_YM_COUNTER_ID = 114262096;

/** Тонкая обёртка над gtag и Яндекс.Метрикой: события отправляются, только если теги уже загружены. */
declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    ym?: (id: number, method: string, ...args: unknown[]) => void;
    __YM_COUNTER_ID?: number;
  }
}

export function track(event: string, params: Record<string, string | number | boolean | undefined> = {}): void {
  if (typeof window === "undefined") return;
  if (typeof window.gtag === "function") {
    try {
      window.gtag("event", event, params);
    } catch {
      // аналитика не должна ломать интерфейс
    }
  }
  if (typeof window.ym === "function") {
    try {
      const ymId = window.__YM_COUNTER_ID ?? DEFAULT_YM_COUNTER_ID;
      window.ym(ymId, "reachGoal", event, params);
    } catch {
      // аналитика не должна ломать интерфейс
    }
  }
}

/** utm_* из адреса страницы — передаются в checkout как источник оплаты. */
export function utmFromLocation(): Record<string, string> | undefined {
  if (typeof window === "undefined") return undefined;
  const out: Record<string, string> = {};
  const sp = new URLSearchParams(window.location.search);
  for (const [k, v] of sp) {
    if (/^utm_(source|medium|campaign|term|content)$/.test(k) && v) out[k] = v.slice(0, 200);
  }
  return Object.keys(out).length ? out : undefined;
}
