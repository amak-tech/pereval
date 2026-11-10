import { createHash, X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Единый TLS-сертификат инфраструктуры (pereval.top, *.pereval.top, *.pro.pereval.top,
 * устаревшие Free-имена). Выпускается на CP (`deploy/issue-cert.sh`, DNS-01 вручную),
 * nginx-контейнер публикует копию в CERT_DIR с правами для приложения, а ноды
 * (Free primary, pro-dns) забирают её через /api/internal/v1/node/cert (cert_sync.py).
 */
export type PublishedCert = {
  /** sha256 fullchain.pem в hex — ETag для нод */
  sha256: string;
  notAfter: Date;
  notBefore: Date;
  names: string[];
  selfSigned: boolean;
  /** SHA-256 отпечаток DER (формат AA:BB:…) — сравнивается с тем, что отдают ноды по TLS */
  fingerprint256: string;
  fullchain: string;
  privkey: string;
};

export type ParsedCert = { notAfter: Date; notBefore: Date; names: string[]; selfSigned: boolean; fingerprint256: string };

export function parseCertificate(fullchainPem: string): ParsedCert {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(fullchainPem)?.[0];
  if (!first) throw new Error("fullchain.pem не содержит сертификата");
  const x = new X509Certificate(first);
  const names = (x.subjectAltName ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4));
  if (names.length === 0) {
    const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1];
    if (cn) names.push(cn.trim());
  }
  return {
    notAfter: new Date(x.validTo),
    notBefore: new Date(x.validFrom),
    names,
    selfSigned: x.issuer === x.subject,
    fingerprint256: x.fingerprint256,
  };
}

/** host покрыт именем сертификата: точное совпадение или wildcard одного уровня. */
export function certCovers(host: string, names: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return names.some((raw) => {
    const n = raw.toLowerCase().replace(/\.$/, "");
    if (n === h) return true;
    if (!n.startsWith("*.")) return false;
    const dot = h.indexOf(".");
    return dot > 0 && h.slice(dot + 1) === n.slice(2);
  });
}

let cache: { key: string; value: PublishedCert | null } | null = null;

/**
 * Читает опубликованный сертификат из CERT_DIR. null — файлов нет (ещё не выпущен)
 * или это временный самоподписанный (его нодам не раздаём).
 * Кеш — по mtime файлов, чтобы long-poll'ы нод не читали диск каждый раз.
 */
export async function loadPublishedCert(dir = env().CERT_DIR): Promise<PublishedCert | null> {
  if (!dir) return null;
  const chainPath = path.join(dir, "fullchain.pem");
  const keyPath = path.join(dir, "privkey.pem");
  let key: string;
  try {
    const [cs, ks] = await Promise.all([stat(chainPath), stat(keyPath)]);
    key = `${dir}:${cs.mtimeMs}:${cs.size}:${ks.mtimeMs}:${ks.size}`;
  } catch {
    cache = { key: `${dir}:missing`, value: null };
    return null;
  }
  if (cache && cache.key === key) return cache.value;
  try {
    const [fullchain, privkey] = await Promise.all([readFile(chainPath, "utf8"), readFile(keyPath, "utf8")]);
    const parsed = parseCertificate(fullchain);
    const value: PublishedCert | null = parsed.selfSigned
      ? null
      : {
          sha256: createHash("sha256").update(fullchain, "utf8").digest("hex"),
          fullchain,
          privkey,
          ...parsed,
        };
    cache = { key, value };
    return value;
  } catch (err) {
    console.warn(`[cert] не удалось прочитать ${dir}:`, (err as Error).message);
    cache = { key, value: null };
    return null;
  }
}

/** Для тестов. */
export function resetCertCache(): void {
  cache = null;
}

export function daysLeft(notAfter: Date, now: Date = new Date()): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
}
