import { env } from "@/lib/env";

/**
 * Определение администраторов по ADMIN_EMAILS и ADMIN_EMAIL.
 * Вынесено без зависимостей от БД и next-auth, чтобы переиспользоваться и в admin.ts, и в policy.ts.
 */

export function parseAdminEmails(adminEmails: string, adminEmail: string): Set<string> {
  return new Set(
    `${adminEmails},${adminEmail}`
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );
}

export function adminEmails(): Set<string> {
  const e = env();
  return parseAdminEmails(e.ADMIN_EMAILS, e.ADMIN_EMAIL);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && adminEmails().has(email.toLowerCase());
}
