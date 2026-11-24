import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "@/lib/admin-auth";
import { AdminNav } from "@/components/admin/AdminNav";

export const metadata: Metadata = {
  title: { default: "Админ-панель", template: "%s — Админ-панель" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Каркас /admin. Каждая страница дополнительно вызывает requireAdminPage() сама: layout — не граница безопасности. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage();
  return (
    <div className="wrap py-5 sm:py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <div>
          <p className="eyebrow m-0 mb-1">Админ-панель</p>
          <h1 className="m-0 text-[clamp(22px,4vw,28px)] font-semibold tracking-tight">Перевал</h1>
        </div>
        <p className="m-0 min-w-0 break-all text-xs text-mute sm:break-normal sm:text-sm">
          {admin.email} · <Link href="/account">кабинет</Link>
        </p>
      </div>
      <div className="mt-4 border-b border-line pb-2">
        <AdminNav />
      </div>
      <div className="mt-5 grid min-w-0 grid-cols-1 gap-5 sm:mt-6 sm:gap-6">{children}</div>
    </div>
  );
}
