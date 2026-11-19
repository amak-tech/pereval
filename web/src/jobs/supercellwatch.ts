import net from "node:net";
import zlib from "node:zlib";
import { enqueueAdminMail } from "@/lib/mail";
import { adminAlertMail } from "@/lib/mail-templates";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Фоновая сверка рукопожатий с игровыми серверами Supercell на TCP/9339 (2 раза в сутки).
 * Проверяет доступность всех апстримов, актуальные major_version, версии ответа LoginFailed (20103),
 * билды из fingerprint.json и отсутствие коллизий сигнатур, отправляя отчёт администратору при изменениях.
 */

export const SUPERCELLWATCH_STATUS_KEY = "supercellwatch:status";

export const MSG_CLIENT_HELLO = 10100;
export const MSG_SERVER_HELLO = 20100;
export const MSG_LOGIN_FAILED = 20103;
export const HEADER_LEN = 7;

const ERR_CONTENT_UPDATE = 7;
const ERR_CLIENT_TOO_OLD = 8;
const ERR_CLIENT_TOO_NEW = 9;
const ERR_CLIENT_TOO_NEW_HD = 12;

export type SupercellUpstreamSpec = {
  id: string;
  name: string;
  host: string;
  port: number;
  expectedMajor: number;
  expectedMsgVersion: number;
  vintError: boolean;
};

/** Эталонные параметры апстримов Supercell (зафиксированы с Pro-воркера 2026-11-16). */
export const SUPERCELL_UPSTREAMS: readonly SupercellUpstreamSpec[] = [
  {
    id: "brawlstars",
    name: "Brawl Stars",
    host: "game.brawlstarsgame.com",
    port: 9339,
    expectedMajor: 70,
    expectedMsgVersion: 12,
    vintError: false,
  },
  {
    id: "clashroyale",
    name: "Clash Royale",
    host: "game.clashroyaleapp.com",
    port: 9339,
    expectedMajor: 16,
    expectedMsgVersion: 10,
    vintError: true,
  },
  {
    id: "clashofclans",
    name: "Clash of Clans",
    host: "gamea.clashofclans.com",
    port: 9339,
    expectedMajor: 18,
    expectedMsgVersion: 13,
    vintError: false,
  },
  {
    id: "hayday",
    name: "Hay Day",
    host: "game.haydaygame.com",
    port: 9339,
    expectedMajor: 1,
    expectedMsgVersion: 5,
    vintError: false,
  },
  {
    id: "boombeach",
    name: "Boom Beach",
    host: "game.boombeachgame.com",
    port: 9339,
    expectedMajor: 63,
    expectedMsgVersion: 4,
    vintError: false,
  },
  {
    id: "squadbusters",
    name: "Squad Busters",
    host: "game.squadbustersgame.com",
    port: 9339,
    expectedMajor: 14,
    expectedMsgVersion: 11,
    vintError: false,
  },
  {
    id: "moco",
    name: "mo.co",
    host: "game.mocogame.com",
    port: 9339,
    expectedMajor: 13,
    expectedMsgVersion: 11,
    vintError: false,
  },
];

export type SupercellUpstreamEntry = {
  id: string;
  name: string;
  host: string;
  port: number;
  ok: boolean;
  major: number | null;
  msgVersion: number | null;
  version: string | null;
  sha: string | null;
  latencyMs: number | null;
  error: string | null;
};

export type SupercellWatchReport = {
  checkedAt: string;
  upstreams: SupercellUpstreamEntry[];
  collisions: string[];
  alertedAt: string | null;
};

