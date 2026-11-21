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
    <header className="sticky top-0 z-40 border-b border-line/80 bg-bg/85 backdrop-blur-md supports-[backdrop-filter]:bg-bg/75">
      <div className="wrap flex h-16 items-center justify-between gap-4">
        <Link href="/" className="group flex items-center gap-2.5 no-underline text-ink" aria-label={`${SITE.name} — на главную`}>
          <Image src="/favicon.svg" alt="" width={28} height={28} className="rounded-lg ring-1 ring-ink/10 transition-transform duration-150 group-hover:scale-105" priority />
          <span className="text-[15.5px] font-semibold tracking-[-0.02em]">{SITE.name}</span>
          <span className="hidden rounded-md border border-line bg-panel px-2 py-0.5 font-mono text-[11px] text-mute sm:inline">Smart DNS</span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Основная навигация">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n.href) ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-[14px] no-underline transition-colors ${
                isActive(n.href) ? "bg-accent-soft text-accent font-medium" : "text-mute hover:bg-ink/[0.04] hover:text-ink"
              }`}
            >
              {n.label}
            </Link>
          ))}
          <Link href="/account" className="btn-secondary ml-2 !rounded-lg !px-3.5 !py-1.5 !text-[13.5px]">
            <UserRound className="h-4 w-4" aria-hidden /> Кабинет
          </Link>
        </nav>
        <button
          type="button"
          className="md:hidden rounded-lg border border-line bg-panel p-2 text-ink transition-colors hover:border-line-strong"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Закрыть меню" : "Открыть меню"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
        </button>
      </div>
      {open ? (
        <nav id="mobile-nav" className="wrap flex flex-col gap-1 border-t border-line bg-bg/95 py-4 md:hidden" aria-label="Мобильная навигация">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setOpen(false)}
              aria-current={isActive(n.href) ? "page" : undefined}
              className={`rounded-lg px-3 py-2.5 text-[15px] no-underline ${isActive(n.href) ? "bg-accent-soft text-accent font-medium" : "text-ink hover:bg-ink/[0.04]"}`}
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
