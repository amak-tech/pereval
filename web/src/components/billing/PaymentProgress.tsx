"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Lock } from "lucide-react";

export type PaymentPhase = "creating" | "redirect";

/**
 * Полноэкранный индикатор между кликом «Перейти к оплате» и открытием страницы платёжного сервиса.
 * Создание счёта в lava.top занимает несколько секунд — вместо «зависшей» кнопки показываем шаги,
 * живой прогресс и подсказку, которая меняется по мере ожидания. Пока счёт создаётся, можно отменить.
 */
export function PaymentProgress({ phase, onCancel }: { phase: PaymentPhase; onCancel?: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, []);

  // блокируем прокрутку страницы и переводим фокус в диалог; Esc = отмена (только пока счёт создаётся)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (phase !== "creating" || !onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onCancel]);

  const canCancel = phase === "creating" && Boolean(onCancel);
  const title = phase === "redirect" ? "Открываем страницу оплаты…" : "Готовим оплату…";
  const hint =
    phase === "redirect"
      ? "Сейчас откроется защищённая страница платёжного сервиса."
      : elapsed < 4
        ? "Создаём счёт в платёжной системе. Обычно это занимает несколько секунд."
        : elapsed < 12
          ? "Платёжный сервис отвечает чуть дольше обычного. Не закрывайте страницу."
          : "Ещё немного… Если страница оплаты не откроется, попробуйте ещё раз через минуту.";

  const steps: { label: string; state: "done" | "active" | "todo" }[] = [
    { label: "Создаём счёт", state: phase === "creating" ? "active" : "done" },
    { label: "Открываем страницу оплаты", state: phase === "redirect" ? "active" : "todo" },
    { label: "Оплата картой или СБП", state: "todo" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 backdrop-blur-sm sm:items-center" aria-hidden={false}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-progress-title"
        aria-describedby="payment-progress-hint"
        tabIndex={-1}
        className="card w-full max-w-[440px] outline-none motion-safe:animate-[payment-progress-in_220ms_ease-out]"
      >
        <div className="flex items-center gap-3">
          <LoaderCircle className="h-6 w-6 shrink-0 text-accent motion-safe:animate-spin" aria-hidden />
          <h2 id="payment-progress-title" className="m-0 text-lg font-semibold">
            {title}
          </h2>
        </div>

        <div className="progress-bar mt-4" role="progressbar" aria-label={title} aria-valuetext={title}>
          <span />
        </div>

        <ol className="m-0 mt-4 grid list-none gap-2 p-0 text-sm">
          {steps.map((s) => (
            <li key={s.label} className={`flex items-center gap-2.5 ${s.state === "todo" ? "text-mute" : ""}`} aria-current={s.state === "active" ? "step" : undefined}>
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                  s.state === "done"
                    ? "border-ok bg-ok text-white"
                    : s.state === "active"
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line text-mute"
                }`}
                aria-hidden
              >
                {s.state === "done" ? <Check className="h-3 w-3" /> : s.state === "active" ? <span className="h-2 w-2 rounded-full bg-accent motion-safe:animate-pulse" /> : null}
              </span>
              <span className={s.state === "active" ? "font-semibold" : ""}>{s.label}</span>
            </li>
          ))}
        </ol>

        <p id="payment-progress-hint" className="m-0 mt-4 min-h-[2.5em] text-sm text-mute" aria-live="polite">
          {hint}
        </p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="m-0 flex items-center gap-1.5 text-xs text-mute">
            <Lock className="h-3.5 w-3.5" aria-hidden /> Данные карты вводятся только на стороне платёжного сервиса.
          </p>
          {canCancel ? (
            <button type="button" onClick={onCancel} className="shrink-0 text-sm font-semibold text-mute underline-offset-2 hover:text-ink hover:underline">
              Отменить
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Возврат на страницу кнопкой «Назад» из платёжного сервиса: браузер восстанавливает страницу из bfcache
 * вместе с состоянием «Открываем страницу оплаты…». Сбрасываем его, чтобы форма снова была доступна.
 */
export function useResetOnPageRestore(reset: () => void) {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) reset();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [reset]);
}

/** Таймаут ожидания ответа от нашего API (сервер сам ждёт lava.top до 20 с). */
export const CHECKOUT_TIMEOUT_MS = 30_000;
