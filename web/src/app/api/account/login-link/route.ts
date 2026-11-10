import { z } from "zod";
import { assertSameOrigin, emailSchema, handle, json, HttpError } from "@/lib/http";
import { env } from "@/lib/env";
import { clientIp } from "@/lib/ip";
import { allow, cooldownLeft, touch } from "@/lib/ratelimit";
import { createLoginLink } from "@/lib/auth-core";
import { enqueueMail } from "@/lib/mail";
import { magicLinkMail } from "@/lib/mail-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: emailSchema });
const SENT_PAGE = "/account/login/sent";
const TTL_SECONDS = 15 * 60;

/**
 * Ссылка для входа по email — обычная HTML-форма (POST form-urlencoded) или JSON.
 * Сознательно не через Auth.js signIn(): его редирект на /api/auth/verify-request ломается
 * при клиентской навигации, а server action зависит от свежести JS в открытой вкладке.
 * Токен совместим с callback Auth.js (createLoginLink). Ответ всегда одинаковый — без
 * раскрытия, существует ли аккаунт; cooldown 60 с на адрес и лимиты на адрес/IP.
 */
export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const ct = req.headers.get("content-type") ?? "";
    let raw: unknown;
    if (ct.includes("application/json")) raw = await req.json().catch(() => ({}));
    else raw = Object.fromEntries((await req.formData()).entries());
    const wantsJson = ct.includes("application/json") || (req.headers.get("accept") ?? "").includes("application/json");
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      if (wantsJson) throw new HttpError(400, "Укажите корректный email.", "validation");
      return Response.redirect(`${env().PUBLIC_ORIGIN}/account/login?error=Email`, 303);
    }
    const email = parsed.data.email.toLowerCase();
    const ip = clientIp(req.headers);
    const key = `magic:${email}`;
    const allowed = cooldownLeft(key, 60_000) === 0 && allow(`magic-hour:${email}`, 6, 3_600_000) && allow(`magic-ip:${ip}`, 10, 900_000);
    if (allowed) {
      touch(key);
      const url = await createLoginLink(email, TTL_SECONDS);
      const tpl = magicLinkMail(url);
      await enqueueMail({ to: email, subject: tpl.subject, text: tpl.text, html: tpl.html });
    }
    if (wantsJson) return json({ ok: true });
    return Response.redirect(`${env().PUBLIC_ORIGIN}${SENT_PAGE}`, 303);
  });
}
