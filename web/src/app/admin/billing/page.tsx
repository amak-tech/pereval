import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "@/lib/admin-auth";
import { listInvoices, listSubscriptions, listWebhookEvents } from "@/lib/admin";
import { getPlans } from "@/lib/billing";
import { env, isMock } from "@/lib/env";
import type { SubscriptionStatus } from "@/lib/db/schema";
import { Card, Table, Pager, Mono, SubStatus, JsonDetails, fmtD, fmtDt, fmtN, pageNum, str } from "@/components/admin/ui";
import { ActionButton } from "@/components/admin/actions";
import { Badge } from "@/components/Section";

export const metadata: Metadata = { title: "Биллинг" };
export const dynamic = "force-dynamic";

const STATUSES: SubscriptionStatus[] = ["active", "past_due", "cancelled", "expired", "pending"];

export default async function AdminBillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const statusRaw = str(sp.status);
  const status = (STATUSES as string[]).includes(statusRaw) ? (statusRaw as SubscriptionStatus) : undefined;
  const onlyErrors = str(sp.errors) === "1";
  const page = pageNum(sp.page);
  const whPage = pageNum(sp.wh);
  const [subs, invoices, webhooks, plans] = await Promise.all([listSubscriptions({ status, page }), listInvoices(100), listWebhookEvents({ onlyErrors, page: whPage }), getPlans()]);
  const e = env();

  return (
    <>
      <Card
        title="lava.top"
        actions={
          <>
            <ActionButton action={{ action: "billing.refresh_plans" }}>Обновить цены</ActionButton>
            <ActionButton action={{ action: "billing.reconcile" }} confirm="Запустить сверку подписок с lava.top сейчас? Истёкшие будут отключены, письма — отправлены.">
              Сверить подписки
            </ActionButton>
          </>
        }
      >
        <dl className="m-0 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-3 border-b border-line py-1">
            <dt className="text-mute">Режим</dt>
            <dd className="m-0 font-semibold">{isMock() ? "LAVA_MOCK (эмуляция)" : e.LAVA_API_KEY ? "боевой" : "API-ключ не задан"}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line py-1">
            <dt className="text-mute">Цены Pro (кеш {fmtDt(plans.fetchedAt)})</dt>
            <dd className="m-0 font-semibold">{Object.entries(plans.pro).map(([c, a]) => `${a} ${c}`).join(" · ") || "нет"}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line py-1">
            <dt className="text-mute">Продукт / оффер</dt>
            <dd className="m-0">
              <Mono>{e.LAVA_PRODUCT_ID_PRO || "—"}</Mono> / <Mono>{e.LAVA_OFFER_ID_PRO || "—"}</Mono>
            </dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line py-1">
            <dt className="text-mute">Вебхук</dt>
            <dd className="m-0 font-semibold">
              {e.LAVA_WEBHOOK_KEY ? "ключ задан" : "ключ не задан"} · IP-фильтр: {e.LAVA_WEBHOOK_IP_MODE}
            </dd>
          </div>
        </dl>
      </Card>

      <Card title={`Подписки · ${fmtN(subs.total)}`}>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/admin/billing" className={!status ? "font-semibold" : ""}>
            все
          </Link>
          {STATUSES.map((s) => (
            <Link key={s} href={`/admin/billing?status=${s}`} className={status === s ? "font-semibold" : ""}>
              {s}
            </Link>
          ))}
        </div>
        <div className="mt-3">
          <Table head={["Email", "Статус", "Провайдер", "Контракт", "Валюта", "Конец периода", "Обновлена"]} empty="Подписок нет.">
            {subs.rows.map(({ s, email }) => (
              <tr key={s.id}>
                <td>{email ? <Link href={`/admin/users/${s.userId}`}>{email}</Link> : <Mono>{s.userId}</Mono>}</td>
                <td>
                  <SubStatus status={s.status} />
                </td>
                <td>{s.provider}</td>
                <td>
                  <Mono>{s.parentContractId ?? "—"}</Mono>
                </td>
                <td>{s.currency ?? "—"}</td>
                <td className="whitespace-nowrap">{fmtDt(s.periodEnd)}</td>
                <td className="whitespace-nowrap">{fmtDt(s.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        </div>
        <Pager page={page} total={subs.total} base="/admin/billing" params={{ status: statusRaw, errors: onlyErrors ? "1" : undefined, wh: String(whPage) }} />
      </Card>

      <Card title="Последние счета">
        <Table head={["Создан", "Email", "Тип", "Статус", "Сумма", "ID"]} empty="Счетов нет.">
          {invoices.map((i) => (
            <tr key={i.id}>
              <td className="whitespace-nowrap">{fmtDt(i.createdAt)}</td>
              <td>{i.userId ? <Link href={`/admin/users/${i.userId}`}>{i.email}</Link> : i.email}</td>
              <td>{i.kind}</td>
              <td>
                <Badge tone={i.status === "completed" || i.status === "subscription-active" ? "ok" : i.status === "failed" || i.status === "duplicate" ? "warn" : "mute"}>{i.status}</Badge>
              </td>
              <td className="whitespace-nowrap">{i.amount ? `${i.amount} ${i.currency ?? ""}` : "—"}</td>
              <td>
                <Mono>{i.id}</Mono>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card
        title={`Вебхуки · ${fmtN(webhooks.total)}`}
        actions={
          <Link href={onlyErrors ? "/admin/billing" : "/admin/billing?errors=1"} className="text-sm">
            {onlyErrors ? "показать все" : "только с ошибками"}
          </Link>
        }
      >
        <Table head={["Получен", "Тип", "Контракт", "Результат", ""]} empty="Вебхуков нет.">
          {webhooks.rows.map((w) => (
            <tr key={w.id}>
              <td className="whitespace-nowrap">{fmtDt(w.receivedAt)}</td>
              <td className="font-mono text-xs">{w.eventType}</td>
              <td>
                <Mono>{w.contractId ?? "—"}</Mono>
              </td>
              <td>{w.error ? <span className="text-err">{w.error}</span> : w.processedAt ? <Badge tone="ok">ok · {fmtD(w.processedAt)}</Badge> : <Badge tone="warn">не обработан</Badge>}</td>
              <td>
                <div className="flex items-center gap-2">
                  <JsonDetails summary="payload" value={w.payload} />
                  <ActionButton action={{ action: "webhook.replay", id: w.id }} confirm="Обработать событие заново? Обработчики идемпотентны, но письма пользователю могут уйти повторно.">
                    Переиграть
                  </ActionButton>
                </div>
              </td>
            </tr>
          ))}
        </Table>
        <Pager page={whPage} total={webhooks.total} base="/admin/billing" param="wh" params={{ status: statusRaw, errors: onlyErrors ? "1" : undefined, page: String(page) }} />
      </Card>
    </>
  );
}
