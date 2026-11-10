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
    <section id={id} className="wrap scroll-mt-20" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="mb-4 mt-16 text-[clamp(20px,3vw,24px)] font-semibold tracking-tight">
        {title}
      </h2>
      <div className="grid gap-2.5">
        {items.map((i) => (
          <details key={i.q} className="group card !p-0">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-semibold [&::-webkit-details-marker]:hidden">
              <span>{i.q}</span>
              <span aria-hidden className="text-mute transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <div className="prose-pereval px-5 pb-5 text-mute [&_a]:text-accent" dangerouslySetInnerHTML={{ __html: i.a }} />
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
