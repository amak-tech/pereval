"use client";

import { useEffect, useState } from "react";
import { ArrowDown } from "lucide-react";

/**
 * Мобильная липкая кнопка «Настроить за 1 минуту». Скрывается, пока на экране герой (там уже есть
 * основная кнопка) или сам мастер настройки — чтобы не перекрывать то, к чему ведёт.
 */
export function StickyCta({ targets = ["#hero-cta", "#setup"], label = "Настроить за 1 минуту" }: { targets?: string[]; label?: string }) {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const els = targets.map((s) => document.querySelector(s)).filter((el): el is Element => !!el);
    // Без IntersectionObserver (очень старые браузеры) кнопка не показывается — основная CTA есть в герое.
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target);
          else visible.delete(e.target);
        }
        setHidden(visible.size > 0);
      },
      { threshold: 0.05 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [targets]);

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur transition-transform md:hidden ${
        hidden ? "translate-y-full" : "translate-y-0"
      }`}
      aria-hidden={hidden}
    >
      <a href="#setup" className="btn-primary w-full" tabIndex={hidden ? -1 : 0}>
        {label} <ArrowDown className="h-4 w-4" aria-hidden />
      </a>
    </div>
  );
}
