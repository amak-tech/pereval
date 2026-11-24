"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const ADMIN_NAV = [
  { href: "/admin", label: "Обзор" },
  { href: "/admin/users", label: "Пользователи" },
  { href: "/admin/billing", label: "Биллинг" },
  { href: "/admin/infra", label: "Инфраструктура" },
  { href: "/admin/mail", label: "Почта" },
  { href: "/admin/leads", label: "Заявки" },
  { href: "/admin/audit", label: "Журнал" },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  const active = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));
  return (
    <nav className="-mx-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0" aria-label="Разделы админ-панели">
      <ul className="m-0 flex w-max min-w-full list-none gap-1 px-4 py-0.5 sm:w-auto sm:flex-wrap sm:px-0">
        {ADMIN_NAV.map((n) => (
          <li key={n.href} className="shrink-0">
            <Link
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={`block rounded-full px-3 py-1.5 text-sm whitespace-nowrap no-underline transition-colors ${active(n.href) ? "bg-accent-soft font-semibold text-accent" : "text-mute hover:text-ink"}`}
            >
              {n.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