export function buildSupercellClientHello(opts: {
  protocol?: number;
  keyVersion?: number;
  major: number;
  field4?: number;
  field5?: number;
  contentHash?: string | null;
  deviceType?: number;
  appStore?: number;
}): Buffer {
  const protocol = opts.protocol ?? 4;
  const keyVersion = opts.keyVersion ?? 50;
  const field4 = opts.field4 ?? 0;
  const field5 = opts.field5 ?? 0;
  const contentHash = opts.contentHash === undefined ? "0".repeat(40) : opts.contentHash;
  const deviceType = opts.deviceType ?? 2;
  const appStore = opts.appStore ?? 2;

  const hashBuf = contentHash === null ? null : Buffer.from(contentHash, "ascii");
  const payloadLen = 20 + 4 + (hashBuf ? hashBuf.length : 0) + 8;
  const out = Buffer.alloc(HEADER_LEN + payloadLen);

  out.writeUInt16BE(MSG_CLIENT_HELLO, 0);
  out[2] = (payloadLen >>> 16) & 0xff;
  out[3] = (payloadLen >>> 8) & 0xff;
  out[4] = payloadLen & 0xff;
  out.writeUInt16BE(0, 5);

  let pos = HEADER_LEN;
  out.writeInt32BE(protocol, pos);
  pos += 4;
  out.writeInt32BE(keyVersion, pos);
  pos += 4;
  out.writeInt32BE(opts.major, pos);
  pos += 4;
  out.writeInt32BE(field4, pos);
  pos += 4;
  out.writeInt32BE(field5, pos);
  pos += 4;

  if (hashBuf === null) {
    out.writeInt32BE(-1, pos);
    pos += 4;
  } else {
    out.writeInt32BE(hashBuf.length, pos);
    pos += 4;
    hashBuf.copy(out, pos);
    pos += hashBuf.length;
  }

  out.writeInt32BE(deviceType, pos);
  pos += 4;
  out.writeInt32BE(appStore, pos);
  return out;
}

export function parseSupercellHeader(hdr: Buffer): { msgId: number; payloadLen: number; msgVersion: number } {
  if (hdr.length < HEADER_LEN) {
    throw new Error(`truncated Supercell header: ${hdr.length} bytes`);
  }
  const msgId = hdr.readUInt16BE(0);
  const payloadLen = (hdr[2]! << 16) | (hdr[3]! << 8) | hdr[4]!;
  const msgVersion = hdr.readUInt16BE(5);
  return { msgId, payloadLen, msgVersion };
}

export function decodeSupercellLoginFailedCode(body: Buffer, vintError = false): number {
  if (!body.length) return -1;
  if (vintError) {
    const b0 = body[0]!;
    if ((b0 & 0xc0) === 0 && (body.length < 4 || !(body[0] === 0 && body[1] === 0 && body[2] === 0))) {
      return b0 & 0x3f;
    }
  }
  if (body.length >= 4 && body[0] === 0 && body[1] === 0 && body[2] === 0) {
    return body.readInt32BE(0);
  }
  return body[0]! & 0x3f;
}

export function extractSupercellFingerprint(body: Buffer): { version: string | null; sha: string | null } | null {
  if (!body.length) return null;

  const tryParseJson = (buf: Buffer): { version: string | null; sha: string | null } | null => {
    const start = buf.indexOf(0x7b); // '{'
    const end = buf.lastIndexOf(0x7d); // '}'
    if (start === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(buf.subarray(start, end + 1).toString("utf8")) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") return null;
      const version = typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
      const sha = typeof parsed.sha === "string" && parsed.sha.trim() ? parsed.sha.trim().toLowerCase() : null;
      if (version || sha) return { version, sha };
    } catch {
      /* не JSON */
    }
    return null;
  };

  const directIdx = body.indexOf('{"files"');
  if (directIdx !== -1) {
    const direct = tryParseJson(body.subarray(directIdx));
    if (direct) return direct;
  }

  const scanLimit = Math.min(body.length - 6, 512);
  for (let i = 0; i < scanLimit; i++) {
    if (body[i] === 0x78 && (body[i + 1] === 0x01 || body[i + 1] === 0x5e || body[i + 1] === 0x9c || body[i + 1] === 0xda)) {
      try {
        const inflated = zlib.inflateSync(body.subarray(i), { maxOutputLength: 4 * 1024 * 1024 });
        const parsed = tryParseJson(inflated);
        if (parsed) return parsed;
      } catch {
        /* пробуем следующее смещение */
      }
    }
  }
  return null;
}

