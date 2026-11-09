import tls from "node:tls";
import { env } from "@/lib/env";
import { catalog } from "@/lib/catalog";
import { loadPublishedCert, daysLeft as calcDaysLeft } from "@/lib/cert";
import { enqueueAdminMail } from "@/lib/mail";
import { adminAlertMail } from "@/lib/mail-templates";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Единый wildcard-сертификат (pereval.top, *.pereval.top, *.pro.pereval.top, устаревшие
 * Free-имена) выпускается вручную (DNS-01) на control plane и раздаётся нодам.
 * Здесь: напоминания админу за 25 / 14 / 7 / 3 дня до истечения и контроль того,
 * что каждый хост инфраструктуры отдаёт именно текущий сертификат.
 */
export const REMIND_DAYS = [25, 14, 7, 3];
/** Сколько ждать после выпуска, прежде чем ругаться на ноду со старым сертификатом (таймер cert_sync — 1 ч). */
const STALE_GRACE_MS = 6 * 3_600_000;

export type PeerCert = { notAfter: Date; fingerprint256: string; names: string[] };
export type HostStatus = { host: string; peer: PeerCert | null; daysLeft: number | null; current: boolean | null };
export type CertStatus = {
  /** откуда взят эталон: файл на CP или TLS сайта */
  source: "cp" | "tls" | null;
  notAfter: Date | null;
  notBefore: Date | null;
  daysLeft: number | null;
  names: string[];
  fingerprint256: string | null;
  hosts: HostStatus[];
};

export async function peerCert(host: string, port = 443, servername = host): Promise<PeerCert | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: 8_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return resolve(null);
      const alt = (cert.subjectaltname ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("DNS:"))
        .map((s) => s.slice(4));
      resolve({ notAfter: new Date(cert.valid_to), fingerprint256: cert.fingerprint256, names: alt });
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/** Обратная совместимость: дней до истечения сертификата хоста по TLS. */
export async function certDaysLeft(host: string, port = 443): Promise<{ daysLeft: number; notAfter: string } | null> {
  const p = await peerCert(host, port);
  return p ? { daysLeft: calcDaysLeft(p.notAfter), notAfter: p.notAfter.toISOString() } : null;
}

/** Хост сайта — из каталога (services.yaml meta.origin), как и имена сертификата; env — запасной вариант. */
export function siteHost(): string {
  for (const origin of [catalog.meta.origin, env().PUBLIC_ORIGIN]) {
    try {
      const h = new URL(origin).hostname;
      if (h && h !== "localhost") return h;
    } catch {
      /* пробуем следующий */
    }
  }
  return "pereval.top";
}

/** Хосты, которые обязаны отдавать единый сертификат: сайт, Free (все имена), Pro. */
export function watchedHosts(): string[] {
  const out: string[] = [];
  const add = (h: string | undefined | null) => {
    if (h && !out.includes(h)) out.push(h);
  };
  add(siteHost());
  add(catalog.free?.domain ?? env().FREE_DOMAIN);
  for (const d of catalog.free?.legacy_domains ?? []) add(d);
  add(catalog.pro?.domain ?? env().PRO_DOMAIN);
  return out;
}

export function certNames(): string[] {
  return catalog.meta.cert_domains?.length ? catalog.meta.cert_domains : [siteHost(), `*.${siteHost()}`, `*.${catalog.pro?.domain ?? env().PRO_DOMAIN}`];
}

