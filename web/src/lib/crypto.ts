import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Персональный DNS-токен: 20 символов base32 (100 бит), валидная DNS-метка. */
export function generateAccessToken(): string {
  const bytes = randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) {
    out += BASE32[(bytes[i] as number) % 32];
  }
  return out;
}

export const ACCESS_TOKEN_RE = /^[a-z2-7]{20}$/;

/** Секрет для нод / DDNS-ключ / opaque-токены: url-safe base64 без паддинга. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Хэш секрета для хранения (ноды, DDNS-ключи). Соль не нужна: энтропия ≥ 256 бит. */
export function hashSecret(secret: string): string {
  return sha256Hex(`pereval-secret:${secret}`);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // сравниваем с самим собой, чтобы время не зависело от длины
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Хэш Auth.js для verification_tokens: sha256(token + secret), как в @auth/core. */
export function hashAuthToken(token: string, secret: string): string {
  return sha256Hex(`${token}${secret}`);
}

/** Суточный хэш IP (как в stats_collector.py): IP не хранится, хэш меняется каждые 24 ч. */
export function hashIpDaily(ip: string, seed: string, now: Date = new Date()): string {
  const day = Math.floor(now.getTime() / 86_400_000);
  return createHash("blake2b512").update(`${seed}:${day}:${ip}`).digest("hex").slice(0, 16);
}
