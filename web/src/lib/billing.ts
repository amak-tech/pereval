import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { ensureUserByEmail, createLoginLink } from "@/lib/auth";
import * as lava from "@/lib/lava";
import { enqueueAdminMail, enqueueMail } from "@/lib/mail";
import {
  adminAlertMail,
  adminPaymentMail,
  cancelledMail,
  expiredMail,
  expiringSoonMail,
  onboardingMail,
  pastDueMail,
  renewedMail,
} from "@/lib/mail-templates";
import { accessUntil, firstPeriodEnd, renewedPeriodEnd, shouldExpire } from "@/lib/subscription";
import { bumpPolicyVersion } from "@/lib/policy";
import { bumpAclVersion } from "@/lib/acl";
import { generateAccessToken, sha256Hex } from "@/lib/crypto";
import { getSetting, setSetting } from "@/lib/settings";
import { parseWebhook, verifyWebhookAuth, type ParsedEvent } from "@/lib/lava-webhook";

export { parseWebhook, verifyWebhookAuth };
import type { SubscriptionStatus } from "@/lib/db/schema";

/** Биллинг Перевал Pro поверх lava.top: checkout, вебхуки, сверка, отмена. */

export type Plans = { pro: Partial<Record<lava.Currency, number>>; fetchedAt: string };

const PLANS_KEY = "lava_plans";
const PLANS_TTL_MS = 10 * 60_000;

export async function getPlans(force = false): Promise<Plans> {
  const cached = await getSetting<Plans>(PLANS_KEY);
  if (!force && cached && Date.now() - new Date(cached.fetchedAt).getTime() < PLANS_TTL_MS) return cached;
  try {
    const products = await lava.getProducts();
    const e = env();
    const prices: Partial<Record<lava.Currency, number>> = {};
    for (const p of products.items) {
      if (e.LAVA_PRODUCT_ID_PRO && p.id !== e.LAVA_PRODUCT_ID_PRO && !(p.offers ?? []).some((o) => o.id === e.LAVA_OFFER_ID_PRO)) continue;
      for (const offer of p.offers ?? []) {
        if (e.LAVA_OFFER_ID_PRO && offer.id !== e.LAVA_OFFER_ID_PRO) continue;
        for (const price of offer.prices) {
          if ((price.periodicity ?? "MONTHLY") !== "MONTHLY" || price.amount == null) continue;
          if (price.currency === "RUB" || price.currency === "USD" || price.currency === "EUR") prices[price.currency] = price.amount;
        }
      }
    }
    const plans: Plans = { pro: prices, fetchedAt: new Date().toISOString() };
    if (Object.keys(prices).length) await setSetting(PLANS_KEY, plans);
    return Object.keys(prices).length ? plans : (cached ?? plans);
  } catch (err) {
    console.warn(`[billing] не удалось получить цены lava.top: ${(err as Error)?.message ?? err}`);
    return cached ?? { pro: {}, fetchedAt: new Date(0).toISOString() };
  }
}

// ---------------------------------------------------------------- checkout

export type CheckoutInput = { email: string; currency: "RUB" | "USD"; utm?: Record<string, string> };

