"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, XCircle } from "lucide-react";

type Status = "checking" | "paid" | "failed" | "timeout" | "invalid";

/**
 * Страница возврата после оплаты. Статус из URL (result=success) НЕ является
 * подтверждением — ждём вебхук lava.top, опрашивая /api/billing/invoice/<ref>.
 */
export function PayStatus() {
  const sp = useSearchParams();
  const ref = sp.get("ref") ?? "";
  const result = sp.get("result");
  const mock = sp.get("mock") === "1";
  const [status, setStatus] = useState<Status>(ref ? "checking" : "invalid");
  const [mockBusy, setMockBusy] = useState(false);
  const started = useRef<number | null>(null);

  useEffect(() => {
    if (!ref) return;
    started.current ??= Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const res = await fetch(`/api/billing/invoice/${encodeURIComponent(ref)}`, { cache: "no-store" });
        const data = (await res.json()) as { ok: boolean; status?: string; paid?: boolean };
        if (cancelled) return;
        if (data.ok && data.paid) return setStatus("paid");
        if (data.ok && (data.status === "failed" || data.status === "cancelled")) return setStatus("failed");
        if (!res.ok && res.status === 404) return setStatus("invalid");
      } catch {
        /* сеть — просто попробуем ещё */
      }
      if (Date.now() - (started.current ?? Date.now()) > 2 * 60_000) return setStatus("timeout");
      timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ref]);

  async function mockPay() {
    setMockBusy(true);
    try {
      await fetch("/api/billing/mock/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref }) });
    } finally {
      setMockBusy(false);
    }
  }

  if (status === "invalid") {
    return (
      <div className="card">
        <h1 className="m-0 text-2xl font-semibold">Платёж не найден</h1>
        <p className="mt-2 text-mute">
          Ссылка повреждена или устарела. <Link href="/pro#buy">Вернуться к оформлению</Link>.
        </p>
      </div>
    );
  }
  if (status === "paid") {
    return (
      <div className="card">
        <div className="flex items-center gap-3 text-ok">
          <CheckCircle2 className="h-7 w-7" aria-hidden />
          <h1 className="m-0 text-2xl font-semibold">Оплата подтверждена</h1>
        </div>
        <p className="mt-3 text-mute">
          Подписка активна. Мы отправили на вашу почту письмо со ссылкой для входа в кабинет — там готовые настройки для телефона, компьютера и роутера.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/account/login" className="btn-primary">
            Войти в кабинет
          </Link>
          <Link href="/" className="btn-secondary">
            На главную
          </Link>
        </div>
        <p className="mt-4 text-xs text-mute">Письмо не пришло за 5 минут? Проверьте «Спам» или запросите новую ссылку на странице входа.</p>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="card">
        <div className="flex items-center gap-3 text-err">
          <XCircle className="h-7 w-7" aria-hidden />
          <h1 className="m-0 text-2xl font-semibold">Оплата не прошла</h1>
        </div>
        <p className="mt-3 text-mute">Деньги не списаны. Можно попробовать другую карту или валюту.</p>
        <Link href="/pro#buy" className="btn-primary mt-5">
          Попробовать снова
        </Link>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="flex items-center gap-3">
        <Clock className={`h-7 w-7 text-accent ${status === "checking" ? "animate-pulse" : ""}`} aria-hidden />
        <h1 className="m-0 text-2xl font-semibold">{status === "timeout" ? "Ждём подтверждение банка" : "Проверяем оплату…"}</h1>
      </div>
      <p className="mt-3 text-mute">
        {result === "success"
          ? "Платёжная система сообщила об успехе, осталось дождаться подтверждения. Обычно это занимает несколько секунд."
          : result === "cancel"
            ? "Похоже, оплата была отменена. Если это не так — подождите, мы проверяем статус."
            : "Как только банк подтвердит платёж, здесь появится ссылка в кабинет, а на почту придёт письмо."}
      </p>
      {status === "timeout" ? (
        <p className="mt-3 text-sm text-mute">
          Подтверждение задерживается. Это нормально для некоторых банков: письмо со входом придёт автоматически, когда платёж пройдёт. Вопросы —{" "}
          <a href="mailto:support@pereval.top">support@pereval.top</a>.
        </p>
      ) : null}
      {mock ? (
        <button type="button" onClick={mockPay} disabled={mockBusy} className="btn-secondary mt-5">
          {mockBusy ? "…" : "Эмулировать успешную оплату (mock)"}
        </button>
      ) : null}
    </div>
  );
}
