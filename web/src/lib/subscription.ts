import type { SubscriptionStatus } from "@/lib/db/schema";

/** Чистая арифметика периодов подписки — без БД, чтобы её было легко тестировать. */

export type Periodicity = "MONTHLY" | "PERIOD_90_DAYS" | "PERIOD_180_DAYS" | "PERIOD_YEAR";

export function addPeriod(from: Date, periodicity: Periodicity | string): Date {
  const d = new Date(from.getTime());
  switch (periodicity) {
    case "MONTHLY": {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      return d;
    }
    case "PERIOD_90_DAYS":
      return new Date(d.getTime() + 90 * 86_400_000);
    case "PERIOD_180_DAYS":
      return new Date(d.getTime() + 180 * 86_400_000);
    case "PERIOD_YEAR": {
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d;
    }
    default:
      return addPeriod(from, "MONTHLY");
  }
}

/** Конец периода после первой оплаты. */
export function firstPeriodEnd(paidAt: Date, periodicity: string): Date {
  return addPeriod(paidAt, periodicity);
}

/** Конец периода после продления: от прежнего конца, если он ещё не наступил, иначе от момента оплаты. Grace не компаундится. */
export function renewedPeriodEnd(prevPeriodEnd: Date | null, paidAt: Date, periodicity: string): Date {
  const base = prevPeriodEnd && prevPeriodEnd.getTime() > paidAt.getTime() ? prevPeriodEnd : paidAt;
  return addPeriod(base, periodicity);
}

/** Доступ: до period_end; при past_due — плюс grace. */
export function accessUntil(status: SubscriptionStatus, periodEnd: Date | null, graceDays: number): Date | null {
  if (!periodEnd) return null;
  if (status === "past_due") return new Date(periodEnd.getTime() + graceDays * 86_400_000);
  return periodEnd;
}

export type DnsMode = "proxy" | "plain" | "deny";

/** Режим DNS для пользователя по статусу подписки. Истёкшие не остаются без интернета (plain). */
export function dnsMode(status: SubscriptionStatus | null, periodEnd: Date | null, graceDays: number, now: Date): DnsMode {
  if (!status) return "plain";
  const until = accessUntil(status, periodEnd, graceDays);
  switch (status) {
    case "active":
    case "past_due":
    case "cancelled":
      return until && until.getTime() > now.getTime() ? "proxy" : "plain";
    case "pending":
    case "expired":
    default:
      return "plain";
  }
}

/** Должна ли подписка считаться истёкшей (для планировщика). */
export function shouldExpire(status: SubscriptionStatus, periodEnd: Date | null, graceDays: number, now: Date): boolean {
  if (status !== "active" && status !== "past_due" && status !== "cancelled") return false;
  const until = accessUntil(status, periodEnd, graceDays);
  return !!until && until.getTime() <= now.getTime();
}
