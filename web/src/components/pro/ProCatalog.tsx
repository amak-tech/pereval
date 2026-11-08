import { Clapperboard, Gamepad2, Layers, MessageCircle, Sparkles } from "lucide-react";
import { poolLabel, type CatalogCategory } from "@/lib/catalog";

const ICONS: Record<string, typeof Sparkles> = {
  media: Clapperboard,
  social: MessageCircle,
  apps: Layers,
  games: Gamepad2,
};

/** Карточки Pro-категорий: сервисы как чипы (домены — в title), пул как «локация». */
export function ProCatalog({ categories }: { categories: CatalogCategory[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {categories.map((c) => {
        const Icon = ICONS[c.id] ?? Sparkles;
        const domainCount = c.services.reduce((n, s) => n + s.domains.length, 0);
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
              {c.services.map((s) => (
                <li key={s.name}>
                  <span
                    className="chip cursor-help !font-sans !text-[13px]"
                    title={`${s.domains.join(", ")} · ${poolLabel(s.pool)}`}
                    tabIndex={0}
                    aria-label={`${s.name}: ${s.domains.join(", ")}; ${poolLabel(s.pool)}`}
                  >
                    {s.name}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </div>
  );
}
