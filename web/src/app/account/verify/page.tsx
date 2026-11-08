import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Подтверждение входа",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Промежуточная страница magic-link: почтовые сканеры открывают ссылки из писем
 * и «сжигают» одноразовые токены, поэтому реальный callback Auth.js срабатывает
 * только по клику на кнопку.
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = typeof sp.u === "string" ? sp.u : "";
  const origin = env().PUBLIC_ORIGIN;
  let target: string | null = null;
  try {
    const u = new URL(raw);
    if (u.origin === origin && u.pathname.startsWith("/api/auth/callback/")) target = u.toString();
  } catch {
    target = null;
  }
  return (
    <div className="wrap max-w-[520px] py-12">
      <p className="eyebrow m-0 mb-2">Личный кабинет</p>
      <h1 className="m-0 text-[clamp(24px,5vw,32px)] font-semibold tracking-tight">Подтвердите вход</h1>
      {target ? (
        <div className="card mt-6 grid gap-4">
          <p className="m-0 text-mute">Нажмите кнопку, чтобы завершить вход. Ссылка одноразовая и действует ограниченное время.</p>
          <a href={target} className="btn-primary" rel="nofollow">
            Войти в кабинет
          </a>
          <p className="m-0 text-xs text-mute">Если вы не запрашивали вход, просто закройте страницу — без нажатия ничего не произойдёт.</p>
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-err bg-err-bg px-4 py-3 text-err" role="alert">
          Ссылка повреждена. <Link href="/account/login">Запросить новую</Link>.
        </div>
      )}
    </div>
  );
}
