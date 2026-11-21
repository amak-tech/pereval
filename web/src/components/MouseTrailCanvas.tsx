"use client";

import { useEffect, useRef } from "react";

type Cell = {
  alpha: number;
  hot: number;
};

type Props = {
  /** Размер ячейки пиксельной сетки в CSS-пикселях. */
  cellSize?: number;
  /** Максимальная непрозрачность активной ячейки (0..1). */
  maxAlpha?: number;
  /** Скорость затухания за кадр (~60fps). */
  decay?: number;
  /** Дополнительный CSS-класс для canvas. */
  className?: string;
};

/**
 * Пиксельный шлейф за курсором в духе junie.jetbrains.com.
 * Слушает pointermove на родительском контейнере (должен иметь position: relative; overflow: hidden),
 * останавливает rAF-цикл в простое и отключается при prefers-reduced-motion или на тач-устройствах.
 */
export function MouseTrailCanvas({ cellSize = 18, maxAlpha = 0.24, decay = 0.028, className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(pointer: fine)");
    if (reduceMotion.matches || !finePointer.matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cols = 0;
    let rows = 0;
    let width = 0;
    let height = 0;
    let rafId = 0;
    let lastCol = -1;
    let lastRow = -1;

    const cells = new Map<number, Cell>();

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      cols = Math.max(1, Math.ceil(width / cellSize));
      rows = Math.max(1, Math.ceil(height / cellSize));
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

    const paintStamp = (c: number, r: number) => {
      touchCell(c, r, 1, 1);
      // Лёгкий цифровой разброс на соседние ячейки для живого пиксельного шлейфа
      const neighbors: ReadonlyArray<readonly [number, number, number]> = [
        [1, 0, 0.55],
        [-1, 0, 0.55],
        [0, 1, 0.55],
        [0, -1, 0.55],
        [1, 1, 0.28],
        [-1, -1, 0.28],
        [1, -1, 0.22],
        [-1, 1, 0.22],
      ];
      for (const [dc, dr, weight] of neighbors) {
        if (Math.random() < 0.72) {
          touchCell(c + dc, r + dr, weight * (0.65 + Math.random() * 0.35), weight * 0.4);
        }
      }
    };

    const render = () => {
      ctx.clearRect(0, 0, cols, rows);

      for (const [key, cell] of cells) {
        cell.alpha -= decay;
        cell.hot = Math.max(0, cell.hot - decay * 1.9);
        if (cell.alpha <= 0.01) {
          cells.delete(key);
          continue;
        }
        const c = key % cols;
        const r = Math.floor(key / cols);
        const a = cell.alpha * maxAlpha;
        // Смешиваем фирменный синий логотипа (#0b5cff) со светлым голубым (#6ea3ff)
        const red = Math.round(11 + cell.hot * 88);
        const green = Math.round(92 + cell.hot * 72);
        const blue = 255;
        ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, ${a.toFixed(3)})`;
        ctx.fillRect(c, r, 1, 1);
      }

      if (cells.size > 0) {
        rafId = window.requestAnimationFrame(render);
      } else {
        rafId = 0;
      }
    };

    const startLoop = () => {
      if (!rafId) {
        rafId = window.requestAnimationFrame(render);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        lastCol = -1;
        lastRow = -1;
        return;
      }
      const col = Math.floor(x / cellSize);
      const row = Math.floor(y / cellSize);

      if (lastCol >= 0 && lastRow >= 0) {
        const dx = col - lastCol;
        const dy = row - lastRow;
        const steps = Math.min(24, Math.max(Math.abs(dx), Math.abs(dy)));
        if (steps > 1) {
          for (let i = 1; i <= steps; i++) {
            const ic = Math.round(lastCol + (dx * i) / steps);
            const ir = Math.round(lastRow + (dy * i) / steps);
            paintStamp(ic, ir);
          }
        } else {
          paintStamp(col, row);
        }
      } else {
        paintStamp(col, row);
      }

      lastCol = col;
      lastRow = row;
      startLoop();
    };

    const onPointerLeave = () => {
      lastCol = -1;
      lastRow = -1;
    };

    let eventTarget: HTMLElement = parent;
    while (eventTarget.parentElement && window.getComputedStyle(eventTarget).pointerEvents === "none") {
      eventTarget = eventTarget.parentElement;
    }

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    eventTarget.addEventListener("pointermove", onPointerMove, { passive: true });
    eventTarget.addEventListener("pointerleave", onPointerLeave, { passive: true });

    return () => {
      ro.disconnect();
      eventTarget.removeEventListener("pointermove", onPointerMove);
      eventTarget.removeEventListener("pointerleave", onPointerLeave);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [cellSize, maxAlpha, decay]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full [image-rendering:pixelated] ${className}`}
    />
  );
}