export async function checkout(input: CheckoutInput): Promise<{ paymentUrl: string; ref: string; invoiceId: string }> {
  const e = env();
  const user = await ensureUserByEmail(input.email);
  const active = await db()
    .select()
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.userId, user.id), inArray(schema.subscriptions.status, ["active", "past_due"])))
    .limit(1);
  if (active.length) {
    throw new HttpError(409, "У этого email уже есть активная подписка. Войдите в кабинет, чтобы управлять ею.", "already_active");
  }
  // живой неоплаченный инвойс (< 1 ч) — возвращаем ту же ссылку, не плодим подписки
  const [recent] = await db()
    .select()
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.userId, user.id),
        eq(schema.invoices.status, "new"),
        eq(schema.invoices.currency, input.currency),
        gt(schema.invoices.createdAt, new Date(Date.now() - 3_600_000)),
      ),
    )
    .orderBy(desc(schema.invoices.createdAt))
    .limit(1);
  if (recent?.paymentUrl) return { paymentUrl: recent.paymentUrl, ref: recent.ref, invoiceId: recent.id };

  const ref = crypto.randomUUID();
  const payBase = `${e.PUBLIC_ORIGIN}/account/pay?ref=${ref}`;
  const created = await lava.createInvoice({
    email: user.email,
    offerId: e.LAVA_OFFER_ID_PRO || "mock-offer",
    currency: input.currency,
    periodicity: "MONTHLY",
    paymentMethod: lava.paymentMethodFor(input.currency),
    buyerLanguage: "RU",
    clientUtm: input.utm,
    returnUrls: { success: `${payBase}&result=success`, failure: `${payBase}&result=failure`, cancel: `${payBase}&result=cancel` },
  });
  if (!created.paymentUrl) throw new HttpError(502, "Платёжная система не вернула ссылку на оплату. Попробуйте позже.", "no_payment_url");
  await db().insert(schema.invoices).values({
    id: created.id,
    ref,
    email: user.email,
    userId: user.id,
    kind: "first",
    status: created.status || "new",
    amount: created.amountTotal ? String(created.amountTotal.amount) : null,
    currency: created.amountTotal?.currency ?? input.currency,
    paymentUrl: created.paymentUrl,
    raw: created as object,
  });
  return { paymentUrl: created.paymentUrl, ref, invoiceId: created.id };
}

// ---------------------------------------------------------------- вебхуки

export type WebhookResult = { ok: true; duplicate?: boolean; handled?: string } | { ok: false; status: number; message: string };

export async function processWebhook(rawBody: string, headers: Headers, sourceIp: string): Promise<WebhookResult> {
  const auth = verifyWebhookAuth(headers, sourceIp);
  if (!auth.ok) {
    const t = adminAlertMail("Вебхук lava.top отклонён", `Причина: ${auth.reason}\nIP: ${sourceIp}\nТело: ${rawBody.slice(0, 500)}`);
    await enqueueAdminMail(t.subject, t.text, t.html).catch(() => undefined);
    return { ok: false, status: 401, message: auth.reason ?? "unauthorized" };
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, message: "bad json" };
  }
  const ev = parseWebhook(parsedBody);
  const hash = sha256Hex(rawBody);
  const contractId = ev?.kind === "flat" ? ev.data.contractId : ev?.kind === "envelope" ? String(ev.data.data["contract_id"] ?? ev.data.event_id) : null;
  const inserted = await db()
    .insert(schema.webhookEvents)
    .values({ bodySha256: hash, eventType: ev?.type ?? "unknown", contractId, payload: parsedBody as object })
    .onConflictDoNothing()
    .returning({ id: schema.webhookEvents.id });
  const row = inserted[0];
  if (!row) return { ok: true, duplicate: true };
  if (!ev) {
    await db().update(schema.webhookEvents).set({ processedAt: new Date(), error: "unknown format" }).where(eq(schema.webhookEvents.id, row.id));
    return { ok: true, handled: "ignored" };
  }
  try {
    await dispatchEvent(ev);
    await db().update(schema.webhookEvents).set({ processedAt: new Date() }).where(eq(schema.webhookEvents.id, row.id));
    return { ok: true, handled: ev.type };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    await db().update(schema.webhookEvents).set({ processedAt: new Date(), error: msg }).where(eq(schema.webhookEvents.id, row.id));
    const t = adminAlertMail(`Ошибка обработки вебхука ${ev.type}`, `${msg}\n\n${rawBody.slice(0, 1000)}`);
    await enqueueAdminMail(t.subject, t.text, t.html).catch(() => undefined);
    // 200, чтобы lava.top не ретраила бесконечно: событие сохранено, можно переиграть вручную
    return { ok: true, handled: `error:${ev.type}` };
  }
}

