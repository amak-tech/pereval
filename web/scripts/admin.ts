/**
 * Админ-CLI control plane. Запуск: `pnpm admin <команда>` (локально) или
 * `docker compose exec app node dist/admin.mjs <команда>` на сервере.
 *
 *   users                         список пользователей
 *   subs                          подписки
 *   grant <email> <days>          выдать/продлить доступ вручную (без оплаты)
 *   revoke <email>                отключить доступ (expired)
 *   node add <name> <kind> [ip]   зарегистрировать ноду (kind: pro_dns | pro_worker | dedicated); печатает секрет один раз
 *   node list
 *   resend-link <email>           отправить ссылку входа
 *   webhook replay <id>           переиграть сохранённый вебхук
 *   policy | acl                  показать текущий снапшот
 */
import { desc, eq } from "drizzle-orm";
import { db, schema, sql } from "@/lib/db/client";
import { createNode } from "@/lib/nodes";
import { ensureUserByEmail, createLoginLink } from "@/lib/auth";
import { enqueueMail } from "@/lib/mail";
import { magicLinkMail } from "@/lib/mail-templates";
import { bumpPolicyVersion, buildPolicySnapshot } from "@/lib/policy";
import { bumpAclVersion, buildAclSnapshot } from "@/lib/acl";
import { ensureAccessToken, parseWebhook } from "@/lib/billing";
import { addPeriod } from "@/lib/subscription";

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
      const user = await ensureUserByEmail(email);
      const now = new Date();
      const [existing] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.userId, user.id)).orderBy(desc(schema.subscriptions.updatedAt)).limit(1);
      const base = existing?.periodEnd && existing.periodEnd > now ? existing.periodEnd : now;
      const periodEnd = days === 30 ? addPeriod(base, "MONTHLY") : new Date(base.getTime() + days * 86_400_000);
      if (existing) {
        await db().update(schema.subscriptions).set({ status: "active", periodEnd, updatedAt: now }).where(eq(schema.subscriptions.id, existing.id));
      } else {
        await db().insert(schema.subscriptions).values({ userId: user.id, provider: "manual", status: "active", startedAt: now, periodEnd, updatedAt: now });
      }
      const token = await ensureAccessToken(user.id);
      await bumpPolicyVersion("admin.grant");
      await bumpAclVersion("admin.grant");
      console.log(`ok: ${email} active до ${periodEnd.toISOString()}, токен ${token}`);
      return 0;
    }
    case "revoke": {
      const [email] = rest;
      if (!email) throw new Error("revoke <email>");
      const [user] = await db().select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1);
      if (!user) throw new Error("пользователь не найден");
      await db().update(schema.subscriptions).set({ status: "expired", updatedAt: new Date() }).where(eq(schema.subscriptions.userId, user.id));
      await bumpPolicyVersion("admin.revoke");
      await bumpAclVersion("admin.revoke");
      console.log("ok");
      return 0;
    }
    case "node": {
      const [sub, name, kind, ip] = rest;
      if (sub === "list") {
        for (const n of await db().select().from(schema.nodes)) console.log(`${n.name}\t${n.kind}\t${n.ip ?? "-"}\t${n.enabled ? "on" : "off"}\tlast_seen=${n.lastSeenAt?.toISOString() ?? "-"}`);
        return 0;
      }
      if (sub !== "add" || !name || !kind) throw new Error("node add <name> <pro_dns|pro_worker|dedicated> [ip]");
      if (!["pro_dns", "pro_worker", "dedicated"].includes(kind)) throw new Error("kind: pro_dns | pro_worker | dedicated");
      const { secret } = await createNode(name, kind as "pro_dns" | "pro_worker" | "dedicated", ip ?? null);
      console.log(`Нода ${name} создана. Секрет (показывается один раз):\n${secret}\n\nЗапишите его в /etc/pereval/node.env как NODE_SECRET.`);
      return 0;
    }
    case "resend-link": {
      const [email] = rest;
      if (!email) throw new Error("resend-link <email>");
      await ensureUserByEmail(email);
      const url = await createLoginLink(email, 24 * 3600);
      const tpl = magicLinkMail(url);
      await enqueueMail({ to: email.toLowerCase(), subject: tpl.subject, text: tpl.text, html: tpl.html });
      console.log(`ссылка поставлена в очередь; для ручной выдачи: ${url}`);
      return 0;
    }
    case "webhook": {
      const [sub, id] = rest;
      if (sub !== "replay" || !id) throw new Error("webhook replay <id>");
      const [ev] = await db().select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, id)).limit(1);
      if (!ev) throw new Error("событие не найдено");
      const parsed = parseWebhook(ev.payload);
      if (!parsed) throw new Error("не удалось разобрать payload");
      const billing = await import("@/lib/billing");
      if (parsed.kind === "envelope") await billing.handleRefundOrChargeback(parsed.data);
      else if (parsed.type === "payment.success") await (parsed.data.parentContractId ? billing.handleRenewalSuccess(parsed.data) : billing.handleFirstPayment(parsed.data));
      else if (parsed.type === "subscription.recurring.payment.success") await billing.handleRenewalSuccess(parsed.data);
      else if (parsed.type === "subscription.recurring.payment.failed") await billing.handleRenewalFailed(parsed.data);
      else if (parsed.type === "subscription.cancelled") await billing.handleCancelled(parsed.data);
      else if (parsed.type === "payment.failed") await billing.handlePaymentFailed(parsed.data);
      await db().update(schema.webhookEvents).set({ processedAt: new Date(), error: null }).where(eq(schema.webhookEvents.id, id));
      console.log("ok");
      return 0;
    }
    case "policy":
      console.log(JSON.stringify(await buildPolicySnapshot(), null, 2));
      return 0;
    case "acl":
      console.log(JSON.stringify(await buildAclSnapshot(), null, 2));
      return 0;
    default:
      console.log("команды: users | subs | grant <email> <days> | revoke <email> | node add <name> <kind> [ip] | node list | resend-link <email> | webhook replay <id> | policy | acl");
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
