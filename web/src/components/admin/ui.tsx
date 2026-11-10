import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/Section";
import { PAGE_SIZE } from "@/lib/admin";

/** Серверные кирпичики админ-панели: даты по МСК, таблицы, плитки, пагинация. */

const dt = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
const d = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", year: "numeric" });

export function fmtDt(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const x = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(x.getTime()) ? "—" : dt.format(x);
}

export function fmtD(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const x = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(x.getTime()) ? "—" : d.format(x);
}

export function fmtN(n: number): string {
  return n.toLocaleString("ru-RU");
}

/** «3 мин назад» для last_seen нод и активности. */
export function ago(v: Date | null | undefined, now: Date = new Date()): string {
  if (!v) return "никогда";
  const s = Math.max(0, Math.round((now.getTime() - v.getTime()) / 1000));
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export const SUB_STATUS: Record<string, { text: string; tone: "ok" | "warn" | "mute" | "accent" }> = {
  active: { text: "active", tone: "ok" },
  past_due: { text: "past_due", tone: "warn" },
  cancelled: { text: "cancelled", tone: "mute" },
  expired: { text: "expired", tone: "mute" },
  pending: { text: "pending", tone: "accent" },
};

export function SubStatus({ status }: { status: string | null }) {
  if (!status) return <Badge tone="mute">нет</Badge>;
  const s = SUB_STATUS[status] ?? { text: status, tone: "mute" as const };
  return <Badge tone={s.tone}>{s.text}</Badge>;
}

export function ModeBadge({ mode }: { mode: string }) {
  return <Badge tone={mode === "proxy" ? "ok" : mode === "deny" ? "warn" : "mute"}>{mode}</Badge>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "err" }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "err" ? "text-err" : "";
  return (
    <div className="rounded-lg border border-line bg-bg px-3 py-2">
      <div className="text-xs text-mute">{label}</div>
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      {hint ? <div className="text-xs text-mute">{hint}</div> : null}
    </div>
  );
}

export function Card({ title, children, actions, id }: { title: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-lg font-semibold">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Table({ head, children, empty = "Пусто" }: { head: ReactNode[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  if (!rows.length) return <p className="m-0 text-sm text-mute">{empty}</p>;
  return (
    <div className="-mx-5 overflow-x-auto px-5 sm:-mx-6 sm:px-6">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-mute">
            {head.map((h, i) => (
              <th key={i} className="px-2 py-2 font-semibold first:pl-0 last:pr-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:px-2 [&_td]:py-2 [&_td]:align-top [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_tr]:border-b [&_tr]:border-line [&_tr:last-child]:border-0">
          {rows}
        </tbody>
      </table>
    </div>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`break-all font-mono text-[12.5px] ${className}`}>{children}</span>;
}

/** Строка ?page=N с сохранением остальных параметров. */
export function Pager({ page, total, base, params, param = "page" }: { page: number; total: number; base: string; params?: Record<string, string | undefined>; param?: string }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v) sp.set(k, v);
    sp.set(param, String(p));
    return `${base}?${sp.toString()}`;
  };
  return (
    <nav className="mt-4 flex items-center gap-3 text-sm" aria-label="Страницы">
      {page > 1 ? <Link href={href(page - 1)}>← Назад</Link> : <span className="text-mute">← Назад</span>}
      <span className="text-mute">
        {page} / {pages} · всего {fmtN(total)}
      </span>
      {page < pages ? <Link href={href(page + 1)}>Вперёд →</Link> : <span className="text-mute">Вперёд →</span>}
    </nav>
  );
}

export function JsonDetails({ summary, value }: { summary: string; value: unknown }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-accent">{summary}</summary>
      <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-code p-2 text-[11.5px] leading-snug">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function pageNum(v: string | string[] | undefined): number {
  const n = Number(typeof v === "string" ? v : 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}
