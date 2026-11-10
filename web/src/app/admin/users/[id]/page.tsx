import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/admin-auth";
import { userDetail } from "@/lib/admin";
import { catalog } from "@/lib/catalog";
import { Card, Stat, Table, Mono, SubStatus, ModeBadge, JsonDetails, fmtD, fmtDt, fmtN, ago } from "@/components/admin/ui";
import { ActionButton, GrantForm } from "@/components/admin/actions";
import { Badge } from "@/components/Section";

export const metadata: Metadata = { title: "Пользователь" };
export const dynamic = "force-dynamic";

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  const now = new Date();
  const d = await userDetail(id, now);
  if (!d) notFound();
  const proDomain = catalog.pro?.domain ?? "pro.pereval.top";
  const activeToken = d.tokens.find((t) => !t.revokedAt) ?? null;
  const catName = new Map(catalog.categories.map((c) => [c.id, c.name]));
  const hasActive = d.subscriptions.some((s) => s.status === "active" || s.status === "past_due" || s.status === "cancelled");

  return (
    <>
      <p className="m-0 text-sm">
        <Link href="/admin/users">← Пользователи</Link>
      </p>

      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            {d.user.email} <ModeBadge mode={d.mode} />
          </span>
        }
        actions={
          <>
            <ActionButton action={{ action: "user.login_link", userId: id }}>Ссылка входа</ActionButton>
            {hasActive ? (
              <ActionButton action={{ action: "user.revoke", userId: id }} variant="danger" confirm={`Отключить доступ для ${d.user.email}? Подписки в базе станут expired; автосписание в lava.top это не отменяет.`}>
                Отключить доступ
              </ActionButton>
            ) : null}
          </>
        }
      >
        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label="Доступ до" value={d.accessUntil ? fmtD(d.accessUntil) : "—"} tone={d.mode === "proxy" ? "ok" : undefined} />
          <Stat label="Зарегистрирован" value={fmtD(d.meta?.createdAt)} hint={d.accounts.length ? `вход: ${d.accounts.map((a) => a.provider).join(", ")}` : "вход по ссылке"} />
          <Stat label="Последний вход" value={fmtD(d.meta?.lastLoginAt)} hint={d.meta?.lastLoginAt ? ago(d.meta.lastLoginAt, now) : undefined} />
          <Stat label="ID" value={<Mono>{d.user.id.slice(0, 8)}…</Mono>} hint={d.user.name ?? undefined} />
        </div>
        <div className="mt-4">
          <GrantForm userId={id} />
        </div>
      </Card>

      <Card title="Подписки">
        <Table head={["Статус", "Провайдер", "Контракт", "Валюта", "Начало", "Конец периода", "Отменена", "Обновлена"]} empty="Подписок нет.">
          {d.subscriptions.map((s) => (
            <tr key={s.id}>
              <td>
                <SubStatus status={s.status} />
              </td>
              <td>{s.provider}</td>
              <td>
                <Mono>{s.parentContractId ?? "—"}</Mono>
              </td>
              <td>{s.currency ?? "—"}</td>
              <td className="whitespace-nowrap">{fmtD(s.startedAt)}</td>
              <td className="whitespace-nowrap">{fmtDt(s.periodEnd)}</td>
              <td className="whitespace-nowrap">{fmtDt(s.cancelledAt)}</td>
              <td className="whitespace-nowrap">{fmtDt(s.updatedAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Доступ: токен и адреса"
          actions={
            activeToken ? (
              <ActionButton action={{ action: "user.rotate_token", userId: id }} confirm="Перевыпустить токен? Пользователю придётся перенастроить устройства (старый работает ещё 48 ч).">
                Перевыпустить токен
              </ActionButton>
            ) : null
          }
        >
          {activeToken ? (
            <dl className="m-0 grid gap-1 text-sm">
              <div>
                <dt className="text-xs text-mute">Токен</dt>
                <dd className="m-0">
                  <Mono>{activeToken.token}</Mono>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-mute">DoH / DoT</dt>
                <dd className="m-0">
                  <Mono>https://{proDomain}/dns/{activeToken.token}</Mono>
                  <br />
                  <Mono>
                    {activeToken.token}.{proDomain}
                  </Mono>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="m-0 text-sm text-mute">Активного токена нет — появится при выдаче доступа.</p>
          )}
          {d.tokens.filter((t) => t.revokedAt).length ? (
            <p className="m-0 mt-2 text-xs text-mute">Отозванных токенов: {d.tokens.filter((t) => t.revokedAt).length}, последний — {fmtDt(d.tokens.find((t) => t.revokedAt)?.revokedAt)}.</p>
          ) : null}
          <h3 className="mb-2 mt-4 text-sm font-semibold">Привязанные IP ({d.boundIps.length})</h3>
          <Table head={["IP", "Тип", "Метка", "Обновлён", ""]} empty="Привязанных IP нет.">
            {d.boundIps.map((b) => (
              <tr key={b.id}>
                <td>
                  <Mono>{b.ip ? String(b.ip) : "ожидает"}</Mono>
                </td>
                <td>
                  {b.kind}
                  {b.hostname ? <div className="text-xs text-mute">{b.hostname}</div> : null}
                </td>
                <td>
                  {b.label}
                  {b.lastError ? <div className="text-xs text-warn">{b.lastError}</div> : null}
                </td>
                <td className="whitespace-nowrap">{fmtDt(b.lastResolvedAt ?? b.updatedAt)}</td>
                <td>
                  <ActionButton action={{ action: "user.remove_ip", userId: id, ipId: b.id }} variant="danger" confirm="Удалить привязку IP?">
                    Удалить
                  </ActionButton>
                </td>
              </tr>
            ))}
          </Table>
          <p className="m-0 mt-3 text-xs text-mute">
            DDNS-ключ: {d.ddnsKey ? `выпущен ${fmtD(d.ddnsKey.createdAt)}, использован ${fmtDt(d.ddnsKey.lastUsedAt)}` : "не выпущен"}. Динамический ACL сейчас:{" "}
            {d.aclDynamic.length ? d.aclDynamic.map((a) => a.ip).join(", ") : "нет IP"}.
          </p>
          <p className="m-0 mt-1 text-xs text-mute">
            Выключенные категории:{" "}
            {d.disabledCategories.length
              ? d.disabledCategories.map((c) => (
                  <Badge key={c} tone="mute">
                    {catName.get(c) ?? c}
                  </Badge>
                ))
              : "нет"}
          </p>
        </Card>

        <Card title="DNS-активность за 14 дней">
          <Table head={["День (UTC)", "Устройств", "Запросов"]} empty="Запросов с токеном не было.">
            {d.activity.map((a) => (
              <tr key={a.day}>
                <td className="font-mono">{a.day}</td>
                <td>{a.devices}</td>
                <td>{fmtN(a.queries)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Счета">
        <Table head={["Создан", "Тип", "Статус", "Сумма", "ID (lava.top)", ""]} empty="Счетов нет.">
          {d.invoices.map((i) => (
            <tr key={i.id}>
              <td className="whitespace-nowrap">{fmtDt(i.createdAt)}</td>
              <td>{i.kind}</td>
              <td>
                <Badge tone={i.status === "completed" || i.status === "subscription-active" ? "ok" : i.status === "failed" || i.status === "duplicate" ? "warn" : "mute"}>{i.status}</Badge>
              </td>
              <td className="whitespace-nowrap">{i.amount ? `${i.amount} ${i.currency ?? ""}` : "—"}</td>
              <td>
                <Mono>{i.id}</Mono>
                {i.paymentUrl && i.status === "new" ? (
                  <div>
                    <a href={i.paymentUrl} target="_blank" rel="noopener" className="text-xs">
                      ссылка на оплату
                    </a>
                  </div>
                ) : null}
              </td>
              <td>
                <JsonDetails summary="raw" value={i.raw} />
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Вебхуки по контрактам">
          <Table head={["Получен", "Тип", "Результат", ""]} empty="Вебхуков по контрактам пользователя нет.">
            {d.webhooks.map((w) => (
              <tr key={w.id}>
                <td className="whitespace-nowrap">{fmtDt(w.receivedAt)}</td>
                <td className="font-mono text-xs">{w.eventType}</td>
                <td>{w.error ? <span className="text-err">{w.error}</span> : w.processedAt ? <Badge tone="ok">ok</Badge> : <Badge tone="warn">не обработан</Badge>}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <JsonDetails summary="payload" value={w.payload} />
                    {w.error ? <ActionButton action={{ action: "webhook.replay", id: w.id }}>Переиграть</ActionButton> : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Журнал действий">
          <Table head={["Когда", "Действие", "Детали"]} empty="Действий по пользователю не было.">
            {d.audit.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap">{fmtDt(a.at)}</td>
                <td className="font-mono text-xs">{a.action}</td>
                <td>
                  <JsonDetails summary={String((a.details as Record<string, unknown> | null)?.admin ?? "детали")} value={a.details} />
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
