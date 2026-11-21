import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_OPEN_GRAPH, OG_IMAGE, pageOpenGraph } from "@/lib/metadata";

describe("og-image and Open Graph metadata", () => {
  it("не публикует сырой шаблон og-image.svg в public/ и генерирует валидный PNG", () => {
    expect(existsSync(new URL("../public/og-image.svg", import.meta.url))).toBe(false);
    const pngPath = new URL("../public/og-image.png", import.meta.url);
    expect(existsSync(pngPath)).toBe(true);
    const png = readFileSync(pngPath);
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(10_000);
  });

  it("версионирует URL og-image.png хэшем для сброса кэша соцсетей и Telegram", () => {
    expect(OG_IMAGE.url).toMatch(/^\/og-image\.png\?v=[0-9a-f]{8}$/);
    expect(OG_IMAGE.width).toBe(1200);
    expect(OG_IMAGE.height).toBe(630);
  });

  it("pageOpenGraph сохраняет images, siteName, locale и type при переопределении полей страницы", () => {
    const og = pageOpenGraph({ url: "/pro", title: "Pro", description: "Desc" });
    expect(og.images).toEqual(DEFAULT_OPEN_GRAPH.images);
    expect(og.siteName).toBe(DEFAULT_OPEN_GRAPH.siteName);
    expect(og.locale).toBe("ru_RU");
    expect(og.url).toBe("/pro");
    expect(og.title).toBe("Pro");
    expect(og.description).toBe("Desc");
  });

  it("pageOpenGraph позволяет переопределять type без потери images", () => {
    const og = pageOpenGraph({ url: "/terms", type: "article", title: "Terms", description: "Desc" });
    expect((og as { type?: string }).type).toBe("article");
    expect(og.images).toEqual(DEFAULT_OPEN_GRAPH.images);
  });
});
