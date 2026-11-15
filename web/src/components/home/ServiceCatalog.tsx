"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/Section";
import { track } from "@/components/track";
import { filterCatalogCategories, type CatalogCategory } from "@/lib/catalog";

const MAX_DOMAINS = 4;

type Props = {
  categories: CatalogCategory[];
  proCategories?: CatalogCategory[];
  siteName?: string;
  telegram: string;
};

// `?q=` из адреса: на сервере пусто, на клиенте — значение параметра (меняется только при навигации).
const noopSubscribe = () => () => {};
const readUrlQuery = () => (new URLSearchParams(window.location.search).get("q") ?? "").slice(0, 80);
const serverUrlQuery = () => "";

/**
 * Каталог сервисов с поиском и фильтром по категориям. Поддерживает `?q=` в адресе
 * (его же обещает SearchAction в JSON-LD): значение читается после гидратации,
 * чтобы весь каталог оставался в статическом HTML.
 * При поиске также проверяет каталог Pro и показывает карточки с прямым переходом к подписке.
 */
export function ServiceCatalog({ categories, proCategories = [], siteName = "Перевал", telegram }: Props) {
  const urlQ = useSyncExternalStore(noopSubscribe, readUrlQuery, serverUrlQuery);
  const [typed, setTyped] = useState<string | null>(null); // null — пользователь ещё не менял поле
  const q = typed ?? urlQ;
  const [cat, setCat] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (urlQ) rootRef.current?.scrollIntoView({ block: "start" });
  }, [urlQ]);

  const needle = q.trim();
  const filtered = useMemo(() => filterCatalogCategories(categories, needle, cat), [categories, cat, needle]);
  const proFiltered = useMemo(
    () => (needle ? filterCatalogCategories(proCategories, needle, "all") : []),
    [proCategories, needle],
  );

  const shown = filtered.reduce((n, c) => n + c.services.length, 0);
  const shownPro = proFiltered.reduce((n, c) => n + c.services.length, 0);
  const total = categories.reduce((n, c) => n + c.services.length, 0);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const statusText = !needle
    ? `${total} сервисов, все поддомены включены автоматически`
    : shown > 0 && shownPro > 0
      ? `Найдено: ${shown} в Free и ${shownPro} в ${siteName} Pro`
      : shown === 0 && shownPro > 0
        ? `В бесплатный тариф не входит · найдено в ${siteName} Pro: ${shownPro}`
        : `Найдено: ${shown} из ${total}`;

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
            placeholder="Например: Claude, Cursor, Notion, Miro, Spotify, Xbox"
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
        {statusText}
      </p>

      {filtered.length === 0 && proFiltered.length === 0 ? (
        <div className="card mt-4 text-center">
          <p className="m-0 font-medium">Ничего не нашлось по запросу «{q}»</p>
          {cat !== "all" ? (
            <p className="m-0 mt-2 text-sm text-mute">
              Поиск ограничен выбранной категорией.{" "}
              <button type="button" onClick={() => setCat("all")} className="font-semibold text-accent hover:underline">
                Искать по всем категориям
              </button>
            </p>
          ) : null}
          <p className="m-0 mt-2 text-sm text-mute">
            Если зарубежный сервис закрывает доступ по региону, но его нет в списке — предложите его в{" "}
            <a href={telegram} target="_blank" rel="noopener">
              Telegram-чате
            </a>
            .
          </p>
        </div>
      ) : null}

      {filtered.map((c) => (
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
      ))}

      {proFiltered.length > 0 ? (
        <section className="mt-6 rounded-[var(--radius-card)] border border-accent bg-accent-soft p-4 sm:p-5" aria-labelledby="cat-pro-matches">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>Pro</Badge>
              <h3 id="cat-pro-matches" className="m-0 text-[17px] font-semibold">
                {shown === 0 ? `Работает в ${siteName} Pro` : `Также в ${siteName} Pro`} <span className="font-normal text-mute">· {shownPro}</span>
              </h3>
            </div>
            <Link
              href="/pro"
              onClick={() => track("pro_upsell_click", { source: "catalog_search_overview", query: needle.toLowerCase().slice(0, 60) })}
              className="text-sm font-semibold text-accent no-underline hover:underline"
            >
              Подробнее о тарифе Pro →
            </Link>
          </div>
          <p className="m-0 mt-1.5 text-sm text-mute">
            В подписке {siteName} Pro открыты рабочие сервисы, музыка, TikTok и игры на свободных серверах без вечерних просадок.
          </p>
          <ul className="m-0 mt-4 grid list-none gap-2.5 p-0 sm:grid-cols-2">
            {proFiltered.flatMap((c) =>
              c.services.map((s) => {
                const key = `pro:${c.id}:${s.name}`;
                return (
                  <li key={key} className="flex flex-col justify-between rounded-[var(--radius-card)] border border-line bg-panel p-4">
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold">{s.name}</div>
                          <div className="mt-0.5 text-xs text-mute">{c.name}</div>
                        </div>
                        <Badge>Pro</Badge>
                      </div>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {s.domains.map((d) => (
                          <span key={d} className="chip">
                            {d}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="mt-3.5 pt-1">
                      <Link
                        href="/pro#buy"
                        onClick={() =>
                          track("pro_upsell_click", {
                            source: "catalog_search",
                            service: s.name,
                            query: needle.toLowerCase().slice(0, 60),
                          })
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-accent-ink no-underline transition-opacity hover:opacity-90"
                      >
                        Доступно в {siteName} Pro → Подключить
                      </Link>
                    </div>
                  </li>
                );
              }),
            )}
          </ul>
        </section>
      ) : null}
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
