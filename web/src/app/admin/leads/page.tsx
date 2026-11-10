import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "@/lib/admin-auth";
import { listLeads } from "@/lib/admin";
import { PLAN_TITLES, SCENARIO_TITLES } from "@/lib/leads";
import { Card, Table, Pager, fmtDt, fmtN, pageNum } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Заявки" };
export const dynamic = "force-dynamic";

export default async function AdminLeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const page = pageNum(sp.page);
  const { rows, total } = await listLeads(page);

  return (
    <Card title={`Заявки на Pro / Dedicated · ${fmtN(total)}`}>
      <p className="m-0 mb-3 text-xs text-mute">Формы с /pro и /dedicated. Каждая заявка уже ушла письмом админу; здесь — архив и переход к пользователю, если он зарегистрирован.</p>
      <Table head={["Когда", "Email", "Тариф", "Сценарий", "Нужные сервисы", "Контакт", "Откуда"]} empty="Заявок нет.">
        {rows.map((l) => (
          <tr key={l.id}>
            <td className="whitespace-nowrap">{fmtDt(l.createdAt)}</td>
            <td className="break-all">
              {l.userId ? <Link href={`/admin/users/${l.userId}`}>{l.email}</Link> : <a href={`mailto:${l.email}`}>{l.email}</a>}
            </td>
            <td>{PLAN_TITLES[l.plan] ?? l.plan}</td>
            <td>{SCENARIO_TITLES[l.scenario] ?? l.scenario}</td>
            <td>{l.desiredServices.length ? l.desiredServices.join(", ") : "—"}</td>
            <td className="break-all">{l.contact || "—"}</td>
            <td className="text-xs text-mute">{l.page || "—"}</td>
          </tr>
        ))}
      </Table>
      <Pager page={page} total={total} base="/admin/leads" />
    </Card>
  );
}
