"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Globe, Laptop, Monitor, Router, Smartphone, TabletSmartphone, Terminal } from "lucide-react";

export type WizardTabId = "ios" | "android" | "mac" | "win" | "linux" | "router" | "browser";
export type WizardTab = { id: WizardTabId; label: string; content: ReactNode };

const ICONS: Record<WizardTabId, typeof Smartphone> = {
  ios: TabletSmartphone,
  android: Smartphone,
  mac: Laptop,
  win: Monitor,
  linux: Terminal,
  router: Router,
  browser: Globe,
};

/** Определение платформы по User-Agent; по умолчанию (SSR) — iPhone. */
export function detectTab(ua: string): WizardTabId {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "win";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return "ios";
}

/**
 * Мастер настройки: вкладки по устройствам. Панели приходят с сервера готовым JSX (контент попадает
 * в статический HTML и индексируется), клиент лишь переключает `hidden` и подбирает вкладку по UA.
 */
export function SetupWizard({ tabs }: { tabs: WizardTab[] }) {
  const [active, setActive] = useState<WizardTabId>("ios");
  const userPicked = useRef(false);
  const baseId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (userPicked.current) return;
    const detected = detectTab(navigator.userAgent || "");
    // iPadOS в Safari представляется как Mac: уточняем по сенсорному экрану
    const isIpadOnMac = detected === "mac" && navigator.maxTouchPoints > 1;
    setActive(isIpadOnMac ? "ios" : detected);
  }, []);

  function select(id: WizardTabId) {
    userPicked.current = true;
    setActive(id);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -index : e.key === "End" ? tabs.length - 1 - index : 0;
    if (!delta) return;
    e.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (!next) return;
    select(next.id);
    tabRefs.current[next.id]?.focus();
  }

  return (
    <div className="card !p-0 overflow-hidden">
      <div role="tablist" aria-label="Устройство или программа" className="flex gap-1 overflow-x-auto border-b border-line bg-bg p-2 [scrollbar-width:thin]">
        {tabs.map((t, i) => {
          const Icon = ICONS[t.id];
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => select(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                on ? "bg-panel text-accent shadow-[var(--shadow-card)] ring-1 ring-line" : "text-mute hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${baseId}-panel-${t.id}`}
          aria-labelledby={`${baseId}-tab-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
          className="p-5 sm:p-6 focus-visible:outline-none"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
