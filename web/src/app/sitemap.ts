import type { MetadataRoute } from "next";
import { SITE } from "@/content/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const legal = new Date(SITE.legalUpdated);
  const page = (path: string, lastModified: Date, changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"], priority: number) => ({
    url: `${SITE.origin}${path}`,
    lastModified,
    changeFrequency,
    priority,
  });
  return [
    page("/", now, "weekly", 1),
    page("/pro", now, "weekly", 0.9),
    page("/dedicated", now, "monthly", 0.7),
    page("/stats", now, "hourly", 0.4),
    page("/terms", legal, "yearly", 0.3),
    page("/privacy", legal, "yearly", 0.3),
  ];
}
