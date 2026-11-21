import type { FaqItem } from "@/content/faq";

/** FAQ-аккордеон + JSON-LD FAQPage из тех же данных (разъехаться им негде). */
export function Faq({ items, id = "faq", title = "Частые вопросы" }: { items: FaqItem[]; id?: string; title?: string }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.q,
      acceptedAnswer: { "@type": "Answer", text: i.aText ?? stripTags(i.a) },
    })),
  };
  return (
    <section id={id} className="wrap scroll-mt-24 pt-16 sm:pt-24" aria-labelledby={`${id}-h`}>
      <p className="eyebrow m-0 mb-3">FAQ</p>
      <h2 id={`${id}-h`} className="m-0 mb-7 text-[clamp(24px,3.6vw,34px)] font-semibold leading-[1.15] tracking-[-0.03em]">
        {title}
      </h2>
      <div className="grid gap-2.5">
        {items.map((i) => (
          <details key={i.q} className="group card !p-0 hover:border-line-strong open:border-line-strong">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15.5px] font-medium text-ink [&::-webkit-details-marker]:hidden">
              <span>{i.q}</span>
              <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-bg font-mono text-sm text-mute transition-all group-hover:border-line-strong group-hover:text-ink group-open:rotate-45 group-open:border-accent/40 group-open:text-accent">
                +
              </span>
            </summary>
            <div className="prose-pereval border-t border-line/60 px-5 pb-5 pt-4 text-mute [&_a]:text-accent" dangerouslySetInnerHTML={{ __html: i.a }} />
          </details>
        ))}
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </section>
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
