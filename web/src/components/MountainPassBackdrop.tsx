"use client";

import { useEffect, useId, useRef } from "react";
import { MouseTrailCanvas } from "@/components/MouseTrailCanvas";

/**
 * Динамический векторный фон горного перевала для светлой темы:
 * координатная сетка и три слоя топографических хребтов плавно отклоняются
 * и наклоняются в сторону курсора, поверх идёт пиксельный шлейф в духе junie.jetbrains.com.
 */
export function MountainPassBackdrop({
  variant = "hero",
  trail,
}: {
  variant?: "hero" | "subtle";
  trail?: boolean;
}) {
  const isHero = variant === "hero";
  const showTrail = trail ?? true;
  const uid = useId().replace(/:/g, "");

  const rootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const farRidgeRef = useRef<SVGGElement | null>(null);
  const contourRef = useRef<SVGGElement | null>(null);
  const frontRidgeRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!root || !host) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(pointer: fine)");
    if (reduceMotion.matches || !finePointer.matches) return;

    let targetX = 0;
    let targetY = 0;
    let curX = 0;
    let curY = 0;
    let rafId = 0;

    const strength = isHero ? 1 : 0.65;

    const applyTransforms = () => {
      curX += (targetX - curX) * 0.085;
      curY += (targetY - curY) * 0.085;

      if (gridRef.current) {
        const gx = curX * 18 * strength;
        const gy = curY * 12 * strength;
        const rotY = curX * 2.8 * strength;
        const rotX = -curY * 2.2 * strength;
        gridRef.current.style.transform = `perspective(950px) translate3d(${gx.toFixed(2)}px, ${gy.toFixed(2)}px, 0) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale(1.04)`;
      }

      if (farRidgeRef.current) {
        farRidgeRef.current.style.transform = `translate3d(${(curX * 11 * strength).toFixed(2)}px, ${(curY * 6 * strength).toFixed(2)}px, 0)`;
      }
      if (contourRef.current) {
        contourRef.current.style.transform = `translate3d(${(curX * 20 * strength).toFixed(2)}px, ${(curY * 10 * strength).toFixed(2)}px, 0)`;
      }
      if (frontRidgeRef.current) {
        frontRidgeRef.current.style.transform = `translate3d(${(curX * 32 * strength).toFixed(2)}px, ${(curY * 15 * strength).toFixed(2)}px, 0)`;
      }

      const settled =
        Math.abs(targetX - curX) < 0.002 &&
        Math.abs(targetY - curY) < 0.002;

      if (!settled) {
        rafId = window.requestAnimationFrame(applyTransforms);
      } else {
        rafId = 0;
      }
    };

    const startLoop = () => {
      if (!rafId) rafId = window.requestAnimationFrame(applyTransforms);
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      targetX = Math.max(-1, Math.min(1, nx));
      targetY = Math.max(-1, Math.min(1, ny));
      startLoop();
    };

    const onPointerLeave = () => {
      targetX = 0;
      targetY = 0;
      startLoop();
    };

    host.addEventListener("pointermove", onPointerMove, { passive: true });
    host.addEventListener("pointerleave", onPointerLeave, { passive: true });

    return () => {
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerLeave);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [isHero]);

  return (
    <>
      <div ref={rootRef} className="pointer-events-none absolute inset-0 overflow-hidden select-none" aria-hidden="true">
        {/* Динамическая координатная сетка, отклоняющаяся к курсору */}
        <div
          ref={gridRef}
          className="absolute -inset-6 will-change-transform"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgb(11 92 255 / 0.085) 1px, transparent 1px), linear-gradient(to bottom, rgb(11 92 255 / 0.085) 1px, transparent 1px)",
            backgroundSize: "52px 52px",
            maskImage: "radial-gradient(ellipse 82% 76% at 50% 10%, black 32%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(ellipse 82% 76% at 50% 10%, black 32%, transparent 100%)",
          }}
        />

        {/* Силуэт горного перевала и контурные линии рельефа с параллаксом */}
        <svg
          viewBox="0 0 1440 420"
          preserveAspectRatio="xMidYMax slice"
          className={`absolute inset-x-0 bottom-0 w-full overflow-visible ${isHero ? "h-[300px] sm:h-[380px] opacity-95" : "h-[200px] sm:h-[240px] opacity-70"}`}
        >
          <defs>
            <linearGradient id={`pass-fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0b5cff" stopOpacity={isHero ? "0.11" : "0.07"} />
              <stop offset="100%" stopColor="#f3f7fe" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`pass-ridge-${uid}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#0f1524" stopOpacity="0" />
              <stop offset="26%" stopColor="#0f1524" stopOpacity="0.14" />
              <stop offset="50%" stopColor="#0b5cff" stopOpacity={isHero ? "0.62" : "0.38"} />
              <stop offset="74%" stopColor="#0f1524" stopOpacity="0.14" />
              <stop offset="100%" stopColor="#0f1524" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Слой 1: дальний хребет */}
          <g ref={farRidgeRef} className="will-change-transform">
            <path
              d="M-60 330 L170 250 L320 285 L520 190 L660 258 L720 272 L785 255 L950 175 L1145 255 L1310 215 L1500 270 L1500 440 L-60 440 Z"
              fill={`url(#pass-fill-${uid})`}
            />
            <path
              d="M-60 330 L170 250 L320 285 L520 190 L660 258 L720 272 L785 255 L950 175 L1145 255 L1310 215 L1500 270"
              fill="none"
              stroke="rgb(15 21 36 / 0.1)"
              strokeWidth="1"
            />
          </g>

          {/* Слой 2: топографические контуры склонов */}
          <g ref={contourRef} className="will-change-transform">
            <path
              d="M-60 365 L210 295 L410 322 L595 245 L720 296 L855 240 L1060 305 L1255 268 L1500 320"
              fill="none"
              stroke="rgb(11 92 255 / 0.15)"
              strokeWidth="1"
              strokeDasharray="4 6"
            />
          </g>

          {/* Слой 3: передний хребет с выраженной седловиной перевала по центру */}
          <g ref={frontRidgeRef} className="will-change-transform">
            <path
              d="M-60 392 L195 318 L385 352 L565 252 L682 314 Q720 332 758 314 L885 244 L1085 338 L1265 292 L1500 362"
              fill="none"
              stroke={`url(#pass-ridge-${uid})`}
              strokeWidth="1.6"
            />
            {isHero ? (
              <g>
                <circle cx="720" cy="323" r="15" fill="rgb(11 92 255 / 0.12)" />
                <circle cx="720" cy="323" r="3.5" fill="#0b5cff" />
              </g>
            ) : null}
          </g>
        </svg>
      </div>

      {/* Пиксельный шлейф за курсором — рендерится напрямую в секции, чтобы получать pointermove */}
      {showTrail ? <MouseTrailCanvas cellSize={16} maxAlpha={isHero ? 0.18 : 0.14} decay={0.03} /> : null}
    </>
  );
}

