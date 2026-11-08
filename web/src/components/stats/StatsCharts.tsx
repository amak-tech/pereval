"use client";

import { useSyncExternalStore } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SeriesPoint, TopService } from "@/components/stats/types";
import { fmtBytes, fmtNum, fmtTime } from "@/components/stats/format";

/**
 * Графики на recharts (подгружаются динамически, чтобы не утяжелять первый экран).
 * Одна серия на график — легенда не нужна; цвета берутся из CSS-токенов темы.
 */
type Tokens = { accent: string; line: string; mute: string; panel: string; ink: string };

const DEFAULT_TOKENS: Tokens = { accent: "#0b5cff", line: "#e6e5e2", mute: "#6b6b68", panel: "#ffffff", ink: "#1a1a19" };

// Снимок кешируется по строковому ключу: useSyncExternalStore требует стабильную ссылку при неизменных данных.
let tokenCache: { key: string; value: Tokens } = { key: "", value: DEFAULT_TOKENS };

function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const get = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  const next: Tokens = { accent: get("--accent", DEFAULT_TOKENS.accent), line: get("--line", DEFAULT_TOKENS.line), mute: get("--mute", DEFAULT_TOKENS.mute), panel: get("--panel", DEFAULT_TOKENS.panel), ink: get("--ink", DEFAULT_TOKENS.ink) };
  const key = Object.values(next).join("|");
  if (key !== tokenCache.key) tokenCache = { key, value: next };
  return tokenCache.value;
}

function subscribeScheme(onChange: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useTokens(): Tokens {
  return useSyncExternalStore(subscribeScheme, readTokens, () => DEFAULT_TOKENS);
}

type TipProps = { active?: boolean; payload?: ReadonlyArray<{ payload: SeriesPoint & { label: string } }> };

function MinuteTip({ active, payload }: TipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-[var(--shadow-card)]">
      <div className="font-semibold">{p.label}</div>
      <div className="mt-1 grid gap-0.5 text-mute">
        <div>
          Запросы: <span className="text-ink">{fmtNum(p.requests)}</span>
        </div>
        <div>
          Пользователи: <span className="text-ink">{fmtNum(p.unique_users)}</span>
        </div>
        <div>
          Трафик: <span className="text-ink">{fmtBytes(p.bytes)}</span>
        </div>
      </div>
    </div>
  );
}

export function MinuteChart({ points }: { points: SeriesPoint[] }) {
  const t = useTokens();
  const data = points.map((p) => ({ ...p, label: fmtTime(p.ts) }));
  return (
    <div className="h-[220px] w-full" role="img" aria-label="Запросы в минуту за последние 60 минут">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={t.line} strokeWidth={1} />
          <XAxis dataKey="label" interval={9} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: t.mute }} />
          <YAxis allowDecimals={false} width={36} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: t.mute }} tickFormatter={(v: number) => fmtNum(v)} />
          <Tooltip cursor={{ fill: t.line, opacity: 0.5 }} content={<MinuteTip />} isAnimationActive={false} />
          <Bar dataKey="requests" fill={t.accent} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

type TopTipProps = { active?: boolean; payload?: ReadonlyArray<{ payload: TopService }> };

function TopTip({ active, payload }: TopTipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-[var(--shadow-card)]">
      <div className="font-semibold">{p.service}</div>
      <div className="text-mute">{p.category}</div>
      <div className="mt-1 grid gap-0.5 text-mute">
        <div>
          Запросы: <span className="text-ink">{fmtNum(p.requests)}</span>
        </div>
        <div>
          Пользователи: <span className="text-ink">{fmtNum(p.unique_users)}</span>
        </div>
        <div>
          Трафик: <span className="text-ink">{fmtBytes(p.bytes)}</span>
        </div>
      </div>
    </div>
  );
}

export function TopServicesChart({ rows }: { rows: TopService[] }) {
  const t = useTokens();
  const data = rows.slice(0, 10);
  const height = Math.max(120, data.length * 30 + 16);
  return (
    <div className="w-full" style={{ height }} role="img" aria-label="Топ сервисов по числу запросов">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="service" width={150} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: t.ink }} interval={0} />
          <Tooltip cursor={{ fill: t.line, opacity: 0.5 }} content={<TopTip />} isAnimationActive={false} />
          <Bar dataKey="requests" fill={t.accent} radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}>
            <LabelList dataKey="requests" position="right" fill={t.mute} fontSize={11} formatter={(v: unknown) => fmtNum(typeof v === "number" ? v : Number(v))} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
