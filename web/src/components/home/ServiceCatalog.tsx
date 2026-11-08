"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Search } from "lucide-react";
import type { CatalogCategory } from "@/lib/catalog";

const MAX_DOMAINS = 4;

type Props = { categories: CatalogCategory[]; telegram: string };

// `?q=` из адреса: на сервере пусто, на клиенте — значение параметра (меняется только при навигации).
const noopSubscribe = () => () => {};
const readUrlQuery = () => (new URLSearchParams(window.location.search).get("q") ?? "").slice(0, 80);
const serverUrlQuery = () => "";

/**
 * Каталог сервисов с поиском и фильтром по категориям. Поддерживает `?q=` в адресе
 * (его же обещает SearchAction в JSON-LD): значение читается после гидратации,
 * чтобы весь каталог оставался в статическом HTML.
 */
export function ServiceCatalog({ categories, telegram }: Props) {
  const urlQ = useSyncExternalStore(noopSubscribe, readUrlQuery, serverUrlQuery);
  const [typed, setTyped] = useState<string | null>(null); // null — пользователь ещё не менял поле
  const q = typed ?? urlQ;
  const [cat, setCat] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (urlQ) rootRef.current?.scrollIntoView({ block: "start" });
  }, [urlQ]);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    return categories
      .filter((c) => cat === "all" || c.id === cat)
      .map((c) => ({
        ...c,
        services: c.services.filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.domains.some((d) => d.includes(needle))),
      }))
      .filter((c) => c.services.length > 0);
  }, [categories, cat, needle]);

  const shown = filtered.reduce((n, c) => n + c.services.length, 0);
  const total = categories.reduce((n, c) => n + c.services.length, 0);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div ref={rootRef} className="scroll-mt-20">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Поиск по сервисам и доменам</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Например: Claude, Cursor, JetBrains, mongodb.com"
            autoComplete="off"
            className="w-full rounded-lg border border-line bg-panel py-2.5 pl-9 pr-3 text-[15px] text-ink placeholder:text-mute focus:border-accent"
          />
        </label>
        <div role="group" aria-label="Категории" className="flex flex-wrap gap-1.5">
          <CatChip on={cat === "all"} onClick={() => setCat("all")}>
            Все ({total})
          </CatChip>
          {categories.map((c) => (
            <CatChip key={c.id} on={cat === c.id} onClick={() => setCat(c.id)}>
              {c.name} ({c.services.length})
            </CatChip>
          ))}
        </div>
      </div>

      <p className="mt-3 text-sm text-mute" aria-live="polite">
        {needle ? `Найдено: ${shown} из ${total}` : `${total} сервисов, все поддомены включены автоматически`}
      </p>

      {filtered.length === 0 ? (
        <div className="card mt-4 text-center">
          <p className="m-0 font-medium">Ничего не нашлось по запросу «{q}»</p>
          <p className="m-0 mt-2 text-sm text-mute">
            Если зарубежный сервис закрывает доступ по региону, но его нет в списке — предложите его в{" "}
            <a href={telegram} target="_blank" rel="noopener">
              Telegram-чате
            </a>
            .
          </p>
        </div>
      ) : (
        filtered.map((c) => (
          <section key={c.id} className="mt-6" aria-labelledby={`cat-${c.id}`}>
            <h3 id={`cat-${c.id}`} className="m-0 mb-3 text-[17px] font-semibold">
              {c.name} <span className="font-normal text-mute">· {c.services.length}</span>
            </h3>
            <ul className="grid list-none gap-2.5 p-0 sm:grid-cols-2">
              {c.services.map((s) => {
                const key = `${c.id}:${s.name}`;
                const open = expanded.has(key) || !!needle;
                const domains = open ? s.domains : s.domains.slice(0, MAX_DOMAINS);
                const rest = s.domains.length - domains.length;
                return (
                  <li key={key} className="rounded-[var(--radius-card)] border border-line bg-panel p-4">
                    <div className="font-semibold">{s.name}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {domains.map((d) => (
                        <span key={d} className="chip">
                          {d}
                        </span>
                      ))}
                      {rest > 0 ? (
                        <button type="button" onClick={() => toggle(key)} className="chip !bg-accent-soft !text-accent hover:underline" aria-expanded={false}>
                          ещё {rest}
                        </button>
                      ) : null}
                      {open && !needle && s.domains.length > MAX_DOMAINS ? (
                        <button type="button" onClick={() => toggle(key)} className="chip !bg-accent-soft !text-accent hover:underline" aria-expanded>
                          свернуть
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function CatChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${on ? "border-accent bg-accent-soft text-accent font-semibold" : "border-line bg-panel text-mute hover:text-ink"}`}
    >
      {children}
    </button>
  );
}
