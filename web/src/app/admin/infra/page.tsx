import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/admin-auth";
import { listNodes, NODE_STALE_MS } from "@/lib/admin";
import { policyVersion } from "@/lib/policy";
import { aclVersion, buildAclSnapshot } from "@/lib/acl";
import { certStatus, renewCommand, acmeTxtRecords } from "@/jobs/certwatch";
import { env } from "@/lib/env";
import { catalog, totalDomains, totalServices } from "@/lib/catalog";
import { Card, Stat, Table, Mono, JsonDetails, fmtD, fmtDt, fmtN, ago } from "@/components/admin/ui";
import { ActionButton, AddNodeForm } from "@/components/admin/actions";
import { Badge } from "@/components/Section";

export const metadata: Metadata = { title: "Инфраструктура" };
export const dynamic = "force-dynamic";

export default async function AdminInfraPage() {
  await requireAdminPage();
  const now = new Date();
  const [nodes, policyV, aclV, acl, cert] = await Promise.all([listNodes(), policyVersion(), aclVersion(), buildAclSnapshot(now), certStatus(now)]);
  const e = env();
  const stale = (n: (typeof nodes)[number]) => n.enabled && (!n.lastSeenAt || now.getTime() - n.lastSeenAt.getTime() > NODE_STALE_MS);
  const certTone = cert.daysLeft === null ? "err" : cert.daysLeft <= 7 ? "err" : cert.daysLeft <= 25 ? "warn" : "ok";

  return (
    <>
      <Card
        title="Ноды"
        actions={
          <>
            <ActionButton action={{ action: "nodes.push", what: "policy" }}>Разослать политику</ActionButton>
            <ActionButton action={{ action: "nodes.push", what: "acl" }}>Разослать ACL</ActionButton>
          </>
        }
      >
        <p className="m-0 mb-3 text-xs text-mute">
          Ноды держат long-poll к CP (policy v{policyV}, acl v{aclV}); «последний контакт» старше 10 минут — нода отвалилась или секрет неверный. ACL сейчас: {fmtN(acl.static.length)} статических IP,{" "}
          {fmtN(acl.dynamic.length)} динамических.{" "}
          <a href="/api/admin/snapshot?kind=policy" target="_blank" rel="noopener">
            policy.json
          </a>{" "}
          ·{" "}
          <a href="/api/admin/snapshot?kind=acl" target="_blank" rel="noopener">
            acl.json
          </a>
        </p>
        <Table head={["Нода", "Тип", "IP", "Последний контакт", "Здоровье", ""]} empty="Ноды не зарегистрированы.">
          {nodes.map((n) => (
            <tr key={n.id}>
              <td className="font-semibold">
                {n.name} {!n.enabled ? <Badge tone="mute">off</Badge> : null}
                {n.tenantUserId ? <div className="text-xs text-mute">арендатор {n.tenantUserId.slice(0, 8)}…</div> : null}
              </td>
              <td>{n.kind}</td>
              <td>
                <Mono>{n.ip ?? "—"}</Mono>
              </td>
              <td className={stale(n) ? "text-err" : n.enabled ? "text-ok" : "text-mute"}>
                {ago(n.lastSeenAt, now)}
                <div className="text-xs text-mute">{fmtDt(n.lastSeenAt)} · создана {fmtD(n.createdAt)}</div>
              </td>
              <td>{n.lastHealth ? <JsonDetails summary="last_health" value={n.lastHealth} /> : <span className="text-mute">—</span>}</td>
              <td>
                <div className="flex flex-wrap gap-2">
                  <ActionButton action={{ action: "node.enabled", id: n.id, enabled: !n.enabled }} confirm={n.enabled ? `Отключить ноду ${n.name}? Её запросы к CP будут отвергаться (401).` : undefined}>
                    {n.enabled ? "Отключить" : "Включить"}
                  </ActionButton>
                  <ActionButton action={{ action: "node.delete", id: n.id }} variant="danger" confirm={`Удалить ноду ${n.name} безвозвратно? Секрет перестанет работать.`}>
                    Удалить
                  </ActionButton>
                </div>
              </td>
            </tr>
          ))}
        </Table>
        <h3 className="mb-2 mt-5 text-sm font-semibold">Зарегистрировать ноду</h3>
        <AddNodeForm />
      </Card>

      <Card title="Единый сертификат">
        <div className="grid gap-2 sm:grid-cols-3">
          <Stat label="Эталон" value={cert.source === "cp" ? "файл на CP" : cert.source === "tls" ? "TLS сайта" : "не найден"} hint={cert.source === "cp" ? e.CERT_DIR : undefined} tone={cert.source ? undefined : "err"} />
          <Stat label="Осталось дней" value={cert.daysLeft ?? "?"} hint={cert.notAfter ? `до ${fmtD(cert.notAfter)}` : undefined} tone={certTone} />
          <Stat label="Имена" value={<span className="text-sm">{cert.names.join(", ") || "?"}</span>} />
        </div>
        <div className="mt-3">
          <Table head={["Хост", "Отдаёт до", "Дней", "Совпадает с эталоном"]}>
            {cert.hosts.map((h) => (
              <tr key={h.host}>
                <td className="font-mono">{h.host}</td>
                <td>{h.peer ? fmtD(h.peer.notAfter) : <span className="text-err">недоступен</span>}</td>
                <td>{h.daysLeft ?? "—"}</td>
                <td>{h.current === null ? "—" : h.current ? <Badge tone="ok">текущий</Badge> : <Badge tone="warn">старый сертификат</Badge>}</td>
              </tr>
            ))}
          </Table>
        </div>
        <p className="m-0 mt-3 text-xs text-mute">
          Продление вручную на CP: <code className="chip">{renewCommand()}</code>; TXT-записи: {acmeTxtRecords().join("; ")}. Ноды заберут сертификат по таймеру в течение часа.
        </p>
      </Card>

      <Card title="Окружение control plane">
        <dl className="m-0 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {[
            ["PUBLIC_ORIGIN", e.PUBLIC_ORIGIN],
            ["Free DNS", `${catalog.free.domain} → ${e.FREE_DNS_IP}`],
            ["Pro DNS", `${catalog.pro?.domain ?? e.PRO_DOMAIN} → ${catalog.pro?.dns_ip || e.PRO_DNS_IP || "?"}`],
            ["Каталог", `${totalServices()} сервисов, ${catalog.categories.length} категорий, ${totalDomains()} доменов (services.yaml)`],
            ["Grace / ACL TTL / IP на аккаунт", `${e.GRACE_DAYS} дн. / ${e.ACL_DYNAMIC_TTL_MINUTES} мин / ${e.MAX_BOUND_IPS}`],
            ["Google OAuth", e.AUTH_GOOGLE_ID ? "включён" : "выключен"],
            ["SMTP", `${e.SMTP_HOST}:${e.SMTP_PORT} (${e.SMTP_USERNAME ? "с авторизацией" : "без логина"}) от ${e.MAIL_FROM}`],
            ["Админы", [...new Set(`${e.ADMIN_EMAILS},${e.ADMIN_EMAIL}`.split(",").map((s) => s.trim()).filter(Boolean))].join(", ")],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-line py-1">
              <dt className="text-mute">{k}</dt>
              <dd className="m-0 text-right font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}
