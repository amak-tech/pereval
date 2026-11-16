import net from "node:net";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildSupercellClientHello,
  decodeSupercellLoginFailedCode,
  discoverSupercellSignature,
  evaluateSupercellChanges,
  extractSupercellFingerprint,
  findMajorCollisions,
  HEADER_LEN,
  MSG_LOGIN_FAILED,
  parseSupercellHeader,
  SUPERCELL_UPSTREAMS,
  type SupercellUpstreamEntry,
} from "@/jobs/supercellwatch";

function makeLoginFailedPacket(errCode: number, extra: Buffer = Buffer.alloc(0), vint = false, msgVer = 12): Buffer {
  const codeBuf = vint ? Buffer.from([errCode & 0x3f]) : Buffer.alloc(4);
  if (!vint) codeBuf.writeInt32BE(errCode, 0);
  const body = Buffer.concat([codeBuf, extra]);
  const hdr = Buffer.alloc(HEADER_LEN);
  hdr.writeUInt16BE(MSG_LOGIN_FAILED, 0);
  hdr[2] = (body.length >>> 16) & 0xff;
  hdr[3] = (body.length >>> 8) & 0xff;
  hdr[4] = body.length & 0xff;
  hdr.writeUInt16BE(msgVer, 5);
  return Buffer.concat([hdr, body]);
}

