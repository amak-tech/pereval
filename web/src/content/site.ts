import { catalog } from "@/lib/catalog";

/** Общие константы сайта (название, домены, ссылки). Источник правды — services.yaml → services.json. */
export const SITE = {
  name: catalog.meta.name,
  origin: catalog.meta.origin,
  description:
    "Бесплатный Smart DNS без VPN: ChatGPT, Claude, Gemini, Cursor, JetBrains и ещё десятки сервисов открываются напрямую, а российские сайты и банки работают как обычно. Pro — Notion, Miro, Canva, Spotify, TikTok, игры и быстрые серверы.",
  free: catalog.free,
  pro: catalog.pro,
  counts: catalog.counts,
  telegram: "https://t.me/pereval_dns",
  github: "https://github.com/amak-tech/pereval",
  githubIssues: "https://github.com/amak-tech/pereval/issues",
  portbuddy: "https://portbuddy.dev/?utm_source=pereval&utm_medium=referral&utm_campaign=portbuddy",
  supportEmail: "support@pereval.top",
  /** Уведомления о нарушениях принимает команда Port Buddy — отдельный ящик, не связанный со старым доменом сайта. */
  abuseEmail: "abuse@portbuddy.dev",
  /** Профиль Apple (DNS-over-TLS) для бесплатной версии — маршрут src/app/dns.mobileconfig. */
  appleProfilePath: "/dns.mobileconfig",
  /** Дата редакции правовых документов (ISO). */
  legalUpdated: "2026-11-09",
} as const;

export const NAV = [
  { href: "/", label: "Free" },
  { href: "/pro", label: "Pro" },
  { href: "/dedicated", label: "Dedicated" },
  { href: "/stats", label: "Статистика" },
] as const;

/** Формат даты по-русски для «Редакция от …». */
export function formatRuDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}
