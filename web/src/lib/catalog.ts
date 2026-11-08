import raw from "@/generated/services.json";

/** Каталог сервисов из services.yaml (генерируется src/generate.py). */

export type CatalogService = { name: string; pool: string; domains: string[] };
export type CatalogCategory = {
  id: string;
  name: string;
  tier: "free" | "pro";
  pool: string;
  services: CatalogService[];
};
export type PoolInfo = { note: string; fallback: string | null; strict_allowlist: boolean };
export type WorkerInfo = { ip: string; name: string; weight: number; pools: string[] };

export type Catalog = {
  meta: { name: string; origin: string };
  free: {
    domain: string;
    legacy_domains: string[];
    dns_ip: string;
    doh_url: string;
    dot_host: string;
    pools: Record<string, PoolInfo>;
    workers: WorkerInfo[];
  };
  pro: {
    domain: string;
    dns_ip: string;
    doh_url_template: string;
    dot_host_template: string;
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