/**
 * Компактная визуальная карточка для героя главной страницы:
 * показывает принцип «перевала» — нужные домены идут через перевал с сохранением TLS,
 * российские сайты остаются на прямом маршруте.
 */
export function PassRouteCard({ dnsHost, dnsIp, serviceCount }: { dnsHost: string; dnsIp: string; serviceCount: number }) {
  return (
    <div className="relative overflow-hidden rounded-[16px] border border-line-strong/80 bg-panel/95 p-5 shadow-[0_24px_56px_-28px_rgba(15,21,36,0.18)] backdrop-blur-sm">
      {/* Верхняя строка-индикатор как в сетевом инспекторе */}
      <div className="flex items-center justify-between gap-2 border-b border-line pb-3.5">
        <div className="flex items-center gap-2 font-mono text-[11.5px] text-mute">
          <span className="inline-flex h-2 w-2 rounded-full bg-accent shadow-[0_0_8px_rgba(11,92,255,0.65)]" aria-hidden />
          <span className="font-medium text-ink">{dnsHost}</span>
        </div>
        <span className="rounded-md border border-line bg-code px-2 py-0.5 font-mono text-[11px] text-mute">
          TLS 1.3 · E2E
        </span>
      </div>

      {/* Минималистичная схема горного перевала и двух маршрутов */}
      <div className="relative my-4 overflow-hidden rounded-xl border border-line bg-bg/90 px-4 py-3.5">
        <svg viewBox="0 0 360 112" className="h-[104px] w-full" role="img" aria-label="Схема маршрутизации через горный перевал">
          <defs>
            <linearGradient id="route-pass-glow" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#4585ff" stopOpacity="0.45" />
              <stop offset="50%" stopColor="#0b5cff" stopOpacity="1" />
              <stop offset="100%" stopColor="#2b6eff" stopOpacity="0.72" />
            </linearGradient>
            <linearGradient id="mini-mountain" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0b5cff" stopOpacity="0.14" />
              <stop offset="100%" stopColor="#f7f9fc" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Силуэт двух вершин и седловины перевала */}
          <path
            d="M0 108 L54 74 L92 84 L138 28 L170 60 Q180 68 190 60 L226 24 L274 78 L314 66 L360 108 Z"
            fill="url(#mini-mountain)"
          />
          <path
            d="M0 108 L54 74 L92 84 L138 28 L170 60 Q180 68 190 60 L226 24 L274 78 L314 66 L360 108"
            fill="none"
            stroke="rgb(15 21 36 / 0.16)"
            strokeWidth="1.2"
          />

          {/* Основной маршрут через перевал (ИИ и dev-сервисы) */}
          <path
            d="M22 66 C 85 66, 132 52, 180 54 C 228 56, 275 40, 338 38"
            fill="none"
            stroke="url(#route-pass-glow)"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          {/* Узлы на маршруте через перевал */}
          <circle cx="22" cy="66" r="3.5" fill="#0f1524" />
          <circle cx="180" cy="54" r="9.5" fill="rgb(11 92 255 / 0.16)" />
          <circle cx="180" cy="54" r="3.5" fill="#0b5cff" />
          <circle cx="338" cy="38" r="3.5" fill="#0b5cff" />

          {/* Прямой маршрут (российские сайты) */}
          <path
            d="M22 86 L338 86"
            fill="none"
            stroke="rgb(86 97 118 / 0.35)"
            strokeWidth="1.3"
            strokeDasharray="4 4"
          />
          <circle cx="22" cy="86" r="2.5" fill="#566176" />
          <circle cx="338" cy="86" r="2.5" fill="#566176" />

          {/* Подписи */}
          <text x="180" y="16" textAnchor="middle" fill="#0b5cff" fontSize="9.5" fontWeight="600" fontFamily="var(--font-mono)" letterSpacing="0.08em">
            ПЕРЕВАЛ · SNI
          </text>
          <text x="334" y="28" textAnchor="end" fill="#0f1524" fontSize="9.5" fontWeight="500" fontFamily="var(--font-mono)">
            claude.ai
          </text>
          <text x="334" y="100" textAnchor="end" fill="#566176" fontSize="9.5" fontFamily="var(--font-mono)">
            direct · банки / РФ
          </text>
        </svg>
      </div>

      {/* Таблица примеров резолвинга */}
      <div className="grid gap-1.5 font-mono text-[12px]">
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg/70 px-3 py-2">
          <span className="truncate text-ink">chatgpt.com · claude.ai</span>
          <span className="shrink-0 font-medium text-accent">→ {dnsIp}</span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg/70 px-3 py-2">
          <span className="truncate text-ink">cursor.com · jetbrains.com</span>
          <span className="shrink-0 font-medium text-accent">→ {dnsIp}</span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line/70 bg-panel-elevated/60 px-3 py-2 text-mute">
          <span className="truncate">gosuslugi.ru · sberbank.ru</span>
          <span className="shrink-0">→ напрямую</span>
        </div>
      </div>

      {/* Нижняя строка характеристик */}
      <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-line pt-3 font-mono text-[11px] text-mute">
        <span>{serviceCount} сервисов в Free</span>
        <span>без VPN-клиента</span>
      </div>
    </div>
  );
}
