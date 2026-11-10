import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "@/lib/admin-auth";
import { listUsers, USER_STATUS_FILTERS, type UserStatusFilter } from "@/lib/admin";
import { Card, Table, Pager, SubStatus, ModeBadge, fmtD, fmtDt, fmtN, pageNum, str } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Пользователи" };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminUsersPage({ searchParams }: { searchParams: SP }) {
  await requireAdminPage();
  const sp = await searchParams;
  const q = str(sp.q);
  const statusRaw = str(sp.status);
  const status = (USER_STATUS_FILTERS as readonly string[]).includes(statusRaw) ? (statusRaw as UserStatusFilter) : undefined;
  const page = pageNum(sp.page);
  const { rows, total } = await listUsers({ q, status, page });

  return (
    <Card title={`Пользователи · ${fmtN(total)}`}>
      <form method="get" className="flex flex-wrap items-center gap-2">
        <input name="q" defaultValue={q} placeholder="поиск по email" className="w-64 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm text-ink outline-none focus:border-accent" aria-label="Поиск по email" />
        <select name="status" defaultValue={statusRaw} className="rounded-lg border border-line bg-bg px-3 py-1.5 text-sm text-ink" aria-label="Статус подписки">
          <option value="">все статусы</option>
          {USER_STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "none" ? "без подписки" : s}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-secondary !px-3 !py-1.5 !text-xs">
          Найти
        </button>
        {q || status ? (
          <Link href="/admin/users" className="text-xs">
            сбросить
          </Link>
        ) : null}
      </form>
      <div className="mt-4">
        <Table head={["Email", "Подписка", "Доступ до", "Режим", "IP", "DNS 24 ч", "Зарегистрирован", "Вход"]} empty="Никого не найдено.">
          {rows.map((u) => (
            <tr key={u.id}>
              <td>
                <Link href={`/admin/users/${u.id}`} className="font-semibold">
                  {u.email}
                </Link>
                {u.name ? <div className="text-xs text-mute">{u.name}</div> : null}
              </td>
              <td>
                <SubStatus status={u.status} />
                {u.provider === "manual" ? <div className="text-xs text-mute">вручную</div> : null}
              </td>
              <td className="whitespace-nowrap">{fmtD(u.periodEnd)}</td>
              <td>
                <ModeBadge mode={u.mode} />
                {!u.hasToken ? <div className="text-xs text-mute">нет токена</div> : null}
              </td>
              <td>{u.ips || "—"}</td>
              <td className="whitespace-nowrap">{u.queries24h ? `${fmtN(u.queries24h)} · ${u.devices24h} устр.` : "—"}</td>
              <td className="whitespace-nowrap">{fmtD(u.createdAt)}</td>
              <td className="whitespace-nowrap">{fmtDt(u.lastLoginAt)}</td>
            </tr>
          ))}
        </Table>
      </div>
      <Pager page={page} total={total} base="/admin/users" params={{ q, status: statusRaw }} />
    </Card>
  );
}
