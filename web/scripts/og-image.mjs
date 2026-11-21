// Рендерит public/og-image.png из scripts/og-image.svg с вшитыми шрифтами (в образе нет системных)
// и сохраняет версионированный URL с хэшем в src/generated/og-image.json для сброса кэша соцсетей/Telegram.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);
const fontFiles = [
  require.resolve("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"),
  require.resolve("@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf"),
  require.resolve("@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf"),
];

const publicDir = new URL("../public/", import.meta.url);
const generatedDir = new URL("../src/generated/", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("services.json", generatedDir), "utf8"));

// Русское склонение: 1 сервис, 2 сервиса, 5 сервисов
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const { free_services: services, free_categories: categories } = catalog.counts;
const values = {
  name: catalog.meta.name,
  ip: catalog.free.dns_ip,
  services: `${services} ${plural(services, "сервис", "сервиса", "сервисов")}`,
  categories: `${categories} ${plural(categories, "категория", "категории", "категорий")}`,
};
const escapeXml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svg = readFileSync(new URL("og-image.svg", import.meta.url), "utf8").replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in values)) throw new Error(`og-image.svg: неизвестный плейсхолдер {{${key}}}`);
  return escapeXml(values[key]);
});
const png = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  font: { loadSystemFonts: false, fontFiles, defaultFontFamily: "Inter" },
}).render().asPng();
writeFileSync(new URL("og-image.png", publicDir), png);

const hash = createHash("sha256").update(png).digest("hex").slice(0, 8);
const meta = { url: `/og-image.png?v=${hash}`, hash, width: 1200, height: 630 };
mkdirSync(generatedDir, { recursive: true });
writeFileSync(new URL("og-image.json", generatedDir), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`og-image.png: ${png.length} bytes (${meta.url})`);
