const full = new Intl.NumberFormat("ru-RU");
const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });

/** Числа: до 10 000 — полностью, дальше компактно (12,9 тыс.). */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n >= 10_000 ? compact.format(n) : full.format(n);
}

const UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ"];

export function fmtBytes(b: number | null | undefined): string {
  if (b == null || Number.isNaN(b)) return "—";
  let v = b;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${UNITS[i]}`;
}

export function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function fmtHour(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function fmtAgo(seconds: number): string {
  if (seconds < 5) return "только что";
  if (seconds < 60) return `${Math.round(seconds)} с назад`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return `${h} ч назад`;
}
