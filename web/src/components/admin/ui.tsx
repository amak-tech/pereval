import Link from "next/link";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
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

export function Stat({ label, value, hint, tone, className = "" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "err"; className?: string }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "err" ? "text-err" : "";
  return (
    <div className={`min-w-0 rounded-lg border border-line bg-bg px-3 py-2 ${className}`}>
      <div className="text-xs text-mute">{label}</div>
      <div className={`min-w-0 break-words text-lg font-semibold sm:text-xl ${color}`}>{value}</div>
      {hint ? <div className="min-w-0 break-words text-xs text-mute">{hint}</div> : null}
    </div>
  );
}

export function Card({ title, children, actions, id }: { title: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="card min-w-0" id={id}>
      <div className="flex flex-wrap items-center justify-between gap-2.5 sm:gap-3">
        <h2 className="m-0 min-w-0 break-words text-base font-semibold sm:text-lg">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="mt-4 min-w-0">{children}</div>
    </section>
  );
}

type CellElementProps = { className?: string; children?: ReactNode };

/**
 * Адаптивная таблица админ-панели:
 * - < md (смартфоны): компактные карточки в 2 колонки с подписями полей из `head` (без горизонтального скролла и сжатия колонок).
 * - ≥ md (планшеты/десктоп): классическая таблица с плавным горизонтальным скроллом при нехватке ширины.
 */
export function Table({ head, children, empty = "Пусто" }: { head: ReactNode[]; children?: ReactNode; empty?: string }) {
  const rawRows = Children.toArray(children).filter(Boolean);
  if (!rawRows.length) return <p className="m-0 text-sm text-mute">{empty}</p>;

  const enhancedRows = rawRows.map((row) => {
    if (!isValidElement<CellElementProps>(row)) return row;
    let colIndex = 0;
    const cells = Children.map(row.props.children, (cell) => {
      if (!isValidElement<CellElementProps>(cell)) return cell;
      const idx = colIndex++;
      const label = head[idx];
      const hasLabel = label !== "" && label !== null && label !== undefined;
      const isEmpty = Children.toArray(cell.props.children).length === 0;
      const mobileCellCls = isEmpty
        ? "max-md:hidden"
        : idx === 0
          ? "max-md:col-span-2 max-md:border-b max-md:border-line/80 max-md:pb-2"
          : !hasLabel
            ? "max-md:col-span-2 max-md:border-t max-md:border-line/80 max-md:pt-2.5"
            : "max-md:has-[details[open]]:col-span-2";
      const existingCls = cell.props.className ?? "";
      return cloneElement(cell as ReactElement<CellElementProps>, {
        className: `min-w-0 max-md:!whitespace-normal ${mobileCellCls} ${existingCls}`.trim(),
        children: (
          <>
            {hasLabel ? (
              <span className="mb-0.5 block font-mono text-[10px] font-medium uppercase tracking-wider text-mute md:hidden">
                {label}
              </span>
            ) : null}
            <div className="min-w-0 break-words md:contents">{cell.props.children}</div>
          </>
        ),
      });
    });
    const rowCls = row.props.className ?? "";
    return cloneElement(row as ReactElement<CellElementProps>, {
      className: `grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl border border-line bg-bg/65 p-3.5 md:table-row md:rounded-none md:border-0 md:border-b md:border-line md:bg-transparent md:p-0 md:last:border-0 ${rowCls}`.trim(),
      children: cells,
    });
  });

  return (
    <div className="md:-mx-6 md:overflow-x-auto md:px-6">
      <table className="block w-full border-collapse text-[13px] md:table md:[&_a]:[overflow-wrap:normal]">
        <thead className="hidden md:table-header-group">
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-mute">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-2 font-semibold first:pl-0 last:pr-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="grid grid-cols-1 gap-3 md:table-row-group md:[&_td]:px-2 md:[&_td]:py-2 md:[&_td]:align-top md:[&_td:first-child]:pl-0 md:[&_td:last-child]:pr-0">
          {enhancedRows}
        </tbody>
      </table>
    </div>
  );
}

export function Mono({ children, className = "", nowrap = false }: { children?: ReactNode; className?: string; nowrap?: boolean }) {
  return <span className={`font-mono text-[12.5px] ${nowrap ? "break-words md:whitespace-nowrap" : "break-all"} ${className}`}>{children}</span>;
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
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm sm:justify-start" aria-label="Страницы">
      {page > 1 ? <Link href={href(page - 1)} className="py-1">← Назад</Link> : <span className="py-1 text-mute">← Назад</span>}
      <span className="text-xs text-mute sm:text-sm">
        {page} / {pages} · всего {fmtN(total)}
      </span>
      {page < pages ? <Link href={href(page + 1)} className="py-1">Вперёд →</Link> : <span className="py-1 text-mute">Вперёд →</span>}
    </nav>
  );
}

export function JsonDetails({ summary, value }: { summary: string; value: unknown }) {
  return (
    <details className="min-w-0 text-xs">
      <summary className="cursor-pointer select-none text-accent">{summary}</summary>
      <pre className="mt-1.5 max-h-72 max-w-full overflow-auto rounded-md bg-code p-2 text-left text-[11.5px] leading-snug">{JSON.stringify(value, null, 2)}</pre>
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
