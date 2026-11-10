import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "@/lib/admin-auth";
import { listAudit } from "@/lib/admin";
import { Card, Table, Pager, JsonDetails, fmtDt, fmtN, pageNum } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Журнал" };
export const dynamic = "force-dynamic";

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const page = pageNum(sp.page);
  const { rows, total } = await listAudit(page);

  return (
    <Card title={`Журнал действий · ${fmtN(total)}`}>
      <p className="m-0 mb-3 text-xs text-mute">Все мутации из админ-панели и CLI (`pnpm admin`): кто, что и с кем. Хранится в таблице audit_log.</p>
      <Table head={["Когда", "Действие", "Админ", "Цель", "Детали"]} empty="Записей нет.">
        {rows.map((a) => {
          const d = (a.details ?? {}) as Record<string, unknown>;
          const target = typeof d.targetUserId === "string" ? d.targetUserId : null;
          return (
            <tr key={a.id}>
              <td className="whitespace-nowrap">{fmtDt(a.at)}</td>
              <td className="font-mono text-xs">{a.action}</td>
              <td className="break-all">{String(d.admin ?? "—")}</td>
              <td className="break-all">{target ? <Link href={`/admin/users/${target}`}>{String(d.email ?? target)}</Link> : String(d.email ?? d.name ?? d.to ?? "—")}</td>
              <td>
                <JsonDetails summary="json" value={a.details} />
              </td>
            </tr>
          );
        })}
      </Table>
      <Pager page={page} total={total} base="/admin/audit" />
    </Card>
  );
}
