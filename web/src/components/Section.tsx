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
    <section id={id} className={`wrap scroll-mt-24 pt-16 sm:pt-24 ${className}`} aria-labelledby={`${id}-h`}>
      {eyebrow ? <p className="eyebrow m-0 mb-3">{eyebrow}</p> : null}
      <h2 id={`${id}-h`} className="m-0 max-w-[28ch] text-[clamp(24px,3.6vw,34px)] font-semibold leading-[1.15] tracking-[-0.03em]">
        {title}
      </h2>
      {lead ? <div className="mt-3.5 max-w-[66ch] text-[16px] leading-relaxed text-mute">{lead}</div> : null}
      <div className="mt-8">{children}</div>
    </section>
  );
}

export function Badge({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "mute" | "ok" | "warn" }) {
  const cls =
    tone === "ok"
      ? "border-ok/25 bg-ok-bg text-ok"
      : tone === "warn"
        ? "border-warn/30 bg-warn-bg text-warn"
        : tone === "mute"
          ? "border-line bg-panel-elevated text-mute"
          : "border-accent/30 bg-accent-soft text-accent";
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.08em] ${cls}`}>{children}</span>;
}
