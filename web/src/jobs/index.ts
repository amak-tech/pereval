/**
 * Фоновый процесс `jobs` (отдельный контейнер из того же образа):
 * outbox почты, истечение ACL, DDNS, сверка подписок, слежение за сертификатом,
 * ежедневный дайджест. Один экземпляр; интервалы — ниже.
 */
import { sendPendingMail } from "@/lib/mail";
import { expireDynamicAcl } from "@/lib/acl";
import { refreshDdnsHosts } from "@/lib/ddns";
import { reconcileSubscriptions } from "@/lib/billing";
import { checkCertificate } from "@/jobs/certwatch";
import { sendDailyDigest } from "@/jobs/digest";
import { cleanupRetention } from "@/jobs/retention";

type Job = { name: string; everyMs: number; run: () => Promise<unknown>; last: number; running: boolean };

const jobs: Job[] = [
  { name: "outbox", everyMs: 15_000, run: () => sendPendingMail(20), last: 0, running: false },
  { name: "acl-expire", everyMs: 30_000, run: () => expireDynamicAcl(), last: 0, running: false },
  { name: "ddns", everyMs: 60_000, run: () => refreshDdnsHosts(), last: 0, running: false },
  { name: "reconcile", everyMs: 6 * 3_600_000, run: () => reconcileSubscriptions(), last: 0, running: false },
  { name: "certwatch", everyMs: 12 * 3_600_000, run: () => checkCertificate(), last: 0, running: false },
  { name: "digest", everyMs: 3_600_000, run: () => sendDailyDigest(), last: 0, running: false },
  { name: "retention", everyMs: 24 * 3_600_000, run: () => cleanupRetention(), last: 0, running: false },
];

let stopping = false;

async function tick(): Promise<void> {
  const now = Date.now();
  for (const job of jobs) {
    if (job.running || now - job.last < job.everyMs) continue;
    job.running = true;
    job.last = now;
    job
      .run()
      .then((res) => {
        if (res && typeof res === "object") console.log(`[jobs] ${job.name}: ${JSON.stringify(res)}`);
        else if (typeof res === "number" && res > 0) console.log(`[jobs] ${job.name}: ${res}`);
      })
      .catch((err) => console.error(`[jobs] ${job.name} failed:`, err))
      .finally(() => {
        job.running = false;
      });
  }
}

async function main(): Promise<void> {
  console.log(`[jobs] старт, ${jobs.length} задач`);
  const timer = setInterval(() => {
    if (!stopping) void tick();
  }, 5_000);
  void tick();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log("[jobs] остановка");
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main();
