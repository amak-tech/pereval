"use client";

import { formatPrices, usePlans } from "@/components/billing/usePlans";

/**
 * Цена Pro из /api/billing/plans. Пока грузится — «…», если цен нет — «цена уточняется».
 * `size="lg"` — крупная цифра для карточки тарифа.
 */
export function ProPrice({ size = "md", suffix = " в месяц" }: { size?: "md" | "lg"; suffix?: string }) {
  const { status, prices } = usePlans();
  const text = formatPrices(prices);
  const cls = size === "lg" ? "text-[clamp(22px,4vw,28px)] font-semibold tracking-tight" : "font-semibold";
  if (status === "loading") {
    return (
      <span className={`${cls} text-mute`} aria-busy="true" aria-live="polite">
        …
      </span>
    );
  }
  if (!text) {
    return (
      <span className={`${cls} text-mute`} aria-live="polite">
        цена уточняется
      </span>
    );
  }
  return (
    <span aria-live="polite">
      <span className={cls}>{text}</span>
      <span className="text-mute">{suffix}</span>
    </span>
  );
}
