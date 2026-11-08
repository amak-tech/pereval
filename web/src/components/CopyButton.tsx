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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs font-medium text-ink hover:border-accent hover:text-accent ${className}`}
      aria-live="polite"
    >
      {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {done ? "Скопировано" : label}
    </button>
  );
}

/** Строка «значение + кнопка копирования» для IP, DoH, DoT. */
export function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-bg px-3 py-2">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-mute">{label}</div>
        <div className={`break-all text-[14px] ${mono ? "font-mono" : ""}`}>{value}</div>
      </div>
      <CopyButton value={value} />
    </div>
  );
}
