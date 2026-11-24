import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "@/lib/admin-auth";
import { listMail, type MailState } from "@/lib/admin";
import { smtpConfigured } from "@/lib/mail";
import { Card, Stat, Table, Pager, fmtDt, fmtN, pageNum, str } from "@/components/admin/ui";
import { ActionButton } from "@/components/admin/actions";
import { Badge } from "@/components/Section";

export const metadata: Metadata = { title: "Почта" };
export const dynamic = "force-dynamic";

const STATES: { id: MailState | ""; label: string }[] = [
  { id: "", label: "все" },
  { id: "pending", label: "в очереди" },
  { id: "failed", label: "не доставлены" },
  { id: "sent", label: "отправлены" },
];

export default async function AdminMailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const stateRaw = str(sp.state);
  const state = (["pending", "failed", "sent"] as string[]).includes(stateRaw) ? (stateRaw as MailState) : undefined;
  const page = pageNum(sp.page);
  const { rows, total, stats } = await listMail({ state, page });

  return (
    <>
      <Card title="Outbox" actions={<ActionButton action={{ action: "mail.test" }}>Отправить тестовое письмо админу</ActionButton>}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="В очереди" value={fmtN(stats.pending)} hint="jobs/outbox отправляет каждые 15 с" />
          <Stat label="Не доставлено" value={fmtN(stats.failed)} hint="исчерпаны 10 попыток" tone={stats.failed ? "err" : undefined} />
          <Stat label="SMTP" value={smtpConfigured() ? "настроен" : "не настроен"} tone={smtpConfigured() ? "ok" : "err"} className="col-span-2 sm:col-span-1" />
        </div>
      </Card>

      <Card title={`Письма · ${fmtN(total)}`}>
        <div className="flex flex-wrap gap-1.5 text-sm">
          {STATES.map((s) => (
            <Link
              key={s.id}
              href={s.id ? `/admin/mail?state=${s.id}` : "/admin/mail"}
              className={`rounded-full px-2.5 py-1 text-xs no-underline transition-colors sm:text-sm ${(state ?? "") === s.id ? "bg-accent-soft font-semibold text-accent" : "bg-bg text-mute hover:text-ink"}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <div className="mt-3">
          <Table head={["Создано", "Кому", "Тема", "Статус", ""]} empty="Писем нет.">
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap">{fmtDt(m.createdAt)}</td>
                <td className="max-md:col-span-2 break-all">{m.to}</td>
                <td className="max-md:col-span-2">
                  <details className="min-w-0">
                    <summary className="cursor-pointer">{m.subject}</summary>
                    <pre className="mt-1.5 max-h-72 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-code p-2 text-left text-[11.5px] leading-snug">{m.text}</pre>
                  </details>
                </td>
                <td className="max-md:col-span-2">
                  {m.sentAt ? (
                    <Badge tone="ok">отправлено {fmtDt(m.sentAt)}</Badge>
                  ) : m.attempts >= 10 ? (
                    <Badge tone="warn">не доставлено</Badge>
                  ) : (
                    <Badge tone="mute">
                      попытка {m.attempts} · следующая {fmtDt(m.nextAttemptAt)}
                    </Badge>
                  )}
                  {m.lastError ? <div className="mt-1 text-xs text-err">{m.lastError}</div> : null}
                </td>
                <td>
                  {!m.sentAt ? (
                    <div className="flex flex-wrap gap-2">
                      <ActionButton action={{ action: "mail.retry", id: m.id }}>Отправить снова</ActionButton>
                      <ActionButton action={{ action: "mail.delete", id: m.id }} variant="danger" confirm="Удалить письмо из очереди?">
                        Удалить
                      </ActionButton>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        </div>
        <Pager page={page} total={total} base="/admin/mail" params={{ state: stateRaw }} />
      </Card>
    </>
  );
}