async function dispatchEvent(ev: ParsedEvent): Promise<void> {
  if (ev.kind === "envelope") {
    if (ev.type === "refund.success" || ev.type === "chargeback.initiated") return handleRefundOrChargeback(ev.data);
    console.warn(`[lava-webhook] неизвестный envelope-тип ${ev.type}`);
    return;
  }
  const d = ev.data;
  switch (ev.type) {
    case "payment.success":
      return d.parentContractId ? handleRenewalSuccess(d) : handleFirstPayment(d);
    case "subscription.recurring.payment.success":
      return handleRenewalSuccess(d);
    case "subscription.recurring.payment.failed":
      return handleRenewalFailed(d);
    case "payment.failed":
      return handlePaymentFailed(d);
    case "subscription.cancelled":
      return handleCancelled(d);
    default:
      console.warn(`[lava-webhook] неизвестный тип ${ev.type}`);
  }
}

function eventTime(d: lava.WebhookFlat): Date {
  const t = d.timestamp ? new Date(d.timestamp) : new Date();
  return Number.isNaN(t.getTime()) ? new Date() : t;
}

async function findSubscriptionByParent(parentContractId: string) {
  const [s] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.parentContractId, parentContractId)).limit(1);
  return s ?? null;
}

async function adminPayment(d: lava.WebhookFlat, ok: boolean, title: string, before: string | null, after: string | null, note?: string) {
  const t = adminPaymentMail({
    ok,
    title,
    email: d.buyer.email,
    amount: d.amount != null ? String(d.amount) : "?",
    currency: d.currency ?? "",
    eventType: d.eventType,
    contractId: d.contractId,
    parentContractId: d.parentContractId ?? null,
    statusBefore: before,
    statusAfter: after,
    errorMessage: d.errorMessage ?? null,
    note,
  });
  await enqueueAdminMail(t.subject, t.text, t.html, d.buyer.email);
}

