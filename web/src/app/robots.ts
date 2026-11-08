import type { MetadataRoute } from "next";
import { SITE } from "@/content/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/account", "/account/", "/api/", "/nic/"] }],
    sitemap: `${SITE.origin}/sitemap.xml`,
    host: SITE.origin,
  };
}
