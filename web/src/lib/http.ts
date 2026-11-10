import { z } from "zod";
import { env } from "@/lib/env";

// Без импорта next/server: этот модуль попадает в бандлы jobs/admin (esbuild, ESM, внешние пакеты),
// а bare-импорт "next/server" в Node ESM не резолвится. Web-стандартного Response достаточно.

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function fail(status: number, message: string, code = "error"): Response {
  return json({ ok: false, error: code, message }, { status });
}

/** Единообразная обработка ошибок в Route Handlers. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message, err.code);
    if (err instanceof z.ZodError) {
      return fail(400, "Проверьте правильность заполнения полей формы.", "validation");
    }
    console.error("[api] unhandled error:", err);
    return fail(500, "Внутренняя ошибка сервера. Попробуйте позже.", "internal");
  }
}

/** JSON-тело с валидацией zod; лимит размера — на nginx. */
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Ожидается JSON.", "bad_json");
  }
  return schema.parse(body);
}

/**
 * CSRF для наших мутаций: Origin (или Referer) должен совпадать с PUBLIC_ORIGIN.
 * Маршруты Auth.js защищены собственным CSRF-токеном и сюда не попадают.
 */
export function assertSameOrigin(req: Request): void {
  const allowed = new Set([env().PUBLIC_ORIGIN]);
  if (env().NODE_ENV !== "production") allowed.add("http://localhost:3000");
  const origin = req.headers.get("origin");
  if (origin) {
    if (!allowed.has(origin)) throw new HttpError(403, "Запрос с чужого сайта отклонён.", "csrf");
    return;
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      if (!allowed.has(new URL(referer).origin)) throw new HttpError(403, "Запрос с чужого сайта отклонён.", "csrf");
      return;
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "Запрос с чужого сайта отклонён.", "csrf");
  }
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Некорректный email");
