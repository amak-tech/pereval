import { catalog } from "@/lib/catalog";
import { buildMobileconfig, reverseDomain } from "@/lib/mobileconfig";

export const runtime = "nodejs";
export const dynamic = "force-static";

/** Профиль Apple для бесплатной версии: DNS-over-TLS на free.pereval.top. */
export async function GET() {
  const domain = catalog.free.domain;
  const body = buildMobileconfig({
    name: catalog.meta.name,
    domain,
    identifierBase: `${reverseDomain(domain)}.dns`,
    profileUuidSeed: domain,
    payloadUuidSeed: domain,
    description: `Профиль DNS-сервера ${catalog.meta.name} (${domain}) для доступа к закрытым сервисам по Wi-Fi и в мобильной сети.`,
    dns: { protocol: "TLS", serverName: domain, serverAddresses: [catalog.free.dns_ip] },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-apple-aspen-config; charset=utf-8",
      "Content-Disposition": `attachment; filename="${domain}.mobileconfig"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
