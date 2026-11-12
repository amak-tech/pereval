import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/admin-auth";
import { getDefaultNodeMaxClients, getNodeWatchStatus, listNodes, NODE_STALE_MS } from "@/lib/admin";
import { collectMonitoredTargets } from "@/jobs/nodewatch";
import { policyVersion } from "@/lib/policy";
import { aclVersion, buildAclSnapshot } from "@/lib/acl";
import { certStatus, renewCommand, acmeTxtRecords } from "@/jobs/certwatch";
import { env } from "@/lib/env";
import { catalog, totalDomains, totalServices } from "@/lib/catalog";
import { Card, Stat, Table, Mono, JsonDetails, fmtD, fmtDt, fmtN, ago } from "@/components/admin/ui";
import { ActionButton, AddNodeForm, NodeMaxClientsForm } from "@/components/admin/actions";
import { Badge } from "@/components/Section";

export const metadata: Metadata = { title: "Инфраструктура" };
export const dynamic = "force-dynamic";

export default async function AdminInfraPage() {
  await requireAdminPage();
  const now = new Date();
  const [nodes, policyV, aclV, acl, cert, defaultMaxClients, nodewatch] = await Promise.all([
    listNodes(),
    policyVersion(),
    aclVersion(),
    buildAclSnapshot(now),
    certStatus(now),
    getDefaultNodeMaxClients(),
    getNodeWatchStatus(),
  ]);
  const e = env();
  const stale = (n: (typeof nodes)[number]) => n.enabled && (!n.lastSeenAt || now.getTime() - n.lastSeenAt.getTime() > NODE_STALE_MS);
  const certTone = cert.daysLeft === null ? "err" : cert.daysLeft <= 7 ? "err" : cert.daysLeft <= 25 ? "warn" : "ok";
  const loadRows =
    nodewatch?.nodes ??
    collectMonitoredTargets(defaultMaxClients).map((t) => ({
      ...t,
      onlineUsers5m: null,
      activeConnections: null,
      overloaded: false,
      reachable: false,
      checkedAt: "",
      alertedAt: null,
    }));

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

      <Card title="Нагрузка прокси-воркеров (nodewatch)">
        <p className="m-0 mb-3 text-xs text-mute">
          Задача <code>nodewatch</code> раз в минуту опрашивает <code>/node-stats.json</code> у всех воркеров Free и Pro и отправляет email-алерт при <code>online_users_5m ≥ max_clients</code> (кулдаун {e.NODE_ALERT_COOLDOWN_MINUTES} мин, сброс при ≤ 80% порога).
          {nodewatch?.checkedAt ? ` Последняя проверка: ${fmtDt(new Date(nodewatch.checkedAt))}.` : " Опрос ещё не выполнялся."}
        </p>
        <Table head={["Нода", "Кластер / Пулы", "IP", "Клиенты (5 мин) / Порог", "TCP-соединения", "Статус"]} empty="Воркеры не найдены в каталоге.">
          {loadRows.map((row) => (
            <tr key={`${row.tier}:${row.ip}`}>
              <td className="font-semibold">{row.name}</td>
              <td>
                <Badge tone={row.tier === "pro" ? "accent" : "mute"}>{row.tier === "pro" ? "Pro" : "Free"}</Badge>{" "}
                <span className="text-xs text-mute">{row.pools.join(", ")}</span>
              </td>
              <td>
                <Mono>{row.ip}</Mono>
              </td>
              <td className={row.overloaded ? "font-semibold text-err" : ""}>
                {row.onlineUsers5m !== null ? fmtN(row.onlineUsers5m) : "—"} / {fmtN(row.maxClients)}
              </td>
              <td>{row.activeConnections !== null ? fmtN(row.activeConnections) : "—"}</td>
              <td>
                {!row.checkedAt ? (
                  <span className="text-mute">ожидание опроса</span>
                ) : !row.reachable ? (
                  <Badge tone="warn">недоступна</Badge>
                ) : row.overloaded ? (
                  <Badge tone="warn">перегрузка</Badge>
                ) : (
                  <Badge tone="ok">норма</Badge>
                )}
              </td>
            </tr>
          ))}
        </Table>
        <div className="mt-4">
          <NodeMaxClientsForm defaultMaxClients={defaultMaxClients} />
        </div>
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
