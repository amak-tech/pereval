"use client";

import { useEffect, useState } from "react";

/** Ответ GET /api/billing/plans. `prices` может быть пустым, если lava.top недоступен. */
export type Currency = "RUB" | "USD";
export type Prices = Partial<Record<Currency, number>>;
export type PlansResponse = { ok: boolean; plan: "pro"; periodicity: "MONTHLY"; prices: Prices; fetchedAt: string };

export type PlansState = { status: "loading" | "ready" | "error"; prices: Prices };

// Один запрос на страницу: все ценники (карточка тарифа, таблица, checkout) читают общий результат.
let shared: Promise<Prices> | null = null;

export function loadPlans(): Promise<Prices> {
  if (!shared) {
    shared = fetch("/api/billing/plans", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Partial<PlansResponse>;
        const prices: Prices = {};
        if (data.prices && typeof data.prices.RUB === "number") prices.RUB = data.prices.RUB;
        if (data.prices && typeof data.prices.USD === "number") prices.USD = data.prices.USD;
        return prices;
      })
      .catch((err) => {
        shared = null; // дать шанс повторить при следующем монтировании
        throw err;
      });
  }
  return shared;
}

export function usePlans(): PlansState {
  const [state, setState] = useState<PlansState>({ status: "loading", prices: {} });
  useEffect(() => {
    let alive = true;
    loadPlans()
      .then((prices) => alive && setState({ status: "ready", prices }))
      .catch(() => alive && setState({ status: "error", prices: {} }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

const rub = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function formatPrice(currency: Currency, amount: number): string {
  return currency === "RUB" ? `${rub.format(amount)} ₽` : `$${usd.format(amount)}`;
}

/** «299 ₽ / $3.99 в месяц» или null, если цен нет. */
export function formatPrices(prices: Prices): string | null {
  const parts: string[] = [];
  if (typeof prices.RUB === "number") parts.push(formatPrice("RUB", prices.RUB));
  if (typeof prices.USD === "number") parts.push(formatPrice("USD", prices.USD));
  return parts.length ? parts.join(" / ") : null;
}
