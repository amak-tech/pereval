import { EventEmitter } from "node:events";
import { sql } from "@/lib/db/client";

/**
 * Событийная шина между процессами `app` и `jobs` через Postgres LISTEN/NOTIFY.
 * Каналы: pereval_policy (политика DNS изменилась), pereval_acl (ACL изменился).
 * Внутри процесса — EventEmitter, на который подписаны long-poll обработчики.
 */
export const CHANNEL_POLICY = "pereval_policy";
export const CHANNEL_ACL = "pereval_acl";

const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

const g = globalThis as unknown as { __perevalListening?: Set<string> };
const listening = (g.__perevalListening ??= new Set<string>());

async function ensureListening(channel: string): Promise<void> {
  if (listening.has(channel)) return;
  listening.add(channel);
  try {
    await sql().listen(channel, (payload) => {
      emitter.emit(channel, payload);
    });
  } catch (err) {
    listening.delete(channel);
    console.warn(`[bus] LISTEN ${channel} не удался: ${(err as Error)?.message ?? err}`);
  }
}

export async function notify(channel: string, payload = ""): Promise<void> {
  // локальным подписчикам — сразу, остальным процессам — через Postgres
  emitter.emit(channel, payload);
  try {
    await sql().notify(channel, payload);
  } catch (err) {
    console.warn(`[bus] NOTIFY ${channel} не удался: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Ждёт, пока `getVersion()` станет отличаться от `known`, но не дольше `timeoutMs`.
 * Будится NOTIFY'ом; на случай потери соединения LISTEN — страховочный опрос раз в 5 с.
 * Возвращает актуальную версию.
 */
export async function waitForVersionChange(
  channel: string,
  known: number,
  getVersion: () => Promise<number>,
  timeoutMs: number,
): Promise<number> {
  await ensureListening(channel);
  const deadline = Date.now() + timeoutMs;
  let current = await getVersion();
  while (current === known && Date.now() < deadline) {
    const left = Math.min(5_000, deadline - Date.now());
    if (left <= 0) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, left);
      function done() {
        clearTimeout(timer);
        emitter.off(channel, done);
        resolve();
      }
      emitter.once(channel, done);
    });
    current = await getVersion();
  }
  return current;
}

/** Для тестов и единичных вызовов без Postgres. */
export function localEmit(channel: string): void {
  emitter.emit(channel, "");
}