export async function probeSupercellPacket(
  host: string,
  port: number,
  packet: Buffer,
  timeoutMs = 4_000,
  maxBodyBytes = 64,
): Promise<{ msgId: number; payloadLen: number; msgVersion: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let header: { msgId: number; payloadLen: number; msgVersion: number } | null = null;
    let targetBodyBytes = 0;

    const socket = net.createConnection({ host, port });
    const finish = (err?: Error, res?: { msgId: number; payloadLen: number; msgVersion: number; body: Buffer }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else if (res) resolve(res);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish(new Error(`timeout after ${timeoutMs}ms`)));
    socket.on("error", (err) => finish(err));
    socket.on("connect", () => {
      socket.write(packet);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;

      if (!header && totalBytes >= HEADER_LEN) {
        const merged = Buffer.concat(chunks, totalBytes);
        header = parseSupercellHeader(merged);
        if (header.payloadLen > 2 * 1024 * 1024) {
          finish(new Error(`oversized payload: ${header.payloadLen}`));
          return;
        }
        targetBodyBytes = Math.min(header.payloadLen, maxBodyBytes);
      }

      if (header && totalBytes >= HEADER_LEN + targetBodyBytes) {
        const merged = Buffer.concat(chunks, totalBytes);
        finish(undefined, {
          msgId: header.msgId,
          payloadLen: header.payloadLen,
          msgVersion: header.msgVersion,
          body: merged.subarray(HEADER_LEN, HEADER_LEN + targetBodyBytes),
        });
      }
    });
    socket.on("end", () => {
      finish(new Error("connection closed before Supercell response"));
    });
  });
}

export async function discoverSupercellSignature(
  spec: SupercellUpstreamSpec,
  timeoutMs = 4_000,
  maxMajor = 200,
): Promise<SupercellUpstreamEntry> {
  const started = Date.now();
  try {
    let lo = 1;
    let hi = maxMajor;
    let sawOld = false;
    let sawNew = false;
    let foundMajor: number | null = null;
    let lastMsgVersion: number | null = null;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const pkt = buildSupercellClientHello({ protocol: 4, keyVersion: 50, major: mid, field4: 0, field5: 0 });
      const resp = await probeSupercellPacket(spec.host, spec.port, pkt, timeoutMs, 64);
      if (resp.msgId !== MSG_SERVER_HELLO && resp.msgId !== MSG_LOGIN_FAILED) {
        throw new Error(`неожиданный msg_id=${resp.msgId}`);
      }
      lastMsgVersion = resp.msgVersion;
      const ec = resp.msgId === MSG_SERVER_HELLO ? 0 : decodeSupercellLoginFailedCode(resp.body, spec.vintError);
      if (ec === ERR_CLIENT_TOO_OLD) {
        sawOld = true;
        lo = mid + 1;
      } else if (ec === ERR_CLIENT_TOO_NEW || ec === ERR_CLIENT_TOO_NEW_HD) {
        sawNew = true;
        hi = mid - 1;
      } else {
        foundMajor = mid;
        break;
      }
    }

    if (foundMajor === null && sawOld && sawNew && hi >= 1) {
      foundMajor = hi;
    }
    if (foundMajor === null) {
      throw new Error(`не удалось определить major_version (lo=${lo}, hi=${hi})`);
    }

    let fp: { version: string | null; sha: string | null } | null = null;
    for (const [f4, f5] of [
      [0, 5000],
      [5000, 0],
    ] as const) {
      try {
        const pkt = buildSupercellClientHello({ protocol: 2, keyVersion: 50, major: foundMajor, field4: f4, field5: f5 });
        const preview = await probeSupercellPacket(spec.host, spec.port, pkt, timeoutMs, 32);
        if (preview.msgId === MSG_LOGIN_FAILED && preview.payloadLen <= 1_048_576) {
          const ec = decodeSupercellLoginFailedCode(preview.body, spec.vintError);
          if (ec === ERR_CONTENT_UPDATE) {
            const full = await probeSupercellPacket(spec.host, spec.port, pkt, timeoutMs, preview.payloadLen);
            fp = extractSupercellFingerprint(full.body);
            if (fp) break;
          }
        }
      } catch {
        /* на части игр требуется точный protocol для ec=7 — сам major уже подтверждён */
      }
    }

    return {
      id: spec.id,
      name: spec.name,
      host: spec.host,
      port: spec.port,
      ok: true,
      major: foundMajor,
      msgVersion: lastMsgVersion,
      version: fp?.version ?? null,
      sha: fp?.sha ?? null,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      id: spec.id,
      name: spec.name,
      host: spec.host,
      port: spec.port,
      ok: false,
      major: null,
      msgVersion: null,
      version: null,
      sha: null,
      latencyMs: null,
      error: String((err as Error)?.message ?? err),
    };
  }
}

