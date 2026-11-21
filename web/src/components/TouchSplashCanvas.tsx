"use client";

import { useEffect, useRef } from "react";

type Cell = {
  alpha: number;
  hot: number;
};

type SplashParticle = {
  c: number;
  r: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  strength: number;
};

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [contenteditable="true"]';

const MAX_PARTICLES = 84;

type Props = {
  /** Размер ячейки пиксельной сетки в CSS-пикселях. */
  cellSize?: number;
  /** Максимальная непрозрачность активной ячейки (0..1). */
  maxAlpha?: number;
  /** Скорость затухания ячейки за кадр (~60fps). */
  decay?: number;
};

/**
 * Пиксельные брызги при касании экрана на мобильных/тач-устройствах.
 * Срабатывает на pointerdown (pointerType === "touch") — как при обычном касании,
 * так и в начале скролла, но игнорирует нажатия на ссылки, кнопки и элементы форм.
 * Визуально повторяет десктопный MouseTrailCanvas (пиксельная сетка, палитра логотипа).
 */
export function TouchSplashCanvas({ cellSize = 14, maxAlpha = 0.26, decay = 0.036 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduceMotion.matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cols = 0;
    let rows = 0;
    let rafId = 0;
    let needsResize = true;

    const cells = new Map<number, Cell>();
    const particles: SplashParticle[] = [];

    const resize = () => {
      const nextCols = Math.max(1, Math.ceil(window.innerWidth / cellSize));
      const nextRows = Math.max(1, Math.ceil(window.innerHeight / cellSize));
      needsResize = false;
      if (nextCols === cols && nextRows === rows) return;
      cols = nextCols;
      rows = nextRows;
      cells.clear();
      canvas.width = cols;
      canvas.height = rows;
      ctx.clearRect(0, 0, cols, rows);
    };

    const touchCell = (c: number, r: number, strength: number, hot = 0) => {
      if (c < 0 || r < 0 || c >= cols || r >= rows) return;
      const key = r * cols + c;
      const prev = cells.get(key);
      if (prev) {
        prev.alpha = Math.min(1, Math.max(prev.alpha, strength));
        prev.hot = Math.min(1, Math.max(prev.hot, hot));
      } else {
        cells.set(key, { alpha: strength, hot });
      }
    };

    const spawnSplash = (clientX: number, clientY: number) => {
      if (cols === 0 || rows === 0 || (needsResize && !rafId)) {
        resize();
      }
      const col = Math.floor(clientX / cellSize);
      const row = Math.floor(clientY / cellSize);

      // Центральная вспышка на сетке (как штамп в десктопном шлейфе)
      touchCell(col, row, 0.95, 1);
      const coreNeighbors: ReadonlyArray<readonly [number, number, number]> = [
        [1, 0, 0.6],
        [-1, 0, 0.6],
        [0, 1, 0.6],
        [0, -1, 0.6],
        [1, 1, 0.3],
        [-1, -1, 0.3],
        [1, -1, 0.3],
        [-1, 1, 0.3],
      ];
      for (const [dc, dr, weight] of coreNeighbors) {
        if (Math.random() < 0.68) {
          touchCell(col + dc, row + dr, weight * (0.65 + Math.random() * 0.35), weight * 0.55);
        }
      }

      // Пиксельные брызги, разлетающиеся от точки касания
      const count = 10 + Math.floor(Math.random() * 5);
      const baseOffset = Math.random() * Math.PI * 2;
      for (let i = 0; i < count; i++) {
        if (particles.length >= MAX_PARTICLES) {
          particles.shift();
        }
        const angle = baseOffset + (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.42;
        const speed = 0.24 + Math.random() * 0.34;
        const maxLife = 12 + Math.floor(Math.random() * 11);
        particles.push({
          c: col + Math.cos(angle) * 0.4,
          r: row + Math.sin(angle) * 0.4,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: maxLife,
          maxLife,
          strength: 0.58 + Math.random() * 0.42,
        });
      }
    };

    const render = () => {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (!p) continue;
        p.c += p.vx;
        p.r += p.vy;
        p.vx *= 0.91;
        p.vy *= 0.91;
        p.life -= 1;

        const progress = p.life / p.maxLife;
        touchCell(Math.round(p.c), Math.round(p.r), p.strength * (0.35 + progress * 0.65), progress * 0.85);

        if (p.life <= 0) {
          particles.splice(i, 1);
        }
      }

      ctx.clearRect(0, 0, cols, rows);

      for (const [key, cell] of cells) {
        cell.alpha -= decay;
        cell.hot = Math.max(0, cell.hot - decay * 1.85);
        if (cell.alpha <= 0.01) {
          cells.delete(key);
          continue;
        }
        const c = key % cols;
        const r = Math.floor(key / cols);
        const a = cell.alpha * maxAlpha;
        // Фирменный синий логотипа (#0b5cff) со светлым голубым (#6ea3ff)
        const red = Math.round(11 + cell.hot * 88);
        const green = Math.round(92 + cell.hot * 72);
        const blue = 255;
        ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, ${a.toFixed(3)})`;
        ctx.fillRect(c, r, 1, 1);
      }

      if (cells.size > 0 || particles.length > 0) {
        rafId = window.requestAnimationFrame(render);
      } else {
        rafId = 0;
        if (needsResize) resize();
      }
    };

    const startLoop = () => {
      if (!rafId) {
        rafId = window.requestAnimationFrame(render);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (reduceMotion.matches) return;
      const target = e.target;
      if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;

      spawnSplash(e.clientX, e.clientY);
      startLoop();
    };

    const onResize = () => {
      // Откладываем пересоздание буфера, если идёт анимация (на мобильных resize срабатывает при скрытии адресной строки в начале скролла)
      if (rafId) {
        needsResize = true;
      } else {
        resize();
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden && rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
        particles.length = 0;
        cells.clear();
        if (cols > 0 && rows > 0) ctx.clearRect(0, 0, cols, rows);
      }
    };

    window.addEventListener("pointerdown", onPointerDown, { passive: true, capture: true });
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [cellSize, maxAlpha, decay]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 h-full w-full [image-rendering:pixelated]"
    />
  );
}
