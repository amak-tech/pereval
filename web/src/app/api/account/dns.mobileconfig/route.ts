import { eq, and, isNull } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { catalog } from "@/lib/catalog";
import { env } from "@/lib/env";
import { fail, handle } from "@/lib/http";
import { buildMobileconfig, reverseDomain } from "@/lib/mobileconfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Персональный профиль Apple для Pro: DNS-over-HTTPS с токеном в URL. */
export async function GET() {
  return handle(async () => {
    const user = await requireUser();
    const [tok] = await db()
      .select()
      .from(schema.accessTokens)
      .where(and(eq(schema.accessTokens.userId, user.id), isNull(schema.accessTokens.revokedAt)))
      .limit(1);
    if (!tok) return fail(409, "Токен доступа ещё не выпущен — оплатите подписку.", "no_token");
    const proDomain = catalog.pro?.domain ?? env().PRO_DOMAIN;
    const dnsIp = catalog.pro?.dns_ip ?? env().PRO_DNS_IP;
    const body = buildMobileconfig({
      name: `${catalog.meta.name} Pro`,
      domain: proDomain,
      identifierBase: `${reverseDomain(proDomain)}.dns`,
      // идентификатор постоянный на пользователя, UUID полезной нагрузки — по токену:
      // установка нового профиля заменяет старый
      profileUuidSeed: `${proDomain}:${user.id}`,
      payloadUuidSeed: `${proDomain}:${tok.token}`,
      description: `Персональный профиль ${catalog.meta.name} Pro (${proDomain}). Зашифрованный DNS для доступа к закрытым сервисам по Wi-Fi и в мобильной сети.`,
      dns: { protocol: "HTTPS", serverURL: `https://${proDomain}/dns/${tok.token}`, serverAddresses: dnsIp ? [dnsIp] : [] },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/x-apple-aspen-config; charset=utf-8",
        "Content-Disposition": `attachment; filename="${proDomain}.mobileconfig"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
