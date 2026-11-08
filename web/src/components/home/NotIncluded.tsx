import type { Catalog } from "@/lib/catalog";

/** «Что не входит»: отключённые группы доменов и российские домены passthrough — свёрнуто в <details>. */
export function NotIncluded({ disabled, passthrough }: { disabled: Catalog["disabled"]; passthrough: Catalog["passthrough"] }) {
  return (
    <div className="grid gap-3">
      {disabled.map((g) => (
        <details key={g.name} className="card !p-0">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-semibold [&::-webkit-details-marker]:hidden">
            <span>
              {g.name} <span className="font-normal text-mute">· {g.domains.length}</span>
            </span>
            <span aria-hidden className="text-mute">
              +
            </span>
          </summary>
          <div className="px-5 pb-5">
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
      <details className="card !p-0">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-semibold [&::-webkit-details-marker]:hidden">
          <span>
            Российские сервисы, которые идут напрямую <span className="font-normal text-mute">· {passthrough.domains.length}</span>
          </span>
          <span aria-hidden className="text-mute">
            +
          </span>
        </summary>
        <div className="px-5 pb-5">
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