/** TXT-записи, которые попросит certbot при DNS-01 (по одной на имя; apex и *.apex — две записи на одно имя). */
export function acmeTxtRecords(names: string[] = certNames()): string[] {
  const counts = new Map<string, number>();
  for (const n of names) {
    const base = n.startsWith("*.") ? n.slice(2) : n;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return [...counts.entries()].map(([base, k]) => `_acme-challenge.${base}${k > 1 ? ` (${k} записи)` : ""}`);
}

export function renewCommand(): string {
  return "cd /opt/pereval && ./deploy/issue-cert.sh";
}

export async function certStatus(now: Date = new Date()): Promise<CertStatus> {
  const cp = await loadPublishedCert();
  const hosts = watchedHosts();
  const peers = await Promise.all(hosts.map((h) => peerCert(h)));
  let ref: { notAfter: Date; notBefore: Date | null; fingerprint256: string; names: string[]; source: "cp" | "tls" } | null = null;
  if (cp) ref = { notAfter: cp.notAfter, notBefore: cp.notBefore, fingerprint256: cp.fingerprint256, names: cp.names, source: "cp" };
  else if (peers[0]) ref = { notAfter: peers[0].notAfter, notBefore: null, fingerprint256: peers[0].fingerprint256, names: peers[0].names, source: "tls" };
  return {
    source: ref?.source ?? null,
    notAfter: ref?.notAfter ?? null,
    notBefore: ref?.notBefore ?? null,
    daysLeft: ref ? calcDaysLeft(ref.notAfter, now) : null,
    names: ref?.names ?? [],
    fingerprint256: ref?.fingerprint256 ?? null,
    hosts: hosts.map((host, i) => {
      const peer = peers[i] ?? null;
      return {
        host,
        peer,
        daysLeft: peer ? calcDaysLeft(peer.notAfter, now) : null,
        current: peer && ref ? peer.fingerprint256 === ref.fingerprint256 : null,
      };
    }),
  };
}

export function formatHostLine(h: HostStatus): string {
  if (!h.peer) return `  ${h.host}: недоступен`;
  const until = h.peer.notAfter.toISOString().slice(0, 10);
  const mark = h.current === null ? "" : h.current ? " ✓ текущий" : " ✗ СТАРЫЙ сертификат";
  return `  ${h.host}: до ${until} (${h.daysLeft} дн.)${mark}`;
}

export async function checkCertificate(now: Date = new Date()): Promise<{ daysLeft: number | null; notified: string[] }> {
  const st = await certStatus(now);
  const notified: string[] = [];
  if (st.daysLeft === null || !st.notAfter) {
    console.warn("[certwatch] не удалось определить сертификат ни на CP, ни по TLS");
    return { daysLeft: null, notified };
  }
  const notAfterIso = st.notAfter.toISOString();

  // 1) напоминание о продлении
  const threshold = REMIND_DAYS.find((d) => st.daysLeft! <= d);
  if (threshold !== undefined) {
    const key = `certwatch:expiry:${notAfterIso}:${threshold}`;
    if (!(await getSetting(key))) {
      const t = adminAlertMail(
        `Единый сертификат истекает через ${st.daysLeft} дн.`,
        [
          `Wildcard-сертификат инфраструктуры (${certNames().join(", ")}) действует до ${notAfterIso.slice(0, 10)}.`,
          `Он выпускается вручную (DNS-01), автопродления нет. На сервере control plane выполните:`,
          ``,
          `  ${renewCommand()}`,
          ``,
          `certbot попросит TXT-записи у регистратора:`,
          ...acmeTxtRecords().map((r) => `  ${r}`),
          ``,
          `После выпуска nginx на pereval.top подхватит сертификат в течение 5 минут, ноды (free.pereval.top, pro.pereval.top) —`,
          `в течение часа (быстрее: systemctl start pereval-cert-sync на ноде).`,
          ``,
          `Сейчас отдают:`,
          ...st.hosts.map(formatHostLine),
        ].join("\n"),
      );
      await enqueueAdminMail(t.subject, t.text, t.html);
      await setSetting(key, now.toISOString());
      notified.push("expiry");
    }
  }

  // 2) нода отдаёт не тот сертификат, что лежит на CP (после grace-периода на синхронизацию)
  if (st.source === "cp" && st.notBefore && now.getTime() - st.notBefore.getTime() > STALE_GRACE_MS) {
    const stale = st.hosts.filter((h) => h.current === false);
    if (stale.length) {
      const key = `certwatch:stale:${st.fingerprint256}:${stale.map((h) => h.host).join(",")}`;
      if (!(await getSetting(key))) {
        const t = adminAlertMail(
          `Старый сертификат на ${stale.map((h) => h.host).join(", ")}`,
          [
            `На control plane опубликован сертификат до ${notAfterIso.slice(0, 10)}, но эти хосты отдают другой:`,
            ...stale.map(formatHostLine),
            ``,
            `Проверьте на ноде: systemctl status pereval-cert-sync.timer; journalctl -u pereval-cert-sync -n 20;`,
            `NODE_SECRET в /etc/pereval/node.env должен принадлежать ноде типа free_primary / pro_dns (pnpm admin node list).`,
          ].join("\n"),
        );
        await enqueueAdminMail(t.subject, t.text, t.html);
        await setSetting(key, now.toISOString());
        notified.push("stale");
      }
    }
  }
  return { daysLeft: st.daysLeft, notified };
}
