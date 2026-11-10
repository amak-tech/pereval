"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CopyField } from "@/components/CopyButton";
import type { AdminAction, AdminActionResult } from "@/lib/admin-actions";
import { NODE_KINDS } from "@/lib/admin-constants";

/** Клиентские действия админ-панели: один POST /api/admin/action, после успеха — router.refresh(). */

async function callAction(input: AdminAction): Promise<AdminActionResult> {
  const res = await fetch("/api/admin/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as Partial<AdminActionResult> & { ok?: boolean; message?: string };
  if (!res.ok || data.ok === false) throw new Error(data.message || `Ошибка ${res.status}`);
  return { message: data.message ?? "Готово.", reveal: data.reveal };
}

function useAdminAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(input: AdminAction) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await callAction(input);
      setResult(r);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, result, error, run, reset: () => setResult(null) };
}

function Outcome({ result, error }: { result: AdminActionResult | null; error: string | null }) {
  if (error) return <div className="mt-2 rounded-lg border border-err bg-err-bg px-3 py-2 text-sm text-err" role="alert">{error}</div>;
  if (!result) return null;
  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-ok bg-ok-bg px-3 py-2 text-sm" role="status">
      <span className="text-ok">{result.message}</span>
      {result.reveal ? <CopyField label={result.reveal.label} value={result.reveal.value} /> : null}
    </div>
  );
}

export function ActionButton({
  action,
  children,
  confirm,
  variant = "secondary",
  small = true,
  className = "",
}: {
  action: AdminAction;
  children: ReactNode;
  confirm?: string;
  variant?: "primary" | "secondary" | "danger";
  small?: boolean;
  className?: string;
}) {
  const a = useAdminAction();
  const base = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-secondary !border-err !text-err" : "btn-secondary";
  const size = small ? "!px-3 !py-1.5 !text-xs" : "";
  return (
    <div className={className}>
      <button
        type="button"
        className={`${base} ${size}`}
        disabled={a.busy}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          void a.run(action);
        }}
      >
        {children}
      </button>
      <Outcome result={a.result} error={a.error} />
    </div>
  );
}

const input = "rounded-lg border border-line bg-bg px-3 py-1.5 text-sm text-ink outline-none focus:border-accent";

export function GrantForm({ userId }: { userId: string }) {
  const a = useAdminAction();
  const [days, setDays] = useState("30");
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run({ action: "user.grant", userId, days: Number(days) });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          Дней
          <input type="number" min={1} max={3660} value={days} onChange={(e) => setDays(e.target.value)} className={`${input} w-24`} />
        </label>
        <button type="submit" className="btn-primary !px-3 !py-1.5 !text-xs" disabled={a.busy}>
          Выдать / продлить доступ
        </button>
        <span className="text-xs text-mute">30 дней = календарный месяц; срок добавляется к текущему, если он не истёк.</span>
      </div>
      <Outcome result={a.result} error={a.error} />
    </form>
  );
}

export function AddNodeForm() {
  const a = useAdminAction();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("pro_worker");
  const [ip, setIp] = useState("");
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run({ action: "node.add", name: name.trim(), kind, ip: ip.trim() || undefined });
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs text-mute">
          Имя
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="pro-worker-2" required className={`${input} w-40`} />
        </label>
        <label className="grid gap-1 text-xs text-mute">
          Тип
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${input} w-40`}>
            {NODE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-mute">
          IP (необязательно)
          <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.10" className={`${input} w-40`} />
        </label>
        <button type="submit" className="btn-primary !px-3 !py-1.5 !text-xs" disabled={a.busy}>
          Зарегистрировать ноду
        </button>
      </div>
      <Outcome result={a.result} error={a.error} />
    </form>
  );
}
