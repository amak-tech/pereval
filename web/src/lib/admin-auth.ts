import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { HttpError } from "@/lib/http";
import { isAdminEmail, type Admin } from "@/lib/admin";

/**
 * Проверка прав администратора: залогиненный пользователь с email из ADMIN_EMAILS / ADMIN_EMAIL.
 * Отдельно от admin.ts, потому что тянет next-auth и next/navigation (нельзя в бандл CLI).
 */

/** Для Route Handlers: 401 без сессии, 403 — не админ. */
export async function requireAdmin(): Promise<Admin & { id: string }> {
  const session = await auth();
  const id = session?.user?.id;
  const email = session?.user?.email;
  if (!id || !email) throw new HttpError(401, "Нужно войти в кабинет.", "unauthorized");
  if (!isAdminEmail(email)) throw new HttpError(403, "Нет прав администратора.", "forbidden");
  return { id, email: email.toLowerCase() };
}

/** Для страниц /admin: без сессии — на вход, не админ — 404 (не раскрываем существование панели). */
export async function requireAdminPage(): Promise<Admin & { id: string }> {
  const session = await auth();
  const id = session?.user?.id;
  const email = session?.user?.email;
  if (!id || !email) redirect("/account/login");
  if (!isAdminEmail(email)) notFound();
  return { id, email: email.toLowerCase() };
}