describe("supercellwatch protocol helpers", () => {
  it("кодирует ClientHello (10100) и разбирает заголовок и LoginFailed", () => {
    const pkt = buildSupercellClientHello({ protocol: 2, keyVersion: 60, major: 70, field4: 1, field5: 820 });
    const hdr = parseSupercellHeader(pkt);
    expect(hdr.msgId).toBe(10100);
    expect(hdr.payloadLen).toBe(72);
    expect(pkt.readInt32BE(HEADER_LEN + 8)).toBe(70);

    expect(decodeSupercellLoginFailedCode(Buffer.from([0, 0, 0, 8, 0xff]), false)).toBe(8);
    expect(decodeSupercellLoginFailedCode(Buffer.from([9, 0xff, 0xff, 0xff]), true)).toBe(9);
  });

  it("распаковывает сжатый zlib fingerprint.json из тела ответа с кодом 7", () => {
    const jsonRaw = Buffer.from(JSON.stringify({ files: [], version: "70.820.1", sha: "15F41BEC0B4EF44565550EF0A80AEA899C7E70A6" }), "utf8");
    const deflated = zlib.deflateSync(jsonRaw);
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32LE(jsonRaw.length, 0);
    const body = Buffer.concat([Buffer.from([0, 0, 0, 7, 0xff, 0xff, 0xff, 0xff]), lenPrefix, deflated]);

    const fp = extractSupercellFingerprint(body);
    expect(fp).toEqual({
      version: "70.820.1",
      sha: "15f41bec0b4ef44565550ef0a80aea899c7e70a6",
    });
  });

  it("определяет актуальный major_version и fingerprint бинарным поиском по TCP", async () => {
    const liveMajor = 74;
    const fpJson = Buffer.from(JSON.stringify({ files: [], version: "74.100.3", sha: "a".repeat(40) }), "utf8");
    const fpZlib = zlib.deflateSync(fpJson);

    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < HEADER_LEN) return;
        const { payloadLen } = parseSupercellHeader(buf);
        if (buf.length < HEADER_LEN + payloadLen) return;
        const major = buf.readInt32BE(HEADER_LEN + 8);
        const field5 = buf.readInt32BE(HEADER_LEN + 16);
        if (major < liveMajor) {
          socket.end(makeLoginFailedPacket(8, Buffer.alloc(12), false, 12));
        } else if (major > liveMajor) {
          socket.end(makeLoginFailedPacket(9, Buffer.alloc(12), false, 12));
        } else if (field5 >= 1000) {
          socket.end(makeLoginFailedPacket(7, fpZlib, false, 12));
        } else {
          socket.end(makeLoginFailedPacket(8, Buffer.alloc(12), false, 12));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as net.AddressInfo;

    try {
      const entry = await discoverSupercellSignature(
        {
          id: "brawlstars",
          name: "Brawl Stars",
          host: "127.0.0.1",
          port: addr.port,
          expectedMajor: 70,
          expectedMsgVersion: 12,
          vintError: false,
        },
        2_000,
      );
      expect(entry.ok).toBe(true);
      expect(entry.major).toBe(74);
      expect(entry.msgVersion).toBe(12);
      expect(entry.version).toBe("74.100.3");
      expect(entry.sha).toBe("a".repeat(40));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("evaluateSupercellChanges", () => {
  const now = new Date("2026-11-16T12:00:00Z");

  function matchingBaselineEntries(): SupercellUpstreamEntry[] {
    return SUPERCELL_UPSTREAMS.map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      ok: true,
      major: s.expectedMajor,
      msgVersion: s.expectedMsgVersion,
      version: s.id === "brawlstars" ? "70.820.1" : null,
      sha: null,
      latencyMs: 35,
      error: null,
    }));
  }

  it("не шлёт ложный алерт при первом запуске, если все апстримы соответствуют эталону", () => {
    const entries = matchingBaselineEntries();
    const res = evaluateSupercellChanges(entries, null, now);
    expect(res.shouldNotify).toBe(false);
    expect(res.changes).toEqual([]);
    expect(res.collisions).toEqual([]);
  });

  it("обнаруживает смену major_version, билда, падение апстрима и коллизию сигнатур", () => {
    const prevEntries = matchingBaselineEntries();
    const prevReport = {
      checkedAt: "2026-11-16T00:00:00.000Z",
      upstreams: prevEntries,
      collisions: [],
      alertedAt: null,
    };

    // 1. Обновление major у Brawl Stars (70 -> 71)
    const next1 = matchingBaselineEntries().map((u) =>
      u.id === "brawlstars" ? { ...u, major: 71, version: "71.100.1" } : u,
    );
    const d1 = evaluateSupercellChanges(next1, prevReport, now);
    expect(d1.shouldNotify).toBe(true);
    expect(d1.changes.some((c) => c.includes("70 → 71"))).toBe(true);
    expect(d1.changes.some((c) => c.includes("70.820.1 → 71.100.1"))).toBe(true);

    // 2. Коллизия major между Clash Royale и Clash of Clans (оба = 18)
    const nextCollision = matchingBaselineEntries().map((u) =>
      u.id === "clashroyale" ? { ...u, major: 18 } : u,
    );
    expect(findMajorCollisions(nextCollision)).toEqual(["major=18: Clash Royale, Clash of Clans"]);
    const dCol = evaluateSupercellChanges(nextCollision, prevReport, now);
    expect(dCol.shouldNotify).toBe(true);
    expect(dCol.changes.some((c) => c.includes("коллизия"))).toBe(true);

    // 3. Падение апстрима и повторное напоминание только спустя 24 часа
    const nextDown = matchingBaselineEntries().map((u) =>
      u.id === "hayday" ? { ...u, ok: false, major: null, msgVersion: null, error: "timeout after 4000ms" } : u,
    );
    const dDown1 = evaluateSupercellChanges(nextDown, prevReport, now);
    expect(dDown1.shouldNotify).toBe(true);

    const reportAfterDown = {
      checkedAt: now.toISOString(),
      upstreams: nextDown,
      collisions: [],
      alertedAt: dDown1.nextAlertedAt,
    };
    const twelveHoursLater = new Date(now.getTime() + 12 * 3_600_000);
    const dDown2 = evaluateSupercellChanges(nextDown, reportAfterDown, twelveHoursLater, SUPERCELL_UPSTREAMS, 24);
    expect(dDown2.shouldNotify).toBe(false);

    const twentyFiveHoursLater = new Date(now.getTime() + 25 * 3_600_000);
    const dDown3 = evaluateSupercellChanges(nextDown, reportAfterDown, twentyFiveHoursLater, SUPERCELL_UPSTREAMS, 24);
    expect(dDown3.shouldNotify).toBe(true);
  });
});