/** Первая оплата: активация подписки, выпуск токена, onboarding-письмо. */
export async function handleFirstPayment(d: lava.WebhookFlat): Promise<void> {
  const e = env();
  const paidAt = eventTime(d);
  const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, d.contractId)).limit(1);
  if (invoice?.status === "completed" && (await findSubscriptionByParent(d.contractId))) {
    // повтор уже обработанного события (lava.top ретраит, или пришло и по вебхуку, и по сверке)
    return;
  }
  const email = (invoice?.email ?? d.buyer.email).toLowerCase();
  const user = invoice?.userId
    ? (await db().select().from(schema.users).where(eq(schema.users.id, invoice.userId)).limit(1))[0] ?? (await ensureUserByEmail(email))
    : await ensureUserByEmail(email);

  if (!invoice) {
    // инвойс создан не нами (например, прямой чекаут в lava.top) — проверяем, что это наш продукт
    if (e.LAVA_PRODUCT_ID_PRO && d.product?.id && d.product.id !== e.LAVA_PRODUCT_ID_PRO) {
      await adminPayment(d, true, "Оплата другого продукта (пропущено)", null, null, `product.id=${d.product.id}`);
      return;
    }
  }

  const existing = await db()
    .select()
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.userId, user.id), inArray(schema.subscriptions.status, ["active", "past_due"])))
    .limit(1);
  if (existing[0] && existing[0].parentContractId !== d.contractId) {
    // двойная покупка: отменяем новый контракт, деньги возвращает админ вручную
    try {
      await lava.cancelSubscription(d.contractId, email);
    } catch (err) {
      console.warn(`[billing] не удалось отменить дублирующий контракт ${d.contractId}: ${(err as Error)?.message}`);
    }
    await upsertInvoice(d, user.id, null, "first", "duplicate");
    await adminPayment(d, true, "Двойная покупка — вернуть деньги вручную", existing[0].status, existing[0].status, `Новый контракт ${d.contractId} отменён автоматически.`);
    return;
  }

  let periodEnd = firstPeriodEnd(paidAt, "MONTHLY");
  let periodicity = "MONTHLY";
  try {
    const details = await lava.getInvoice(d.contractId);
    const exp = details.subscriptionDetails?.expiredAt ? new Date(details.subscriptionDetails.expiredAt) : null;
    if (exp && !Number.isNaN(exp.getTime()) && exp.getTime() > paidAt.getTime()) periodEnd = exp;
  } catch (err) {
    console.warn(`[billing] GET /api/v1/invoices/${d.contractId} не удался, используем +1 месяц: ${(err as Error)?.message}`);
  }
  if (invoice?.raw && typeof invoice.raw === "object" && "periodicity" in (invoice.raw as Record<string, unknown>)) {
    periodicity = String((invoice.raw as Record<string, unknown>)["periodicity"] ?? "MONTHLY");
  }

  const before = existing[0]?.status ?? null;
  let sub = await findSubscriptionByParent(d.contractId);
  if (!sub) {
    const [created] = await db()
      .insert(schema.subscriptions)
      .values({
        userId: user.id,
        parentContractId: d.contractId,
        offerId: e.LAVA_OFFER_ID_PRO || null,
        currency: d.currency ?? invoice?.currency ?? null,
        periodicity,
        status: "active",
        startedAt: paidAt,
        periodEnd,
        lastEventAt: paidAt,
        updatedAt: new Date(),
      })
      .returning();
    sub = created!;
  } else {
    await db()
      .update(schema.subscriptions)
      .set({ status: "active", startedAt: sub.startedAt ?? paidAt, periodEnd, lastEventAt: paidAt, cancelledAt: null, updatedAt: new Date() })
      .where(eq(schema.subscriptions.id, sub.id));
    sub = { ...sub, status: "active", periodEnd };
  }
  await upsertInvoice(d, user.id, sub.id, "first", "completed");
  await ensureAccessToken(user.id);
  await bumpPolicyVersion("payment.success");
  await bumpAclVersion("payment.success");

  const until = accessUntil("active", periodEnd, e.GRACE_DAYS);
  const link = await createLoginLink(user.email, 72 * 3600);
  const tpl = onboardingMail(link, until);
  await enqueueMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  await adminPayment(d, true, "Оплата (первая)", before, "active");
}

export async function handleRenewalSuccess(d: lava.WebhookFlat): Promise<void> {
  const e = env();
  const paidAt = eventTime(d);
  const parent = d.parentContractId ?? d.contractId;
  const [seen] = await db().select({ status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, d.contractId)).limit(1);
  if (seen?.status === "completed" && d.contractId !== parent) {
    return; // это продление уже учтено
  }
  const sub = await findSubscriptionByParent(parent);
  if (!sub) {
    // продление неизвестной нам подписки — трактуем как первую оплату по родительскому контракту
    await handleFirstPayment({ ...d, contractId: parent, parentContractId: null });
    return;
  }
  const periodEnd = renewedPeriodEnd(sub.periodEnd, paidAt, sub.periodicity);
  const before = sub.status;
  await db()
    .update(schema.subscriptions)
    .set({ status: "active", periodEnd, lastEventAt: paidAt, updatedAt: new Date() })
    .where(eq(schema.subscriptions.id, sub.id));
  await upsertInvoice(d, sub.userId, sub.id, "renewal", "completed");
  await bumpPolicyVersion("renewal.success");
  await bumpAclVersion("renewal.success");
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, sub.userId)).limit(1);
  if (user) {
    const tpl = renewedMail(accessUntil("active", periodEnd, e.GRACE_DAYS));
    await enqueueMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  }
  await adminPayment(d, true, "Продление", before, "active");
}

