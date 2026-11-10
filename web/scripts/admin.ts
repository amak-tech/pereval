/**
 * Админ-CLI control plane. Запуск: `pnpm admin <команда>` (локально) или
 * `docker compose exec app node dist/admin.mjs <команда>` на сервере.
 * Те же действия доступны в веб-панели /admin (ADMIN_EMAILS); логика общая — src/lib/admin.ts, всё пишется в audit_log.
 *
 *   users                         список пользователей
 *   subs                          подписки
 *   grant <email> <days>          выдать/продлить доступ вручную (без оплаты)
 *   revoke <email>                отключить доступ (expired)
 *   node add <name> <kind> [ip]   зарегистрировать ноду (kind: free_primary | pro_dns | pro_worker | dedicated); печатает секрет один раз
 *   node list
 *   resend-link <email>           отправить ссылку входа
 *   webhook replay <id>           переиграть сохранённый вебхук
 *   cert names | cert status      имена единого сертификата (для deploy/issue-cert.sh) | что лежит на CP и что отдают хосты
 *   policy | acl                  показать текущий снапшот
 */
import { desc, eq } from "drizzle-orm";
import { db, schema, sql } from "@/lib/db/client";
import { findUserByEmail } from "@/lib/auth-core";
import { buildPolicySnapshot } from "@/lib/policy";
import { buildAclSnapshot } from "@/lib/acl";
import * as admin from "@/lib/admin";

const CLI: admin.Admin = { id: null, email: `cli:${process.env.USER ?? "root"}` };

async function userIdByEmail(email: string): Promise<string> {
  const user = await findUserByEmail(email);
  if (!user) throw new Error("пользователь не найден");
  return user.id;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "users": {
      const rows = await db().select().from(schema.users).orderBy(desc(schema.users.id)).limit(200);
      for (const u of rows) console.log(`${u.id}\t${u.email}\t${u.emailVerified ? "verified" : ""}`);
      return 0;
    }
    case "subs": {
      const rows = await db()
        .select({ s: schema.subscriptions, email: schema.users.email })
        .from(schema.subscriptions)
        .leftJoin(schema.users, eq(schema.users.id, schema.subscriptions.userId))
        .orderBy(desc(schema.subscriptions.updatedAt))
        .limit(200);
      for (const { s, email } of rows) console.log(`${email}\t${s.status}\tperiod_end=${s.periodEnd?.toISOString() ?? "-"}\tcontract=${s.parentContractId ?? "-"}`);
      return 0;
    }
    case "grant": {
      const [email, daysRaw] = rest;
      const days = Number(daysRaw ?? "30");
      if (!email || !Number.isFinite(days)) throw new Error("grant <email> <days>");
      const r = await admin.grantAccessByEmail(CLI, email, days);
      console.log(`ok: ${r.email} active до ${r.periodEnd.toISOString()}, токен ${r.token}`);
      return 0;
    }
    case "revoke": {
      const [email] = rest;
      if (!email) throw new Error("revoke <email>");
      await admin.revokeAccess(CLI, await userIdByEmail(email));
      console.log("ok");
      return 0;
    }
    case "node": {
      const [sub, name, kind, ip] = rest;
      if (sub === "list") {
        for (const n of await admin.listNodes()) console.log(`${n.name}\t${n.kind}\t${n.ip ?? "-"}\t${n.enabled ? "on" : "off"}\tlast_seen=${n.lastSeenAt?.toISOString() ?? "-"}`);
        return 0;
      }
      if (sub !== "add" || !name || !kind) throw new Error(`node add <name> <${admin.NODE_KINDS.join("|")}> [ip]`);
      const { secret } = await admin.addNode(CLI, name, kind, ip ?? null);
      console.log(`Нода ${name} создана. Секрет (показывается один раз):\n${secret}\n\nЗапишите его в /etc/pereval/node.env как NODE_SECRET.`);
      return 0;
    }
    case "resend-link": {
      const [email] = rest;
      if (!email) throw new Error("resend-link <email>");
      const { ensureUserByEmail } = await import("@/lib/auth-core");
      const user = await ensureUserByEmail(email);
      const r = await admin.issueLoginLink(CLI, user.id);
      console.log(`ссылка поставлена в очередь; для ручной выдачи: ${r.url}`);
      return 0;
    }
    case "cert": {
      const [sub] = rest;
      const cw = await import("@/jobs/certwatch");
      if (sub === "names") {
        console.log(cw.certNames().join(" "));
        return 0;
      }
      if (sub !== "status") throw new Error("cert names | cert status");
      const st = await cw.certStatus();
      console.log(`эталон: ${st.source ?? "нет"}; до ${st.notAfter?.toISOString().slice(0, 10) ?? "?"} (${st.daysLeft ?? "?"} дн.); имена: ${st.names.join(", ") || "?"}`);
      for (const h of st.hosts) console.log(cw.formatHostLine(h));
      console.log(`TXT при продлении: ${cw.acmeTxtRecords().join("; ")}`);
      return 0;
    }
    case "webhook": {
      const [sub, id] = rest;
      if (sub !== "replay" || !id) throw new Error("webhook replay <id>");
      const r = await admin.replayWebhookEvent(CLI, id);
      console.log(`ok: ${r.type}`);
      return 0;
    }
    case "policy":
      console.log(JSON.stringify(await buildPolicySnapshot(), null, 2));
      return 0;
    case "acl":
      console.log(JSON.stringify(await buildAclSnapshot(), null, 2));
      return 0;
    default:
      console.log("команды: users | subs | grant <email> <days> | revoke <email> | node add <name> <kind> [ip] | node list | resend-link <email> | webhook replay <id> | cert names|status | policy | acl");
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2))
  .then(async (code) => {
    await sql().end({ timeout: 2 });
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(String((err as Error)?.message ?? err));
    await sql().end({ timeout: 2 }).catch(() => undefined);
    process.exit(1);
  });
