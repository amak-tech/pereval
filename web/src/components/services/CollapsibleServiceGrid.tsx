"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/Section";

export type ServiceGridItem = {
  slug: string;
  shortName: string;
  primaryDomain: string;
  summary: string;
};

type Props = {
  id: string;
  items: ServiceGridItem[];
  variant: "pro" | "free";
  initialCount?: number;
};

/** Сетка карточек сервисов с компактным показом первых N штук и кнопкой «Показать все». */
export function CollapsibleServiceGrid({ id, items, variant, initialCount = 6 }: Props) {
  const [open, setOpen] = useState(false);
  const hasMore = items.length > initialCount;
  const hiddenCount = items.length - initialCount;
  const gridId = `services-grid-${id}`;

  return (
    <div>
      <div
        id={gridId}
        className={variant === "pro" ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" : "grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"}
      >
        {items.map((item, idx) => {
          const isHidden = !open && idx >= initialCount;
          if (variant === "pro") {
            return (
              <Link
                key={item.slug}
                href={`/services/${item.slug}`}
                className={`card group flex flex-col justify-between no-underline transition-colors hover:border-accent${isHidden ? " hidden" : ""}`}
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold text-ink group-hover:text-accent">{item.shortName}</span>
                    <Badge>Pro</Badge>
                  </div>
                  <p className="m-0 mt-1.5 line-clamp-2 text-sm text-mute">{item.summary}</p>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-mute">
                  <span className="font-mono">{item.primaryDomain}</span>
                  <span className="font-medium text-accent">Открыть инструкцию →</span>
                </div>
              </Link>
            );
          }

          return (
            <Link
              key={item.slug}
              href={`/services/${item.slug}`}
              className={`rounded-[var(--radius-card)] border border-line bg-panel p-4 no-underline transition-colors hover:border-accent${isHidden ? " hidden" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">{item.shortName}</span>
                <span className="font-mono text-xs text-mute">{item.primaryDomain}</span>
              </div>
              <p className="m-0 mt-1.5 line-clamp-2 text-xs text-mute">{item.summary}</p>
            </Link>
          );
        })}
      </div>

      {hasMore ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={gridId}
            className="btn-secondary !py-2 !text-sm"
          >
            {open ? (
              <>
                Свернуть <ChevronUp className="h-4 w-4" aria-hidden />
              </>
            ) : (
              <>
                Показать все ({items.length})
                <span className="font-normal text-mute">· ещё {hiddenCount}</span>
                <ChevronDown className="h-4 w-4" aria-hidden />
              </>
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}
