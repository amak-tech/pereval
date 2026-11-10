import { handle, json, HttpError } from "@/lib/http";
import { authenticateNode } from "@/lib/nodes";
import { loadPublishedCert } from "@/lib/cert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ноды, которым нужен закрытый ключ единого сертификата (терминируют TLS). */
const CERT_KINDS = new Set(["free_primary", "pro_dns", "dedicated"]);

/**
 * Единый TLS-сертификат для нод (cert_sync.py). ETag = sha256 fullchain.pem:
 * `If-None-Match` с тем же значением → 304. 404 — боевого сертификата на CP ещё нет.
 */
export async function GET(req: Request) {
  return handle(async () => {
    const node = await authenticateNode(req);
    if (!CERT_KINDS.has(node.kind)) throw new HttpError(403, "Нода этого типа сертификат не получает.", "forbidden");
    const cert = await loadPublishedCert();
    if (!cert) throw new HttpError(404, "Сертификат на control plane ещё не выпущен.", "no_certificate");
    const etag = `"${cert.sha256}"`;
    const inm = req.headers.get("if-none-match");
    if (inm && inm.split(",").some((v) => v.trim() === etag || v.trim() === cert.sha256)) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
    }
    return json(
      {
        sha256: cert.sha256,
        not_after: cert.notAfter.toISOString(),
        not_before: cert.notBefore.toISOString(),
        names: cert.names,
        fullchain: cert.fullchain,
        privkey: cert.privkey,
      },
      { headers: { ETag: etag } },
    );
  });
}
