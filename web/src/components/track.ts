/** Тонкая обёртка над gtag: события отправляются, только если тег GA уже загружен. */
declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export function track(event: string, params: Record<string, string | number | boolean | undefined> = {}): void {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  try {
    window.gtag("event", event, params);
  } catch {
    // аналитика не должна ломать интерфейс
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