export function findMajorCollisions(entries: SupercellUpstreamEntry[]): string[] {
  const byMajor = new Map<number, string[]>();
  for (const e of entries) {
    if (e.ok && e.major !== null) {
      const list = byMajor.get(e.major) ?? [];
      list.push(e.name);
      byMajor.set(e.major, list);
    }
  }
  const out: string[] = [];
  for (const [maj, names] of [...byMajor.entries()].sort((a, b) => a[0] - b[0])) {
    if (names.length > 1) {
      out.push(`major=${maj}: ${names.join(", ")}`);
    }
  }
  return out;
}

function baselineFromSpecs(specs: readonly SupercellUpstreamSpec[]): SupercellWatchReport {
  return {
    checkedAt: "",
    upstreams: specs.map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      ok: true,
      major: s.expectedMajor,
      msgVersion: s.expectedMsgVersion,
      version: null,
      sha: null,
      latencyMs: null,
      error: null,
    })),
    collisions: [],
    alertedAt: null,
  };
}

/**
 * Сравнивает текущий снимок апстримов с предыдущим (или со встроенным эталоном при первом запуске)
 * и решает, нужно ли отправлять письмо администратору.
 */
export function evaluateSupercellChanges(
  currentUpstreams: SupercellUpstreamEntry[],
  previous: SupercellWatchReport | null,
  now: Date,
  specs: readonly SupercellUpstreamSpec[] = SUPERCELL_UPSTREAMS,
  failureReminderHours = 24,
): {
  changes: string[];
  collisions: string[];
  shouldNotify: boolean;
  nextAlertedAt: string | null;
} {
  const ref = previous ?? baselineFromSpecs(specs);
  const prevById = new Map(ref.upstreams.map((u) => [u.id, u]));
  const changes: string[] = [];

  for (const cur of currentUpstreams) {
    const prev = prevById.get(cur.id);
    if (!prev) {
      if (!cur.ok) {
        changes.push(`${cur.name} (${cur.host}:${cur.port}): ошибка проверки — ${cur.error ?? "недоступен"}`);
      }
      continue;
    }

    if (prev.ok && !cur.ok) {
      changes.push(`${cur.name} (${cur.host}:${cur.port}): рукопожатие не прошло — ${cur.error ?? "недоступен"}`);
      continue;
    }
    if (!prev.ok && cur.ok) {
      changes.push(`${cur.name} (${cur.host}:${cur.port}): соединение восстановлено (major=${cur.major}${cur.version ? `, v${cur.version}` : ""})`);
      continue;
    }

    if (cur.ok && prev.ok) {
      if (prev.major !== null && cur.major !== prev.major) {
        changes.push(`${cur.name}: изменился major_version ${prev.major} → ${cur.major}`);
      }
      if (prev.msgVersion !== null && cur.msgVersion !== null && cur.msgVersion !== prev.msgVersion) {
        changes.push(`${cur.name}: изменилась версия ответа LoginFailed (20103) v${prev.msgVersion} → v${cur.msgVersion}`);
      }
      if (prev.version && cur.version && cur.version !== prev.version) {
        changes.push(`${cur.name}: обновилась версия клиента ${prev.version} → ${cur.version}`);
      }
    }
  }

  const collisions = findMajorCollisions(currentUpstreams);
  const prevCollisions = new Set(ref.collisions ?? []);
  for (const col of collisions) {
    if (!prevCollisions.has(col)) {
      changes.push(`Обнаружена коллизия сигнатур (${col})`);
    }
  }

  const anyDown = currentUpstreams.some((u) => !u.ok);
  const prevAlertedAt = previous?.alertedAt ?? null;

  if (changes.length > 0) {
    return {
      changes,
      collisions,
      shouldNotify: true,
      nextAlertedAt: now.toISOString(),
    };
  }

  if (anyDown) {
    const prevTs = prevAlertedAt ? Date.parse(prevAlertedAt) : NaN;
    const reminderMs = Math.max(1, failureReminderHours) * 3_600_000;
    if (!Number.isFinite(prevTs) || now.getTime() - prevTs >= reminderMs) {
      const failing = currentUpstreams.filter((u) => !u.ok);
      return {
        changes: failing.map((u) => `${u.name} (${u.host}:${u.port}): по-прежнему недоступен — ${u.error ?? "ошибка"}`),
        collisions,
        shouldNotify: true,
        nextAlertedAt: now.toISOString(),
      };
    }
    return {
      changes: [],
      collisions,
      shouldNotify: false,
      nextAlertedAt: prevAlertedAt,
    };
  }

  return {
    changes: [],
    collisions,
    shouldNotify: false,
    nextAlertedAt: null,
  };
}

