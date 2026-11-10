import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "@/lib/admin-auth";
import { adminOverview } from "@/lib/admin";
import { Card, Stat, Table, fmtDt, fmtN, ago, JsonDetails } from "@/components/admin/ui";
import { Badge } from "@/components/Section";

export const metadata: Metadata = { title: "Обзор" };
export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  await requireAdminPage();
  const now = new Date();
  const o = await adminOverview(now);
  const staleNodes = o.nodes.filter((n) => n.stale);
  const problems: { text: string; href: string }[] = [];
  if (staleNodes.length) problems.push({ text: `Ноды без связи >10 мин: ${staleNodes.map((n) => n.name).join(", ")}`, href: "/admin/infra" });
  if (o.cert && o.cert.daysLeft !== null && o.cert.daysLeft <= 14) problems.push({ text: `Единый сертификат истекает через ${o.cert.daysLeft} дн.`, href: "/admin/infra" });
  if (!o.cert) problems.push({ text: "На control plane нет боевого сертификата (CERT_DIR пуст или самоподписанный)", href: "/admin/infra" });
  if (o.mail.failed) problems.push({ text: `Недоставленных писем: ${o.mail.failed}`, href: "/admin/mail?state=failed" });
  if (o.webhooks.errors7d) problems.push({ text: `Ошибок обработки вебхуков за 7 дней: ${o.webhooks.errors7d}`, href: "/admin/billing?errors=1" });
  if (o.subs.past_due) problems.push({ text: `Подписок с проблемой оплаты: ${o.subs.past_due}`, href: "/admin/users?status=past_due" });

  return (
    <>
      {problems.length ? (
        <div className="note" role="status">
          <strong>Требует внимания:</strong>
          <ul className="m-0 mt-1 list-disc pl-5 text-sm">
            {problems.map((p) => (
              <li key={p.text}>
                <Link href={p.href}>{p.text}</Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-xl border border-ok bg-ok-bg px-4 py-3 text-sm text-ok">Проблем не обнаружено: ноды на связи, сертификат в порядке, почта и вебхуки без ошибок.</div>
      )}

      <Card title="Пользователи и подписки">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Пользователей" value={fmtN(o.users.total)} hint={`+${o.users.new24h} за сутки · +${o.users.new7d} за неделю`} />
          <Stat label="Pro-доступ (proxy)" value={fmtN(o.proxyUsers)} hint="подписка действует" tone="ok" />
          <Stat label="active" value={fmtN(o.subs.active ?? 0)} />
          <Stat label="past_due" value={fmtN(o.subs.past_due ?? 0)} tone={o.subs.past_due ? "warn" : undefined} />
          <Stat label="cancelled" value={fmtN(o.subs.cancelled ?? 0)} hint="до конца периода" />
          <Stat label="expired / pending" value={`${fmtN(o.subs.expired ?? 0)} / ${fmtN(o.subs.pending ?? 0)}`} />
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <Link href="/admin/users">Все пользователи →</Link>
          <Link href="/admin/users?status=active">Активные</Link>
          <Link href="/admin/users?status=past_due">Проблема с оплатой</Link>
          <Link href="/admin/users?status=none">Без подписки</Link>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="DNS за 24 часа">
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="Пользователей" value={fmtN(o.dns.users24h)} />
            <Stat label="Устройств (IP-хэшей)" value={fmtN(o.dns.devices24h)} />
            <Stat label="Запросов" value={fmtN(o.dns.queries24h)} />
          </div>
          <p className="m-0 mt-3 text-xs text-mute">
            Динамический ACL: {fmtN(o.aclDynamic)} IP · версии policy {o.versions.policy} / acl {o.versions.acl}. Free-кластер — на <Link href="/stats">/stats</Link>.
          </p>
        </Card>
        <Card title="Деньги за 30 дней" actions={<Link href="/admin/billing" className="text-sm">Биллинг →</Link>}>
          {o.revenue30d.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {o.revenue30d.map((r) => (
                <Stat key={r.currency} label={`Оплачено, ${r.currency}`} value={`${Number(r.amount).toLocaleString("ru-RU")} ${r.currency}`} hint={`${r.count} платежей`} tone="ok" />
              ))}
            </div>
          ) : (
            <p className="m-0 text-sm text-mute">Оплаченных счетов за 30 дней нет.</p>
          )}
          <p className="m-0 mt-3 text-xs text-mute">
            Вебхуков за 7 дней: {fmtN(o.webhooks.total7d)}, с ошибками: {fmtN(o.webhooks.errors7d)}. Заявок за 7 дней: {fmtN(o.leads7d)} (<Link href="/admin/leads">список</Link>).
          </p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Ноды" actions={<Link href="/admin/infra" className="text-sm">Инфраструктура →</Link>}>
          <Table head={["Нода", "Тип", "IP", "Контакт"]} empty="Ноды не зарегистрированы — добавьте на странице «Инфраструктура».">
            {o.nodes.map((n) => (
              <tr key={n.id}>
                <td className="font-semibold">
                  {n.name}
                  {!n.enabled ? <Badge tone="mute">off</Badge> : null}
                </td>
                <td>{n.kind}</td>
                <td className="font-mono">{n.ip ?? "—"}</td>
                <td className={n.stale ? "text-err" : "text-ok"}>{ago(n.lastSeenAt, now)}</td>
              </tr>
            ))}
          </Table>
          <p className="m-0 mt-3 text-xs text-mute">
            Сертификат: {o.cert ? `${o.cert.daysLeft} дн. (до ${fmtDt(o.cert.notAfter)})` : "нет на CP"} · Почта: в очереди {o.mail.pending}, не доставлено {o.mail.failed}.
          </p>
        </Card>
        <Card title="Последние действия" actions={<Link href="/admin/audit" className="text-sm">Журнал →</Link>}>
          <Table head={["Когда", "Действие", "Детали"]} empty="Действий администратора ещё не было.">
            {o.audit.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap">{fmtDt(a.at)}</td>
                <td className="font-mono text-xs">{a.action}</td>
                <td>
                  <JsonDetails summary={String((a.details as Record<string, unknown> | null)?.email ?? (a.details as Record<string, unknown> | null)?.name ?? "детали")} value={a.details} />
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
