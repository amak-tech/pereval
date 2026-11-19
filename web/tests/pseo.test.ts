import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { allDeviceGuides, deviceGuideBySlug } from "@/content/pseo-devices";
import { allServicePages, relatedServicePages, servicePageBySlug } from "@/content/pseo-services";
import { catalog, serviceSlug } from "@/lib/catalog";

describe("Programmatic SEO — страницы сервисов (/services/[slug])", () => {
  it("генерирует уникальные посадочные страницы для всех сервисов из services.yaml и целевых саб-продуктов", () => {
    const pages = allServicePages();
    const totalInCatalog = catalog.categories.reduce((acc, c) => acc + c.services.length, 0);
    expect(pages.length).toBeGreaterThanOrEqual(totalInCatalog + 8);

    const slugs = pages.map((p) => p.slug);
    const titles = pages.map((p) => p.title);
    const h1s = pages.map((p) => p.h1);

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(h1s).size).toBe(h1s.length);

    // Каждый сервис из services.yaml обязан иметь резолвящуюся страницу /services/<slug>
    for (const cat of catalog.categories) {
      for (const svc of cat.services) {
        const slug = serviceSlug(svc);
        const page = servicePageBySlug(slug);
        expect(page, `не найдена страница для сервиса ${svc.name} (${slug})`).toBeDefined();
        expect(page?.tier).toBe(cat.tier);
        expect(page?.domains.length).toBeGreaterThan(0);
      }
    }
  });

  it("покрывает все ключевые поисковые интенты (chatgpt, claude, cursor, notion, miro, spotify, xbox, brawl-stars, coda, autodesk)", () => {
    const requiredFree = [
      "chatgpt",
      "claude",
      "cursor",
      "gemini",
      "google-flow",
      "google-antigravity",
      "notebooklm",
      "jetbrains",
      "terraform",
      "hume-ai",
      "moltbook",
      "intel",
      "cisco",
      "netacad",
      "triage",
    ];
    const requiredPro = ["notion", "miro", "spotify", "xbox", "brawl-stars", "coda", "autodesk", "semrush", "elevenlabs", "home-connect", "dyson", "playstation", "lucidspark"];

    for (const slug of requiredFree) {
      const p = servicePageBySlug(slug);
      expect(p, `отсутствует Free-страница /services/${slug}`).toBeDefined();
      expect(p?.tier).toBe("free");
      expect(p?.faq.length).toBeGreaterThanOrEqual(4);
    }

    for (const slug of requiredPro) {
      const p = servicePageBySlug(slug);
      expect(p, `отсутствует Pro-страница /services/${slug}`).toBeDefined();
      expect(p?.tier).toBe("pro");
      expect(p?.faq.length).toBeGreaterThanOrEqual(4);
    }

    expect(servicePageBySlug("xbox")?.h1).toContain("0x80a40401");
    expect(servicePageBySlug("brawl-stars")?.domains[0]).toBe("brawlstarsgame.com");
  });

  it("ссылается только на существующие гайды устройств и соседние сервисы", () => {
    for (const page of allServicePages()) {
      expect(page.recommendedDevices.length).toBeGreaterThan(0);
      for (const devSlug of page.recommendedDevices) {
        expect(deviceGuideBySlug(devSlug), `битая ссылка на устройство ${devSlug} у сервиса ${page.slug}`).toBeDefined();
      }
      const related = relatedServicePages(page, 6);
      expect(related.every((r) => r.slug !== page.slug)).toBe(true);
    }
  });
});

describe("Programmatic SEO — страницы устройств и роутеров (/setup/[device])", () => {
  it("содержит все целевые платформы, роутеры, консоли и корпоративный VPN (update_hosts.py)", () => {
    const requiredDevices = [
      "iphone",
      "android",
      "windows-11",
      "macos",
      "linux",
      "browsers",
      "keenetic",
      "mikrotik",
      "openwrt",
      "xbox",
      "playstation",
      "corporate-vpn",
    ];

    const guides = allDeviceGuides();
    expect(guides.length).toBe(requiredDevices.length);

    for (const slug of requiredDevices) {
      const g = deviceGuideBySlug(slug);
      expect(g, `отсутствует инструкция /setup/${slug}`).toBeDefined();
      expect(g?.howToSteps.length).toBeGreaterThanOrEqual(3);
      expect(g?.faq.length).toBeGreaterThanOrEqual(1);
      for (const svcSlug of g?.popularServiceSlugs ?? []) {
        expect(servicePageBySlug(svcSlug), `битая ссылка на сервис ${svcSlug} в гайде ${slug}`).toBeDefined();
      }
    }

    expect(deviceGuideBySlug("corporate-vpn")?.title).toContain("VPN");
    expect(deviceGuideBySlug("corporate-vpn")?.protocolBadge).toContain("update_hosts.py");
  });
});

describe("sitemap.ts — индексация всех pSEO-страниц", () => {
  it("включает разделы /services, /setup и все сгенерированные страницы без дублей URL", () => {
    const entries = sitemap();
    const urls = entries.map((e) => e.url);

    expect(new Set(urls).size).toBe(urls.length);
    expect(entries.length).toBeGreaterThanOrEqual(105);

    expect(urls).toContain("https://pereval.top/services");
    expect(urls).toContain("https://pereval.top/setup");
    expect(urls).toContain("https://pereval.top/services/miro");
    expect(urls).toContain("https://pereval.top/services/xbox");
    expect(urls).toContain("https://pereval.top/services/brawl-stars");
    expect(urls).toContain("https://pereval.top/setup/keenetic");
    expect(urls).toContain("https://pereval.top/setup/corporate-vpn");
  });
});