export async function handleRenewalFailed(d: lava.WebhookFlat): Promise<void> {
  const e = env();
  const parent = d.parentContractId ?? d.contractId;
  const sub = await findSubscriptionByParent(parent);
  if (!sub) {
    await adminPayment(d, false, "Неудачное продление неизвестной подписки", null, null);
    return;
  }
  const before = sub.status;
  if (sub.status === "active") {
    await db().update(schema.subscriptions).set({ status: "past_due", lastEventAt: eventTime(d), updatedAt: new Date() }).where(eq(schema.subscriptions.id, sub.id));
    await bumpPolicyVersion("renewal.failed");
  }
  await upsertInvoice(d, sub.userId, sub.id, "renewal", "failed");
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, sub.userId)).limit(1);
  if (user) {
    const tpl = pastDueMail(accessUntil("past_due", sub.periodEnd, e.GRACE_DAYS));
    await enqueueMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  }
  await adminPayment(d, false, "Неудачное продление", before, "past_due");
}

export async function handlePaymentFailed(d: lava.WebhookFlat): Promise<void> {
  const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, d.contractId)).limit(1);
  if (invoice) {
    await db().update(schema.invoices).set({ status: "failed", raw: d as object, updatedAt: new Date() }).where(eq(schema.invoices.id, invoice.id));
  }
  await adminPayment(d, false, "Неудачная оплата", null, null);
}

export async function handleCancelled(d: lava.WebhookFlat): Promise<void> {
  const e = env();
  const parent = d.parentContractId ?? d.contractId;
  const sub = await findSubscriptionByParent(parent);
  if (!sub) {
    await adminPayment(d, true, "Отмена неизвестной подписки", null, null);
    return;
  }
  const before = sub.status;
  if (sub.status !== "cancelled" && sub.status !== "expired") {
    await db()
      .update(schema.subscriptions)
      .set({ status: "cancelled", cancelledAt: eventTime(d), lastEventAt: eventTime(d), updatedAt: new Date() })
      .where(eq(schema.subscriptions.id, sub.id));
    await bumpPolicyVersion("cancelled");
    const [user] = await db().select().from(schema.users).where(eq(schema.users.id, sub.userId)).limit(1);
    if (user) {
      const tpl = cancelledMail(accessUntil("cancelled", sub.periodEnd, e.GRACE_DAYS));
      await enqueueMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
    }
  }
  await adminPayment(d, true, "Отмена подписки", before, "cancelled");
}

export async function handleRefundOrChargeback(ev: lava.WebhookEnvelope): Promise<void> {
  const data = ev.data;
  const email = String(data["customer_email"] ?? data["email"] ?? "").toLowerCase();
  const amount = String(data["amount"] ?? "?");
  const currency = String(data["currency"] ?? "");
  let affected: string | null = null;
  if (email) {
    const [user] = await db().select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (user) {
      const subs = await db()
        .select()
        .from(schema.subscriptions)
        .where(and(eq(schema.subscriptions.userId, user.id), inArray(schema.subscriptions.status, ["active", "past_due", "cancelled"])));
      for (const s of subs) {
        await db().update(schema.subscriptions).set({ status: "expired", lastEventAt: new Date(), updatedAt: new Date() }).where(eq(schema.subscriptions.id, s.id));
        affected = s.id;
      }
      if (subs.length) {
        await bumpPolicyVersion(ev.event_type);
        await bumpAclVersion(ev.event_type);
      }
    }
  }
  const t = adminPaymentMail({
    ok: false,
    title: ev.event_type === "refund.success" ? "Возврат средств" : "Чарджбэк",
    email: email || "?",
    amount,
    currency,
    eventType: ev.event_type,
    contractId: String(data["refund_id"] ?? data["chargeback_id"] ?? ev.event_id),
    statusBefore: affected ? "active" : null,
    statusAfter: affected ? "expired" : null,
    note: affected ? "Доступ отключён." : "Подписка в базе не найдена.",
  });
  await enqueueAdminMail(t.subject, t.text, t.html, email || undefined);
}

