import type { ReactNode } from "react";

/** Секция лендинга: заголовок с якорем, подзаголовок, контент. */
export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className = "",
}: {
  id: string;
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`wrap scroll-mt-20 pt-14 ${className}`} aria-labelledby={`${id}-h`}>
      {eyebrow ? <p className="eyebrow m-0 mb-2">{eyebrow}</p> : null}
      <h2 id={`${id}-h`} className="m-0 text-[clamp(20px,3vw,26px)] font-semibold tracking-tight">
        {title}
      </h2>
      {lead ? <div className="mt-3 max-w-[72ch] text-[16px] text-mute">{lead}</div> : null}
      <div className="mt-6">{children}</div>
    </section>
  );
}

export function Badge({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "mute" | "ok" | "warn" }) {
  const cls =
    tone === "ok"
      ? "bg-ok-bg text-ok"
      : tone === "warn"
        ? "bg-warn-bg text-warn"
        : tone === "mute"
          ? "bg-code text-mute"
          : "bg-accent-soft text-accent";
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold uppercase tracking-wider ${cls}`}>{children}</span>;
}
