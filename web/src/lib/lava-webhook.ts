import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto";
import * as lava from "@/lib/lava";

/** Чистые функции разбора и аутентификации вебхуков lava.top (без БД — удобно тестировать). */

export function verifyWebhookAuth(headers: Headers, sourceIp: string): { ok: boolean; reason?: string } {
  const e = env();
  if (!e.LAVA_WEBHOOK_KEY) return { ok: false, reason: "LAVA_WEBHOOK_KEY не задан" };
  const key = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!key || !safeEqual(key, e.LAVA_WEBHOOK_KEY)) return { ok: false, reason: "неверный X-Api-Key" };
  const allow = e.LAVA_WEBHOOK_IP_ALLOWLIST.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (e.LAVA_WEBHOOK_IP_MODE !== "off" && allow.length && !allow.includes(sourceIp)) {
    if (e.LAVA_WEBHOOK_IP_MODE === "enforce") return { ok: false, reason: `IP ${sourceIp} не в allowlist` };
    console.warn(`[lava-webhook] IP ${sourceIp} не в allowlist (режим log)`);
  }
  return { ok: true };
}

export type ParsedEvent =
  | { kind: "flat"; type: string; data: lava.WebhookFlat }
  | { kind: "envelope"; type: string; data: lava.WebhookEnvelope };

export function parseWebhook(body: unknown): ParsedEvent | null {
  const flat = lava.WebhookFlat.safeParse(body);
  if (flat.success) return { kind: "flat", type: flat.data.eventType, data: flat.data };
  const envl = lava.WebhookEnvelope.safeParse(body);
  if (envl.success) return { kind: "envelope", type: envl.data.event_type, data: envl.data };
  return null;
}

