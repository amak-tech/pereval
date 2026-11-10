import { clientIp } from "@/lib/ip";
import { allow } from "@/lib/ratelimit";
import { handleDynDnsUpdate, parseBasicAuth } from "@/lib/ddns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DynDNS2-совместимый эндпоинт для роутеров (Keenetic, MikroTik, ASUS, OpenWrt, Synology):
 *   GET /nic/update?hostname=<любое>&myip=<ip>   с HTTP Basic: логин = email, пароль = DDNS-ключ.
 * Ответы по протоколу: good <ip> | nochg <ip> | badauth | abuse | nohost | dnserr | 911.
 */
function text(body: string, status = 200): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...(status === 401 ? { "WWW-Authenticate": 'Basic realm="pereval-ddns"' } : {}) },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = parseBasicAuth(req.headers.get("authorization"));
  if (!auth) return text("badauth", 401);
  if (!allow(`ddns:${auth.login.toLowerCase()}`, 2, 60_000)) return text("abuse", 429);
  try {
    const outcome = await handleDynDnsUpdate(auth, url.searchParams.get("myip"), clientIp(req.headers));
    const body = outcome.ip && (outcome.body === "good" || outcome.body === "nochg") ? `${outcome.body} ${outcome.ip}` : outcome.body;
    return text(body, outcome.status);
  } catch (err) {
    console.error("[ddns] error:", err);
    return text("911", 500);
  }
}
