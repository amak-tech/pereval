import tls from "node:tls";
import { env } from "@/lib/env";
import { catalog } from "@/lib/catalog";
import { enqueueAdminMail } from "@/lib/mail";
import { adminAlertMail } from "@/lib/mail-templates";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Wildcard-сертификат *.pro.pereval.top выпускается вручную (DNS-01), поэтому
 * за сроком следим сами и напоминаем админу за 25 / 14 / 7 / 3 дня.
 */
export const REMIND_DAYS = [25, 14, 7, 3];

export async function certDaysLeft(host: string, port = 443): Promise<{ daysLeft: number; notAfter: string } | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 8_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return resolve(null);
      const notAfter = new Date(cert.valid_to);
      resolve({ daysLeft: Math.floor((notAfter.getTime() - Date.now()) / 86_400_000), notAfter: notAfter.toISOString() });
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

export function renewCommand(domain: string): string {
  return `certbot certonly --manual --preferred-challenges dns -d ${domain} -d '*.${domain}' --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/pereval-pro-dns.sh`;
}

export async function checkCertificate(): Promise<{ host: string; daysLeft: number | null; notified: boolean }> {
  const host = catalog.pro?.domain ?? env().PRO_DOMAIN;
  const info = await certDaysLeft(host);
  if (!info) {
    console.warn(`[certwatch] не удалось получить сертификат ${host}`);
    return { host, daysLeft: null, notified: false };
  }
  const threshold = REMIND_DAYS.find((d) => info.daysLeft <= d);
  if (threshold === undefined) return { host, daysLeft: info.daysLeft, notified: false };
  const key = `certwatch:${host}:${info.notAfter}:${threshold}`;
  if (await getSetting(key)) return { host, daysLeft: info.daysLeft, notified: false };
  const t = adminAlertMail(
    `Сертификат ${host} истекает через ${info.daysLeft} дн.`,
    [
      `Wildcard-сертификат для ${host} и *.${host} действует до ${info.notAfter}.`,
      `Он выпущен вручную (DNS-01), автопродления нет. На DNS-ноде выполните:`,
      ``,
      `  ${renewCommand(host)}`,
      ``,
      `certbot попросит добавить TXT-запись _acme-challenge.${host} у регистратора pereval.top.`,
      `После успеха deploy-hook скопирует сертификат в /etc/pereval/ssl/, перезагрузит nginx и пошлёт SIGHUP pro_dns.`,
    ].join("\n"),
  );
  await enqueueAdminMail(t.subject, t.text, t.html);
  await setSetting(key, new Date().toISOString());
  return { host, daysLeft: info.daysLeft, notified: true };
}
