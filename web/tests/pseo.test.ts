import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { allDeviceGuides, deviceGuideBySlug } from "@/content/pseo-devices";
import {
  allServicePages,
  relatedServicePages,
  servicePageBySlug,
  subProductDefinitions,
} from "@/content/pseo-services";
import { SITE } from "@/content/site";
import { catalog, serviceSlug } from "@/lib/catalog";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("Programmatic SEO — страницы сервисов (/services/[slug])", () => {
  it("генерирует валидные и уникальные посадочные страницы для всех сервисов из services.yaml", () => {
    const pages = allServicePages();
    const slugs = pages.map((p) => p.slug);
    const titles = pages.map((p) => p.title);
    const descriptions = pages.map((p) => p.description);
    const h1s = pages.map((p) => p.h1);

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    expect(new Set(h1s).size).toBe(h1s.length);

    for (const page of pages) {
      expect(page.slug).toMatch(SLUG_RE);
      expect(page.title.trim().length).toBeGreaterThan(10);
      expect(page.description.trim().length).toBeGreaterThan(20);
      expect(page.h1.trim().length).toBeGreaterThan(10);
      expect(page.lead.trim().length).toBeGreaterThan(20);
      expect(page.errorBadge.trim().length).toBeGreaterThan(0);
      expect(page.whyBlocked.trim().length).toBeGreaterThan(10);
      expect(page.howSolved.trim().length).toBeGreaterThan(10);
      expect(page.faq.length).toBeGreaterThanOrEqual(4);
      expect(page.priority).toBeGreaterThan(0);
      expect(page.priority).toBeLessThanOrEqual(1);
    }

    // Каждый опубликованный сервис из services.yaml обязан иметь страницу /services/<slug>
    for (const cat of catalog.categories) {
      for (const svc of cat.services) {
        const slug = serviceSlug(svc);
        const page = servicePageBySlug(slug);
        expect(page, `не найдена страница для сервиса ${svc.name} (${slug})`).toBeDefined();
        expect(page?.tier).toBe(cat.tier);
        expect(page?.categoryId).toBe(cat.id);
        expect(page?.pool).toBe(svc.pool);
        expect(page?.domains).toEqual(svc.domains);
        expect(page?.domains.length).toBeGreaterThan(0);
      }
    }
  });

  it("корректно публикует саб-продукты активных сервисов и скрывает саб-продукты неопубликованных родителей", () => {
    const pages = allServicePages();
    const subs = subProductDefinitions();
    const baseSlugs = new Set(catalog.categories.flatMap((c) => c.services.map((s) => serviceSlug(s))));

    const subSlugs = subs.map((s) => s.slug);
    expect(new Set(subSlugs).size).toBe(subSlugs.length);

    let activeSubCount = 0;
    for (const sub of subs) {
      expect(sub.slug).toMatch(SLUG_RE);
      expect(baseSlugs.has(sub.slug), `слаг саб-продукта ${sub.slug} конфликтует с базовым сервисом`).toBe(false);

      const page = servicePageBySlug(sub.slug);
      if (!baseSlugs.has(sub.parentSlug)) {
        // Родитель не опубликован (например, в pro.admin_services или удалён) — саб-продукт скрыт
        expect(page).toBeUndefined();
        continue;
      }

      activeSubCount += 1;
      const parent = servicePageBySlug(sub.parentSlug);
      expect(parent).toBeDefined();
      expect(page, `не создана страница саб-продукта ${sub.slug}`).toBeDefined();
      expect(page?.parentSlug).toBe(sub.parentSlug);
      expect(page?.tier).toBe(parent?.tier);
      expect(page?.categoryId).toBe(parent?.categoryId);
      expect(page?.pool).toBe(parent?.pool);
      expect(new Set(page?.domains)).toEqual(new Set(parent?.domains));

      const expectedPrefix = (sub.primaryDomains ?? []).filter((d) => parent?.domains.includes(d));
      expect(page?.domains.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
    }

    expect(pages.length).toBe(baseSlugs.size + activeSubCount);
  });

  it("ссылается только на существующие гайды устройств и релевантные соседние сервисы", () => {
    for (const page of allServicePages()) {
      expect(page.recommendedDevices.length).toBeGreaterThan(0);
      for (const devSlug of page.recommendedDevices) {
        expect(deviceGuideBySlug(devSlug), `битая ссылка на устройство ${devSlug} у сервиса ${page.slug}`).toBeDefined();
      }
      const related = relatedServicePages(page, 6);
      expect(related.every((r) => r.slug !== page.slug && r.slug !== page.parentSlug)).toBe(true);
      expect(related.every((r) => r.categoryId === page.categoryId)).toBe(true);
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
    const hasCatalogServices = allServicePages().length > 0;
    expect(guides.length).toBe(requiredDevices.length);

    for (const slug of requiredDevices) {
      const g = deviceGuideBySlug(slug);
      expect(g, `отсутствует инструкция /setup/${slug}`).toBeDefined();
      expect(g?.howToSteps.length).toBeGreaterThanOrEqual(3);
      expect(g?.faq.length).toBeGreaterThanOrEqual(1);
      expect(new Set(g?.popularServiceSlugs).size).toBe(g?.popularServiceSlugs.length);
      if (hasCatalogServices && (g?.popularServiceSlugs.length ?? 0) > 0) {
        const resolved = g!.popularServiceSlugs.filter((svcSlug) => Boolean(servicePageBySlug(svcSlug)));
        expect(resolved.length, `в гайде ${slug} не нашлось ни одного активного сервиса`).toBeGreaterThan(0);
      }
    }

    expect(deviceGuideBySlug("corporate-vpn")?.title).toContain("VPN");
    expect(deviceGuideBySlug("corporate-vpn")?.protocolBadge).toContain("update_hosts.py");
  });
});

describe("sitemap.ts — индексация всех pSEO-страниц", () => {
  it("включает статические разделы и все сгенерированные страницы сервисов и устройств без дублей URL", () => {
    const entries = sitemap();
    const urls = entries.map((e) => e.url);
    const urlSet = new Set(urls);

    expect(urlSet.size).toBe(urls.length);

    for (const staticPath of ["/", "/pro", "/dedicated", "/services", "/setup", "/stats", "/terms", "/privacy"]) {
      expect(urlSet.has(`${SITE.origin}${staticPath}`), `в sitemap отсутствует ${staticPath}`).toBe(true);
    }

    for (const page of allServicePages()) {
      expect(urlSet.has(`${SITE.origin}/services/${page.slug}`), `в sitemap нет /services/${page.slug}`).toBe(true);
    }

    for (const guide of allDeviceGuides()) {
      expect(urlSet.has(`${SITE.origin}/setup/${guide.slug}`), `в sitemap нет /setup/${guide.slug}`).toBe(true);
    }
  });
});
