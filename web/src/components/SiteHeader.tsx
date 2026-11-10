"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X, UserRound } from "lucide-react";
import { NAV, SITE } from "@/content/site";

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-panel/90 backdrop-blur supports-[backdrop-filter]:bg-panel/75">
      <div className="wrap flex h-14 items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2 no-underline text-ink" aria-label={`${SITE.name} — на главную`}>
          <Image src="/favicon.svg" alt="" width={26} height={26} className="rounded-md" priority />
          <span className="text-[15px] font-semibold tracking-tight">{SITE.name}</span>
          <span className="hidden text-xs text-mute sm:inline">Smart DNS без VPN</span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Основная навигация">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n.href) ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 text-sm no-underline transition-colors ${
                isActive(n.href) ? "bg-accent-soft text-accent font-semibold" : "text-mute hover:text-ink"
              }`}
            >
              {n.label}
            </Link>
          ))}
          <Link href="/account" className="btn-secondary ml-2 !px-3 !py-1.5 !text-sm">
            <UserRound className="h-4 w-4" aria-hidden /> Кабинет
          </Link>
        </nav>
        <button
          type="button"
          className="md:hidden rounded-md border border-line p-2 text-ink"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Закрыть меню" : "Открыть меню"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
        </button>
      </div>
      {open ? (
        <nav id="mobile-nav" className="wrap flex flex-col gap-1 border-t border-line py-3 md:hidden" aria-label="Мобильная навигация">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setOpen(false)}
              aria-current={isActive(n.href) ? "page" : undefined}
              className={`rounded-md px-3 py-2 no-underline ${isActive(n.href) ? "bg-accent-soft text-accent font-semibold" : "text-ink"}`}
            >
              {n.label}
            </Link>
          ))}
          <Link href="/account" onClick={() => setOpen(false)} className="btn-primary mt-2">
            <UserRound className="h-4 w-4" aria-hidden /> Личный кабинет
          </Link>
        </nav>
      ) : null}
    </header>
  );
}