async function upsertInvoice(d: lava.WebhookFlat, userId: string, subscriptionId: string | null, kind: "first" | "renewal", status: string) {
  await db()
    .insert(schema.invoices)
    .values({
      id: d.contractId,
      ref: crypto.randomUUID(),
      email: d.buyer.email.toLowerCase(),
      userId,
      subscriptionId,
      kind,
      status,
      amount: d.amount != null ? String(d.amount) : null,
      currency: d.currency ?? null,
      raw: d as object,
    })
    .onConflictDoUpdate({
      target: schema.invoices.id,
      set: { status, subscriptionId, userId, raw: d as object, updatedAt: new Date() },
    });
}

export async function ensureAccessToken(userId: string): Promise<string> {
  const [existing] = await db()
    .select()
    .from(schema.accessTokens)
    .where(and(eq(schema.accessTokens.userId, userId), eq(schema.accessTokens.revokedAt, null as unknown as Date)))
    .limit(1);
  if (existing) return existing.token;
  const live = await db().select().from(schema.accessTokens).where(eq(schema.accessTokens.userId, userId));
  const active = live.find((t) => !t.revokedAt);
  if (active) return active.token;
  for (let i = 0; i < 5; i++) {
    const token = generateAccessToken();
    const rows = await db().insert(schema.accessTokens).values({ userId, token }).onConflictDoNothing().returning({ token: schema.accessTokens.token });
    if (rows[0]) return rows[0].token;
  }
  throw new Error("не удалось выпустить уникальный токен");
}

// ---------------------------------------------------------------- статус инвойса / on-demand сверка

const onDemandChecks = new Map<string, number>();

export async function invoiceStatusByRef(ref: string): Promise<{ status: string; paid: boolean; invoiceId: string | null }> {
  const [inv] = await db().select().from(schema.invoices).where(eq(schema.invoices.ref, ref)).limit(1);
  if (!inv) throw new HttpError(404, "Инвойс не найден.", "not_found");
  let status = inv.status;
  const paidStatuses = new Set(["completed", "subscription-active"]);
  if (!paidStatuses.has(status) && status !== "failed" && Date.now() - inv.createdAt.getTime() > 10_000) {
    const last = onDemandChecks.get(inv.id) ?? 0;
    if (Date.now() - last > 10_000) {
      onDemandChecks.set(inv.id, Date.now());
      try {
        const details = await lava.getInvoice(inv.id);
        if (paidStatuses.has(details.status) || details.subscriptionStatus === "ACTIVE") {
          // вебхук ещё не дошёл — обрабатываем как payment.success (идемпотентно)
          await handleFirstPayment({
            eventType: "payment.success",
            contractId: inv.id,
            parentContractId: details.parentInvoice?.id ?? null,
            buyer: { email: details.buyer?.email ?? inv.email },
            amount: details.receipt?.amount,
            currency: details.receipt?.currency ?? inv.currency ?? undefined,
            status: details.status,
            timestamp: details.datetime ?? new Date().toISOString(),
            product: { id: env().LAVA_PRODUCT_ID_PRO || undefined, title: details.product?.name },
          });
          status = "completed";
        } else if (details.status === "failed" || details.status === "cancelled") {
          await db().update(schema.invoices).set({ status: details.status, updatedAt: new Date() }).where(eq(schema.invoices.id, inv.id));
          status = details.status;
        }
      } catch (err) {
        console.warn(`[billing] on-demand проверка ${inv.id}: ${(err as Error)?.message ?? err}`);
      }
    }
  }
  return { status, paid: paidStatuses.has(status), invoiceId: inv.id };
}

// ---------------------------------------------------------------- действия пользователя

