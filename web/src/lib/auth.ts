import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { enqueueMail } from "@/lib/mail";
import { magicLinkMail } from "@/lib/mail-templates";
import { allow, cooldownLeft, touch } from "@/lib/ratelimit";

/**
 * Auth.js v5: Google OIDC + magic-link по email. Сессии в Postgres (database strategy).
 * Добавить Яндекс/Apple/GitHub — одна запись в providers[].
 */
function providers(): NextAuthConfig["providers"] {
  const e = env();
  const list: NextAuthConfig["providers"] = [];
  if (e.AUTH_GOOGLE_ID && e.AUTH_GOOGLE_SECRET) {
    list.push(
      Google({
        clientId: e.AUTH_GOOGLE_ID,
        clientSecret: e.AUTH_GOOGLE_SECRET,
        // Email подтверждён Google — безопасно привязать к пользователю, оплатившему по email.
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }
  list.push(
    Nodemailer({
      // Сервер здесь формальный: письма уходят через наш outbox, а не напрямую.
      server: { host: e.SMTP_HOST, port: e.SMTP_PORT, auth: { user: e.SMTP_USERNAME, pass: e.SMTP_PASSWORD } },
      from: e.MAIL_FROM,
      maxAge: 15 * 60,
      async sendVerificationRequest({ identifier, url }) {
        // Почтовые сканеры (Outlook SafeLinks, Gmail) открывают ссылки из писем и
        // «сжигают» одноразовые токены. Поэтому ведём на промежуточную страницу
        // с кнопкой, и только клик переходит на настоящий callback Auth.js.
        const wrapped = `${env().PUBLIC_ORIGIN}/account/verify?u=${encodeURIComponent(url)}`;
        const tpl = magicLinkMail(wrapped);
        await enqueueMail({ to: identifier, subject: tpl.subject, text: tpl.text, html: tpl.html });
      },
    }),
  );
  return list;
}

export const authConfig: NextAuthConfig = {
  adapter: DrizzleAdapter(db(), {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  secret: env().AUTH_SECRET,
  trustHost: true,
  session: { strategy: "database", maxAge: env().SESSION_DAYS * 86_400, updateAge: 86_400 },
  providers: providers(),
  pages: {
    signIn: "/account/login",
    verifyRequest: "/account/login?sent=1",
    error: "/account/login",
  },
  callbacks: {
    async signIn({ account, email, user }) {
      // Запрос magic-link: cooldown 60 с на адрес (анти-спам, анти-энумерация по времени ответа).
      if (account?.provider === "nodemailer" && email?.verificationRequest) {
        const key = `magic:${(user.email ?? "").toLowerCase()}`;
        if (cooldownLeft(key, 60_000) > 0) return "/account/login?sent=1";
        if (!allow(`magic-hour:${(user.email ?? "").toLowerCase()}`, 6, 3_600_000)) return "/account/login?sent=1";
        touch(key);
      }
      return true;
    },
    async session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (!user.id) return;
      const now = new Date();
      await db()
        .insert(schema.usersMeta)
        .values({ userId: user.id, lastLoginAt: now })
        .onConflictDoUpdate({ target: schema.usersMeta.userId, set: { lastLoginAt: now } });
    },
    async createUser({ user }) {
      if (!user.id) return;
      await db().insert(schema.usersMeta).values({ userId: user.id }).onConflictDoNothing();
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export { findUserByEmail, ensureUserByEmail, createLoginLink } from "@/lib/auth-core";

export async function requireUser(): Promise<{ id: string; email: string }> {
  const session = await auth();
  const id = session?.user?.id;
  const email = session?.user?.email;
  if (!id || !email) {
    const { HttpError } = await import("@/lib/http");
    throw new HttpError(401, "Нужно войти в кабинет.", "unauthorized");
  }
  return { id, email };
}
