import { z } from "zod";
import * as admin from "@/lib/admin";
import { fmtDate } from "@/lib/mail-templates";

/**
 * Мутации админ-панели: одна точка входа POST /api/admin/action с discriminated union,
 * чтобы проверка Origin, прав и запись в audit_log были в одном месте.
 */

const id = z.string().min(1).max(64);

export const adminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("user.grant"), userId: id, days: z.coerce.number().int().min(1).max(3660) }),
  z.object({ action: z.literal("user.revoke"), userId: id }),
  z.object({ action: z.literal("user.login_link"), userId: id }),
  z.object({ action: z.literal("user.rotate_token"), userId: id }),
  z.object({ action: z.literal("user.remove_ip"), userId: id, ipId: id }),
  z.object({ action: z.literal("webhook.replay"), id }),
  z.object({ action: z.literal("billing.reconcile") }),
  z.object({ action: z.literal("billing.refresh_plans") }),
  z.object({ action: z.literal("node.add"), name: z.string().trim().min(1).max(40), kind: z.string().max(20), ip: z.string().trim().max(45).optional() }),
  z.object({ action: z.literal("node.enabled"), id, enabled: z.boolean() }),
  z.object({ action: z.literal("node.delete"), id }),
  z.object({ action: z.literal("nodes.push"), what: z.enum(["policy", "acl"]) }),
  z.object({ action: z.literal("settings.node_max_clients"), maxClients: z.coerce.number().int().min(1).max(100_000) }),
  z.object({ action: z.literal("mail.retry"), id }),
  z.object({ action: z.literal("mail.delete"), id }),
  z.object({ action: z.literal("mail.test") }),
]);

export type AdminAction = z.infer<typeof adminActionSchema>;

/** Ответ действия: сообщение и, при необходимости, значение «показывается один раз» (секрет, ссылка, токен). */
export type AdminActionResult = { message: string; reveal?: { label: string; value: string } };

export async function runAdminAction(who: admin.Admin, input: AdminAction): Promise<AdminActionResult> {
  switch (input.action) {
    case "user.grant": {
      const r = await admin.grantAccess(who, input.userId, input.days);
      return { message: `Доступ для ${r.email} активен до ${fmtDate(r.periodEnd)}.`, reveal: { label: "Персональный токен", value: r.token } };
    }
    case "user.revoke": {
      const r = await admin.revokeAccess(who, input.userId);
      return { message: `Доступ для ${r.email} отключён (подписки переведены в expired).` };
    }
    case "user.login_link": {
      const r = await admin.issueLoginLink(who, input.userId);
      return { message: `Письмо со ссылкой для ${r.email} поставлено в очередь. Ссылка действует 24 ч.`, reveal: { label: "Ссылка входа", value: r.url } };
    }
    case "user.rotate_token": {
      const r = await admin.adminRotateToken(who, input.userId);
      return { message: "Токен перевыпущен; старый работает ещё 48 ч.", reveal: { label: "Новый токен", value: r.token } };
    }
    case "user.remove_ip":
      await admin.adminRemoveBoundIp(who, input.userId, input.ipId);
      return { message: "Привязка IP удалена." };
    case "webhook.replay": {
      const r = await admin.replayWebhookEvent(who, input.id);
      return { message: `Событие ${r.type} обработано заново.` };
    }
    case "billing.reconcile": {
      const r = await admin.adminReconcile(who);
      return { message: `Сверка выполнена: истекло ${r.expired}, выровнено по lava.top ${r.aligned}, напоминаний ${r.reminded}.` };
    }
    case "billing.refresh_plans": {
      const r = await admin.adminRefreshPlans(who);
      const prices = Object.entries(r.pro).map(([c, a]) => `${a} ${c}`);
      return { message: prices.length ? `Цены обновлены: ${prices.join(", ")}.` : "lava.top не вернул цены; оставлен кеш." };
    }
    case "node.add": {
      const r = await admin.addNode(who, input.name, input.kind, input.ip ?? null);
      return {
        message: `Нода ${input.name} зарегистрирована. Секрет показывается один раз — запишите его в /etc/pereval/node.env как NODE_SECRET (или в GitHub Secrets для deploy.sh).`,
        reveal: { label: "NODE_SECRET", value: r.secret },
      };
    }
    case "node.enabled": {
      const r = await admin.setNodeEnabled(who, input.id, input.enabled);
      return { message: `Нода ${r.name} ${input.enabled ? "включена" : "отключена"}.` };
    }
    case "node.delete": {
      const r = await admin.deleteNode(who, input.id);
      return { message: `Нода ${r.name} удалена.` };
    }
    case "nodes.push": {
      const v = await admin.pushToNodes(who, input.what);
      return { message: `Версия ${input.what} поднята до ${v}; ноды получат снапшот в течение секунды.` };
    }
    case "settings.node_max_clients": {
      const r = await admin.setNodeMaxClients(who, input.maxClients);
      return { message: `Порог клиентов по умолчанию установлен: ${r.maxClients}.` };
    }
    case "mail.retry":
      await admin.retryMail(who, input.id);
      return { message: "Письмо вернётся в очередь и уйдёт в течение 15 с." };
    case "mail.delete":
      await admin.deleteMail(who, input.id);
      return { message: "Письмо удалено из очереди." };
    case "mail.test": {
      const r = await admin.sendTestMail(who);
      return { message: `Тестовое письмо на ${r.to} поставлено в очередь.` };
    }
  }
}
