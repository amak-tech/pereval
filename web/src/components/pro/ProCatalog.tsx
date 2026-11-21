"use client";

import Link from "next/link";
import { useState } from "react";
import { Briefcase, Car, Clapperboard, Gamepad2, Sparkles } from "lucide-react";
import { poolLabel, serviceSlug, type CatalogCategory } from "@/lib/catalog";

const INITIAL_CHIPS = 8;

const ICONS: Record<string, typeof Sparkles> = {
  media: Clapperboard,
  work: Briefcase,
  games: Gamepad2,
  auto: Car,
};

/** Карточки Pro-категорий: сервисы как чипы со ссылками на подробные страницы, пул как «локация». */
export function ProCatalog({ categories }: { categories: CatalogCategory[] }) {
  const [expandedCats, setExpandedCats] = useState<Set<string>>(() => new Set());

  function toggleCategory(id: string) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {categories.map((c) => {
        const Icon = ICONS[c.id] ?? Sparkles;
        const domainCount = c.services.reduce((n, s) => n + s.domains.length, 0);
        const hasMore = c.services.length > INITIAL_CHIPS;
        const catOpen = expandedCats.has(c.id);
        const hiddenCount = c.services.length - INITIAL_CHIPS;
        return (
          <article key={c.id} className="card" aria-labelledby={`pro-cat-${c.id}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 id={`pro-cat-${c.id}`} className="m-0 text-[17px] font-semibold">
                  {c.name}
                </h3>
              </div>
            </div>
            <p className="m-0 mt-3 text-sm text-mute">
              {c.services.length} сервисов · {domainCount} доменов · локация: <span className="text-ink">{poolLabel(c.pool)}</span>
            </p>
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0">
              {c.services.map((s, idx) => (
                <li key={s.name} className={!catOpen && idx >= INITIAL_CHIPS ? "hidden" : undefined}>
                  <Link
                    href={`/services/${serviceSlug(s)}`}
                    className="chip !font-sans !text-[13px] no-underline transition-colors hover:border-accent hover:text-accent"
                    title={`${s.domains.join(", ")} · ${poolLabel(s.pool)}`}
                    aria-label={`${s.name}: ${s.domains.join(", ")}; ${poolLabel(s.pool)}`}
                  >
                    {s.name}
                  </Link>
                </li>
              ))}
              {hasMore ? (
                <li>
                  <button
                    type="button"
                    onClick={() => toggleCategory(c.id)}
                    aria-expanded={catOpen}
                    className="chip !border-accent/25 !bg-accent-soft !font-sans !text-[13px] font-medium !text-accent transition-colors hover:border-accent"
                  >
                    {catOpen ? "Свернуть" : `Показать все (+${hiddenCount})`}
                  </button>
                </li>
              ) : null}
            </ul>
          </article>
        );
      })}
    </div>
  );
}
