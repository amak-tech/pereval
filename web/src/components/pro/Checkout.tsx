"use client";

import Link from "next/link";
import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import { CreditCard, LoaderCircle, Lock } from "lucide-react";
import { formatPrice, usePlans, type Currency } from "@/components/billing/usePlans";
import { track, utmFromLocation } from "@/components/track";
import { CHECKOUT_TIMEOUT_MS, PaymentProgress, useResetOnPageRestore } from "@/components/billing/PaymentProgress";

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string; code?: string } | { kind: "redirect" };

/**
 * Оформление подписки Pro: email + валюта + явное согласие на ежемесячные списания →
 * POST /api/billing/checkout → переход на страницу платёжного сервиса.
 */
export function Checkout({ name, supportEmail }: { name: string; supportEmail: string }) {
  const { status: plansStatus, prices } = usePlans();
  const [email, setEmail] = useState("");
  const [currency, setCurrency] = useState<Currency>("RUB");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const id = useId();
  const abortRef = useRef<AbortController | null>(null);

  const busy = status.kind === "busy" || status.kind === "redirect";

  // «Назад» со страницы оплаты восстанавливает страницу из bfcache вместе с оверлеем — сбрасываем
  useResetOnPageRestore(useCallback(() => setStatus({ kind: "idle" }), []));

  function cancel() {
    abortRef.current?.abort("cancelled");
    abortRef.current = null;
    setStatus({ kind: "idle" });
  }
  const currencies: Currency[] = ["RUB", "USD"];

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
      setStatus({ kind: "error", message: "Укажите корректный адрес электронной почты." });
      return;
    }
    if (!consent) {
      setStatus({ kind: "error", message: "Нужно согласиться с условиями и ежемесячным списанием." });
      return;
    }
    setStatus({ kind: "busy" });
    track("begin_checkout", { currency, plan: "pro" });
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort("timeout"), CHECKOUT_TIMEOUT_MS);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: trimmed, currency, consent: true, utm: utmFromLocation() }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; paymentUrl?: string; error?: string; message?: string };
      if (res.ok && data.ok && data.paymentUrl) {
        setStatus({ kind: "redirect" });
        window.location.assign(data.paymentUrl);
        return;
      }
      const fallback =
        res.status === 409
          ? "У этого email уже есть активная подписка."
          : res.status === 429
            ? "Слишком много попыток. Попробуйте через несколько минут."
            : res.status === 400
              ? "Проверьте правильность заполнения полей формы."
              : "Не удалось начать оплату. Попробуйте позже.";
      setStatus({ kind: "error", message: data.message || fallback, code: data.error ?? (res.status === 409 ? "already_active" : undefined) });
    } catch {
      if (controller.signal.aborted) {
        // отмена пользователем уже вернула форму в idle; по таймауту — объясняем
        if (controller.signal.reason === "timeout") {
          setStatus({ kind: "error", message: "Платёжный сервис не ответил вовремя. Попробуйте ещё раз — если счёт уже создан, вы сразу перейдёте к оплате." });
        }
        return;
      }
      setStatus({ kind: "error", message: "Ошибка соединения с сервером. Проверьте подключение и попробуйте ещё раз." });
    } finally {
      clearTimeout(timeout);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  return (
    <>
      {busy ? <PaymentProgress phase={status.kind === "redirect" ? "redirect" : "creating"} onCancel={cancel} /> : null}
      <form onSubmit={onSubmit} noValidate className="card border-accent ring-1 ring-accent" aria-describedby={`${id}-legal`}>
        <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-start">
          <div>
            <label htmlFor={`${id}-email`} className="block text-sm font-semibold">
              Email для доступа в кабинет
            </label>
            <p className="m-0 mt-1 text-sm text-mute">На него придут чек и ссылка для входа. Регистрация не нужна.</p>
            <input
              id={`${id}-email`}
              type="email"
              name="email"
              required
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="mt-2 w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-[15px] text-ink placeholder:text-mute focus:border-accent disabled:opacity-60"
            />
          </div>
          <fieldset className="m-0 min-w-0 border-0 p-0 md:min-w-[260px]">
            <legend className="text-sm font-semibold">Валюта и цена в месяц</legend>
            <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Валюта">
              {currencies.map((c) => {
                const on = currency === c;
                const price = prices[c];
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setCurrency(c)}
                    disabled={busy}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${on ? "border-accent bg-accent-soft" : "border-line bg-bg hover:border-accent"}`}
                  >
                    <span className="block text-xs font-semibold uppercase tracking-wider text-mute">{c === "RUB" ? "Рубли · карты РФ, СБП" : "USD · зарубежные карты"}</span>
                    <span className={`block text-[17px] font-semibold ${on ? "text-accent" : ""}`} aria-live="polite">
                      {plansStatus === "loading" ? "…" : typeof price === "number" ? `${formatPrice(c, price)}/мес` : "цена уточняется"}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <label className="mt-5 flex items-start gap-3 text-[14px] leading-relaxed">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy} required className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]" />
          <span id={`${id}-legal`}>
            Я принимаю{" "}
            <Link href="/terms#pro" target="_blank">
              Пользовательское соглашение
            </Link>{" "}
            и{" "}
            <Link href="/privacy" target="_blank">
              Политику конфиденциальности
            </Link>{" "}
            и даю согласие на <strong>автоматическое ежемесячное списание</strong> стоимости подписки {name} Pro с указанного платёжного средства до её отмены в личном кабинете. Цена фиксируется на момент оплаты.
          </span>
        </label>

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button type="submit" disabled={busy || !consent} className="btn-primary disabled:cursor-not-allowed disabled:opacity-60">
            {busy ? <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <CreditCard className="h-4 w-4" aria-hidden />}
            {status.kind === "redirect" ? "Переходим к оплате…" : status.kind === "busy" ? "Создаём счёт…" : "Перейти к оплате"}
          </button>
          <p className="m-0 flex items-center gap-1.5 text-xs text-mute">
            <Lock className="h-3.5 w-3.5" aria-hidden /> Оплата на защищённой странице платёжного сервиса. Данные карты мы не видим и не храним.
          </p>
        </div>

        {status.kind === "error" ? (
          <p role="alert" className="mt-4 rounded-lg bg-err-bg px-4 py-3 text-sm text-err">
            {status.message}{" "}
            {status.code === "already_active" ? (
              <Link href="/account/login" className="font-semibold">
                Войти в кабинет →
              </Link>
            ) : status.code === "rate_limited" ? null : (
              <>
                Если ошибка повторяется — напишите на <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
              </>
            )}
          </p>
        ) : null}

        <p className="m-0 mt-5 border-t border-line pt-4 text-sm text-mute">
          Уже есть подписка?{" "}
          <Link href="/account/login" className="font-semibold">
            Войти в кабинет
          </Link>
        </p>
      </form>
    </>
  );
}
