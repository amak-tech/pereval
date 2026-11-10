import { isIP } from "node:net";
import { env } from "@/lib/env";

/**
 * Реальный IP клиента. Доверяем X-Real-IP / X-Forwarded-For только когда запрос
 * пришёл от доверенного прокси (nginx из docker-compose). В Next.js адрес TCP-пира
 * недоступен напрямую, поэтому nginx обязан ставить X-Real-IP и затирать чужие
 * X-Forwarded-For — это зафиксировано в deploy/nginx/site.conf.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real && isIP(real)) return normalizeIp(real);
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim() ?? "";
    if (isIP(first)) return normalizeIp(first);
  }
  return "0.0.0.0";
}

export function normalizeIp(ip: string): string {
  // ::ffff:1.2.3.4 -> 1.2.3.4
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}

export function isPublicIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const parts = ip.split(".").map((p) => Number(p));
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a >= 224) return false;
  return true;
}

export function trustedProxies(): Set<string> {
  return new Set(
    env()
      .TRUSTED_PROXY_IPS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