export function formatSupercellUpstreamLine(u: SupercellUpstreamEntry): string {
  if (!u.ok) {
    return `  • ${u.name} (${u.host}:${u.port}): ✗ ОШИБКА — ${u.error ?? "недоступен"}`;
  }
  const verPart = u.version ? `, билд ${u.version}` : "";
  const msgPart = u.msgVersion !== null ? `, msgVer=${u.msgVersion}` : "";
  const latPart = u.latencyMs !== null ? ` (${u.latencyMs} мс)` : "";
  return `  • ${u.name} (${u.host}:${u.port}): major=${u.major}${msgPart}${verPart}${latPart}`;
}

export async function getSupercellWatchStatus(): Promise<SupercellWatchReport | null> {
  return getSetting<SupercellWatchReport>(SUPERCELLWATCH_STATUS_KEY);
}

export async function probeAllSupercellUpstreams(
  specs: readonly SupercellUpstreamSpec[] = SUPERCELL_UPSTREAMS,
  timeoutMs = 4_000,
): Promise<SupercellUpstreamEntry[]> {
  return Promise.all(specs.map((s) => discoverSupercellSignature(s, timeoutMs)));
}

export async function checkSupercellUpstreams(
  now: Date = new Date(),
  prober: () => Promise<SupercellUpstreamEntry[]> = () => probeAllSupercellUpstreams(),
): Promise<{ checked: number; failed: number; collisions: number; notified: boolean; changes: string[] }> {
  const previous = await getSupercellWatchStatus();
  const upstreams = await prober();
  const decision = evaluateSupercellChanges(upstreams, previous, now);

  const report: SupercellWatchReport = {
    checkedAt: now.toISOString(),
    upstreams,
    collisions: decision.collisions,
    alertedAt: decision.nextAlertedAt,
  };

  if (decision.shouldNotify) {
    const failedCount = upstreams.filter((u) => !u.ok).length;
    const subject =
      failedCount > 0
        ? `Supercell (:9339): проблема рукопожатия (${failedCount} из ${upstreams.length})`
        : decision.collisions.length > 0
          ? `Supercell (:9339): коллизия major_version (${decision.collisions.join("; ")})`
          : `Supercell (:9339): изменились параметры рукопожатия`;

    const bodyLines = [
      `Фоновая проверка апстримов Supercell (supercellwatch) обнаружила изменения:`,
      ``,
      ...decision.changes.map((c) => `  — ${c}`),
      ``,
      `Текущее состояние игровых серверов (:9339):`,
      ...upstreams.map(formatSupercellUpstreamLine),
    ];

    if (decision.collisions.length > 0) {
      bodyLines.push(
        ``,
        `Внимание: у нескольких игр совпал major_version (${decision.collisions.join("; ")}).`,
        `Демон supercell_proxy.py на Pro-воркерах разрешает такие коллизии по полю protocol и живому ответу ServerHello (20100), но рекомендуется проверить маршрутизацию.`,
      );
    } else {
      bodyLines.push(
        ``,
        `Демон supercell_proxy.py на Pro-воркерах автоматически подхватывает новые major_version при фоновом опросе и по ответам ServerHello (20100).`,
      );
    }

    const mail = adminAlertMail(subject, bodyLines.join("\n"));
    await enqueueAdminMail(mail.subject, mail.text, mail.html);
  }

  await setSetting(SUPERCELLWATCH_STATUS_KEY, report);

  return {
    checked: upstreams.length,
    failed: upstreams.filter((u) => !u.ok).length,
    collisions: decision.collisions.length,
    notified: decision.shouldNotify,
    changes: decision.changes,
  };
}