export async function cancelUserSubscription(userId: string, email: string): Promise<void> {
  const [sub] = await db()
    .select()
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.userId, userId), inArray(schema.subscriptions.status, ["active", "past_due"])))
    .limit(1);
  if (!sub || !sub.parentContractId) throw new HttpError(409, "Активной подписки нет.", "no_subscription");
  await lava.cancelSubscription(sub.parentContractId, email);
  await db()
    .update(schema.subscriptions)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.subscriptions.id, sub.id));
  await bumpPolicyVersion("user.cancel");
  const tpl = cancelledMail(accessUntil("cancelled", sub.periodEnd, env().GRACE_DAYS));
  await enqueueMail({ to: email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  const t = adminPaymentMail({
    ok: true,
    title: "Отмена из кабинета",
    email,
    amount: "-",
    currency: sub.currency ?? "",
    eventType: "user.cancel",
    contractId: sub.parentContractId,
    statusBefore: sub.status,
    statusAfter: "cancelled",
  });
  await enqueueAdminMail(t.subject, t.text, t.html, email);
}

// ---------------------------------------------------------------- планировщик

export async function reconcileSubscriptions(now: Date = new Date()): Promise<{ expired: number; aligned: number; reminded: number }> {
  const e = env();
  let expired = 0;
  let aligned = 0;
  let reminded = 0;
  const soon = new Date(now.getTime() + 2 * 86_400_000);
  const candidates = await db()
    .select()
    .from(schema.subscriptions)
    .where(and(inArray(schema.subscriptions.status, ["active", "past_due", "cancelled"]), lt(schema.subscriptions.periodEnd, soon)));
  for (const sub of candidates) {
    let status: SubscriptionStatus = sub.status;
    let periodEnd = sub.periodEnd;
    if (sub.parentContractId && (status === "active" || status === "past_due")) {
      try {
        const details = await lava.getInvoice(sub.parentContractId);
        const exp = details.subscriptionDetails?.expiredAt ? new Date(details.subscriptionDetails.expiredAt) : null;
        if (exp && !Number.isNaN(exp.getTime()) && (!periodEnd || Math.abs(exp.getTime() - periodEnd.getTime()) > 60_000)) {
          periodEnd = exp;
          aligned++;
        }
        if (details.subscriptionStatus === "CANCELLED") status = "cancelled";
        else if (details.subscriptionStatus === "ACTIVE" && status === "past_due") status = "active";
      } catch (err) {
        console.warn(`[reconcile] ${sub.parentContractId}: ${(err as Error)?.message ?? err}`);
      }
    }
    if (shouldExpire(status, periodEnd, e.GRACE_DAYS, now)) {
      status = "expired";
      expired++;
      const [user] = await db().select().from(schema.users).where(eq(schema.users.id, sub.userId)).limit(1);
      if (user) {
        const tpl = expiredMail();
        await enqueueMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
      }
    }
    if (status !== sub.status || periodEnd?.getTime() !== sub.periodEnd?.getTime()) {
      await db().update(schema.subscriptions).set({ status, periodEnd, updatedAt: now }).where(eq(schema.subscriptions.id, sub.id));
    }
  }
  if (expired || aligned) {
    await bumpPolicyVersion("reconcile");
    await bumpAclVersion("reconcile");
  }
  // напоминание за 3 дня отменённым
  const remindFrom = new Date(now.getTime() + 2 * 86_400_000);
  const remindTo = new Date(now.getTime() + 3 * 86_400_000);
  const cancelled = await db()
    .select()
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.status, "cancelled"), gt(schema.subscriptions.periodEnd, remindFrom), lt(schema.subscriptions.periodEnd, remindTo)));
  for (const sub of cancelled) {
    const key = `reminded:${sub.id}`;
    if (await getSetting(key)) continue;
    const [user] = await db().select().from(schema.users).where(eq(schema.users.id, sub.userId)).limit(1);
    if (user && sub.periodEnd) {
      const tpl = expiringSoonMail(sub.periodEnd);
      await enqueueMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
      await setSetting(key, now.toISOString());
      reminded++;
    }
  }
  return { expired, aligned, reminded };
}
