import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { env } from "@/lib/env";
import { SITE } from "@/content/site";

export const metadata: Metadata = {
  title: "Вход в кабинет",
  description: "Вход в личный кабинет Перевал Pro по ссылке на email или через Google.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  Verification: "Ссылка устарела или уже была использована. Запросите новую.",
  AccessDenied: "Доступ запрещён.",
  OAuthAccountNotLinked: "Этот email уже используется с другим способом входа. Войдите по ссылке на email.",
  Configuration: "Вход временно недоступен. Напишите в поддержку.",
  default: "Не удалось войти. Попробуйте ещё раз.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth();
  if (session?.user) redirect("/account");
  const sp = await searchParams;
  const sent = sp.sent === "1";
  const error = typeof sp.error === "string" ? (ERRORS[sp.error] ?? ERRORS.default) : null;
  const googleEnabled = !!(env().AUTH_GOOGLE_ID && env().AUTH_GOOGLE_SECRET);

  return (
    <div className="wrap max-w-[520px] py-12">
      <p className="eyebrow m-0 mb-2">Личный кабинет</p>
      <h1 className="m-0 text-[clamp(24px,5vw,32px)] font-semibold tracking-tight">Вход в {SITE.name} Pro</h1>
      <p className="mt-3 text-mute">
        Кабинет доступен после оплаты подписки. Ещё нет подписки? <Link href="/pro#buy">Оформить {SITE.name} Pro</Link>.
      </p>

      {sent ? (
        <div className="mt-6 rounded-xl border border-ok bg-ok-bg px-4 py-3 text-ok" role="status">
          Если аккаунт с этим email существует, мы отправили ссылку для входа. Проверьте почту (и папку «Спам»). Ссылка действует 15 минут.
        </div>
      ) : null}
      {error ? (
        <div className="mt-6 rounded-xl border border-err bg-err-bg px-4 py-3 text-err" role="alert">
          {error}
        </div>
      ) : null}

      <div className="card mt-6 grid gap-5">
        {googleEnabled ? (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/account" });
            }}
          >
            <button type="submit" className="btn-secondary w-full">
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17z" />
                <path fill="#FBBC05" d="M10.4 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6z" />
                <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.7-4.1-13.6-9.9l-7.8 6C6.5 42.6 14.6 48 24 48z" />
              </svg>
              Войти через Google
            </button>
            <p className="m-0 mt-2 text-center text-xs text-mute">Подойдёт, если подписка оформлена на тот же email, что и аккаунт Google.</p>
          </form>
        ) : null}

        {googleEnabled ? <div className="flex items-center gap-3 text-xs text-mute"><span className="h-px flex-1 bg-line" />или<span className="h-px flex-1 bg-line" /></div> : null}

        <form
          action={async (formData) => {
            "use server";
            const email = String(formData.get("email") ?? "").trim().toLowerCase();
            await signIn("nodemailer", { email, redirectTo: "/account" });
          }}
          className="grid gap-3"
        >
          <label className="grid gap-1.5">
            <span className="text-sm font-semibold">Email, на который оформлена подписка</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full rounded-lg border border-line bg-bg px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent"
            />
          </label>
          <button type="submit" className="btn-primary">
            Получить ссылку для входа
          </button>
          <p className="m-0 text-xs text-mute">Мы пришлём одноразовую ссылку. Пароль не нужен.</p>
        </form>
      </div>
    </div>
  );
}
