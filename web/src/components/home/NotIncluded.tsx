import type { Catalog } from "@/lib/catalog";

/** «Что не входит»: отключённые группы доменов и российские домены passthrough — свёрнуто в <details>. */
export function NotIncluded({ disabled, passthrough }: { disabled: Catalog["disabled"]; passthrough: Catalog["passthrough"] }) {
  return (
    <div className="grid gap-3">
      {disabled.map((g) => (
        <details key={g.name} className="group card !p-0 hover:border-line-strong open:border-line-strong">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15.5px] font-medium [&::-webkit-details-marker]:hidden">
            <span>
              {g.name} <span className="font-mono text-xs font-normal text-mute">· {g.domains.length}</span>
            </span>
            <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-bg font-mono text-sm text-mute transition-all group-open:rotate-45 group-open:border-accent/40 group-open:text-accent">
              +
            </span>
          </summary>
          <div className="border-t border-line/60 px-5 pb-5 pt-4">
            <p className="m-0 text-[15px] text-mute">{g.note}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {g.domains.map((d) => (
                <span key={d} className="chip line-through decoration-mute/60">
                  {d}
                </span>
              ))}
            </div>
          </div>
        </details>
      ))}
      <details className="group card !p-0 hover:border-line-strong open:border-line-strong">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15.5px] font-medium [&::-webkit-details-marker]:hidden">
          <span>
            Российские сервисы, которые идут напрямую <span className="font-mono text-xs font-normal text-mute">· {passthrough.domains.length}</span>
          </span>
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-bg font-mono text-sm text-mute transition-all group-open:rotate-45 group-open:border-accent/40 group-open:text-accent">
            +
          </span>
        </summary>
        <div className="border-t border-line/60 px-5 pb-5 pt-4">
          <p className="m-0 text-[15px] text-mute">{passthrough.note}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {passthrough.domains.map((d) => (
              <span key={d} className="chip">
                {d}
              </span>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}
