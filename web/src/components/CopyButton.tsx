"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({ value, label = "Скопировать", className = "" }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      // старые браузеры: выделить текст вручную
      window.prompt("Скопируйте значение:", value);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-panel-elevated px-3 py-1.5 font-mono text-[11.5px] font-medium text-ink transition-colors hover:border-accent/60 hover:text-accent ${className}`}
      aria-live="polite"
    >
      {done ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {done ? "Скопировано" : label}
    </button>
  );
}

/** Строка «значение + кнопка копирования» для IP, DoH, DoT. */
export function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bg px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-mute">{label}</div>
        <div className={`mt-0.5 break-all text-[14px] text-ink ${mono ? "font-mono" : ""}`}>{value}</div>
      </div>
      <CopyButton value={value} />
    </div>
  );
}
