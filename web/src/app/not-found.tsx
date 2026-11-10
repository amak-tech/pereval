import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "@/content/site";

export const metadata: Metadata = {
  title: "Страница не найдена",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="wrap py-20 text-center">
      <p className="eyebrow m-0 mb-2">Ошибка 404</p>
      <h1 className="m-0 text-[clamp(26px,5vw,36px)] font-semibold tracking-tight">Такой страницы нет</h1>
      <p className="mx-auto mt-3 max-w-[52ch] text-mute">
        Возможно, адрес изменился: старые страницы <code>.html</code> переехали на новые адреса. Выберите нужный раздел ниже.
      </p>
      <nav aria-label="Основные разделы" className="mt-8 flex flex-wrap justify-center gap-2">
        <Link href="/" className="btn-primary">
          На главную
        </Link>
        <Link href="/pro" className="btn-secondary">
          {SITE.name} Pro
        </Link>
        <Link href="/dedicated" className="btn-secondary">
          Dedicated
        </Link>
        <Link href="/stats" className="btn-secondary">
          Статистика
        </Link>
        <Link href="/account" className="btn-secondary">
          Личный кабинет
        </Link>
      </nav>
    </div>
  );
}
