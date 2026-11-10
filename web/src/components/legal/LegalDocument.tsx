import type { ReactNode } from "react";
import type { LegalSection } from "@/content/legal";

/** Правовой документ: заголовок, предупреждение, оглавление (липкое на десктопе) и разделы. */
export function LegalDocument({ title, lead, intro, sections, after }: { title: string; lead: ReactNode; intro?: ReactNode; sections: LegalSection[]; after?: ReactNode }) {
  return (
    <div className="wrap py-10 sm:py-14">
      <p className="eyebrow m-0 mb-2">Правовая информация</p>
      <h1 className="m-0 text-[clamp(26px,5vw,36px)] font-semibold tracking-tight">{title}</h1>
      <div className="mt-3 max-w-[72ch] text-[16px] text-mute">{lead}</div>
      <div className="mt-8 grid gap-8 lg:grid-cols-[240px_1fr] lg:gap-12">
        <nav aria-label="Содержание" className="lg:sticky lg:top-20 lg:self-start">
          <details className="card !p-0 lg:hidden" open={false}>
            <summary className="cursor-pointer list-none px-5 py-3 font-semibold [&::-webkit-details-marker]:hidden">Содержание</summary>
            <TocList sections={sections} className="px-5 pb-4" />
          </details>
          <div className="hidden lg:block">
            <p className="m-0 mb-2 text-xs font-semibold uppercase tracking-wider text-mute">Содержание</p>
            <TocList sections={sections} />
          </div>
        </nav>
        <article className="prose-pereval min-w-0 [&_code]:rounded [&_code]:bg-code [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.92em]">
          {intro ? (
            <div className="note [&_p]:m-0" role="note">
              {intro}
            </div>
          ) : null}
          {sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="scroll-mt-20">
              <h2 id={`${s.id}-h`}>{s.title}</h2>
              {s.body}
            </section>
          ))}
          {after}
        </article>
      </div>
    </div>
  );
}

function TocList({ sections, className = "" }: { sections: LegalSection[]; className?: string }) {
  return (
    <ol className={`m-0 grid list-none gap-1 p-0 text-sm ${className}`}>
      {sections.map((s) => (
        <li key={s.id}>
          <a href={`#${s.id}`} className="block rounded-md px-2 py-1 text-mute no-underline hover:bg-code hover:text-ink">
            {s.title}
          </a>
        </li>
      ))}
    </ol>
  );
}
