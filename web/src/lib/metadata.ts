import type { Metadata } from "next";
import { SITE } from "@/content/site";
import ogImageMeta from "@/generated/og-image.json";

export const OG_IMAGE = {
  url: ogImageMeta.url,
  width: ogImageMeta.width,
  height: ogImageMeta.height,
  alt: `${SITE.name} — Smart DNS для доступа к ИИ-сервисам`,
} as const;

export const DEFAULT_OPEN_GRAPH: NonNullable<Metadata["openGraph"]> = {
  type: "website",
  siteName: SITE.name,
  locale: "ru_RU",
  images: [OG_IMAGE],
};

/**
 * Next.js делает shallow merge для metadata: если дочерняя страница задаёт `openGraph`,
 * она целиком затирает `openGraph` из `layout.tsx` (включая `images`, `siteName`, `locale`).
 * Хелпер сохраняет базовые поля на каждой странице.
 */
export function pageOpenGraph(overrides: NonNullable<Metadata["openGraph"]>): NonNullable<Metadata["openGraph"]> {
  return { ...DEFAULT_OPEN_GRAPH, ...overrides };
}
