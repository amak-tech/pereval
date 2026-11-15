import raw from "@/generated/services.json";

/** Каталог сервисов из services.yaml (генерируется src/generate.py). */

export type CatalogService = {
  name: string;
  slug?: string;
  pool: string;
  note?: string;
  domains: string[];
};
export type CatalogCategory = {
  id: string;
  name: string;
  tier: "free" | "pro";
  pool: string;
  services: CatalogService[];
};
export type PoolInfo = { note: string; fallback: string | null; strict_allowlist: boolean; max_clients?: number | null };
export type WorkerInfo = { ip: string; name: string; weight: number; pools: string[]; max_clients?: number | null };

export type Catalog = {
  /** cert_domains — имена единого wildcard-сертификата инфраструктуры */
  meta: { name: string; origin: string; cert_domains: string[] };
  free: {
    domain: string;
    legacy_domains: string[];
    dns_ip: string;
    doh_url: string;
    dot_host: string;
    max_clients?: number | null;
    pools: Record<string, PoolInfo>;
    workers: WorkerInfo[];
  };
  pro: {
    domain: string;
    dns_ip: string;
    doh_url_template: string;
    dot_host_template: string;
    max_clients?: number | null;
    pools: Record<string, PoolInfo>;
    workers: WorkerInfo[];
  } | null;
  categories: CatalogCategory[];
  disabled: { name: string; note: string; domains: string[] }[];
  passthrough: { note: string; domains: string[] };
  counts: {
    free_categories: number;
    free_services: number;
    free_domains: number;
    pro_categories: number;
    pro_services: number;
    pro_domains: number;
  };
};

export const catalog = raw as unknown as Catalog;

export function freeCategories(): CatalogCategory[] {
  return catalog.categories.filter((c) => c.tier === "free");
}

export function proCategories(): CatalogCategory[] {
  return catalog.categories.filter((c) => c.tier === "pro");
}

export function categoryById(id: string): CatalogCategory | undefined {
  return catalog.categories.find((c) => c.id === id);
}

export function allCategoryIds(): string[] {
  return catalog.categories.map((c) => c.id);
}

/** Человекочитаемое имя пула («локация») для UI. */
export function poolLabel(pool: string): string {
  switch (pool) {
    case "ai":
      return "ИИ-пул (постоянный IP)";
    case "media":
      return "Медиа-пул (тяжёлый трафик)";
    case "default":
      return "Общий пул";
    default:
      return pool;
  }
}

export function totalServices(): number {
  return catalog.counts.free_services + catalog.counts.pro_services;
}

export function totalDomains(): number {
  return catalog.counts.free_domains + catalog.counts.pro_domains;
}

/** Человекочитаемый URL-слаг сервиса (совпадает с правилом в src/generate.py). */
export function slugifyServiceName(name: string): string {
  const base = name.split("(", 1)[0]?.trim() || name;
  const s = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "service";
}

export function serviceSlug(service: Pick<CatalogService, "name" | "slug">): string {
  return service.slug || slugifyServiceName(service.name);
}

/** Извлекает нормализованный хост из поисковой строки (поддерживает вставку полного URL или поддомена). */
export function normalizeSearchHost(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const slashIdx = s.indexOf("/");
  if (slashIdx !== -1) s = s.slice(0, slashIdx);
  const qIdx = s.indexOf("?");
  if (qIdx !== -1) s = s.slice(0, qIdx);
  const hashIdx = s.indexOf("#");
  if (hashIdx !== -1) s = s.slice(0, hashIdx);
  const colonIdx = s.indexOf(":");
  if (colonIdx !== -1) s = s.slice(0, colonIdx);
  return s.replace(/^\.+|\.+$/g, "");
}

/** Проверяет совпадение сервиса с поисковым запросом по названию, домену или любому поддомену/URL. */
export function matchesCatalogService(service: CatalogService, rawQuery: string): boolean {
  const needle = rawQuery.trim().toLowerCase();
  if (!needle) return true;
  if (service.name.toLowerCase().includes(needle)) return true;

  const hostNeedle = normalizeSearchHost(rawQuery);
  const hasDot = needle.includes(".");
  return service.domains.some((rawDomain) => {
    const d = rawDomain.toLowerCase();
    if (hostNeedle && (hostNeedle === d || hostNeedle.endsWith(`.${d}`))) {
      return true;
    }
    if (hasDot) {
      return d.includes(needle) || Boolean(hostNeedle && d.includes(hostNeedle));
    }
    return d.split(".").some((label) => label.startsWith(needle));
  });
}

/** Фильтрует список категорий по поисковому запросу и (опционально) выбранному id категории. */
export function filterCatalogCategories(
  categories: CatalogCategory[],
  rawQuery: string,
  categoryId = "all",
): CatalogCategory[] {
  const hasQuery = rawQuery.trim().length > 0;
  return categories
    .filter((c) => categoryId === "all" || c.id === categoryId)
    .map((c) => ({
      ...c,
      services: hasQuery ? c.services.filter((s) => matchesCatalogService(s, rawQuery)) : c.services,
    }))
    .filter((c) => c.services.length > 0);
}
