import { z } from "zod";

/**
 * Переменные окружения control plane. Читаются лениво (при первом обращении),
 * чтобы сборка Next.js и unit-тесты не требовали боевых секретов.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:3000"),
  FREE_DOMAIN: z.string().default("free.pereval.top"),
  FREE_DNS_IP: z.string().default("153.80.200.170"),
  PRO_DOMAIN: z.string().default("pro.pereval.top"),
  PRO_DNS_IP: z.string().default(""),
  /** каталог с копией единого сертификата (fullchain.pem + privkey.pem), публикует nginx-контейнер */
  CERT_DIR: z.string().default(""),
  DATABASE_URL: z.string().default("postgres://pereval:pereval@localhost:5432/pereval"),

  AUTH_SECRET: z.string().min(16).default("dev-only-secret-change-me-please-0000"),
  AUTH_GOOGLE_ID: z.string().default(""),
  AUTH_GOOGLE_SECRET: z.string().default(""),
  AUTH_TRUST_HOST: z.string().default("true"),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(3),
  TOKEN_ROTATION_GRACE_HOURS: z.coerce.number().int().min(0).default(48),
  ACL_DYNAMIC_TTL_MINUTES: z.coerce.number().int().min(5).default(120),
  MAX_BOUND_IPS: z.coerce.number().int().min(1).max(20).default(3),
  NODE_MAX_CLIENTS: z.coerce.number().int().min(1).max(100_000).default(150),
  NODE_ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(10_080).default(360),

  LAVA_API_KEY: z.string().default(""),
  LAVA_BASE_URL: z.string().url().default("https://gate.lava.top"),
  LAVA_OFFER_ID_PRO: z.string().default(""),
  LAVA_PRODUCT_ID_PRO: z.string().default(""),
  LAVA_WEBHOOK_KEY: z.string().default(""),
  LAVA_WEBHOOK_IP_ALLOWLIST: z.string().default("158.160.60.174"),
  LAVA_WEBHOOK_IP_MODE: z.enum(["enforce", "log", "off"]).default("log"),
  LAVA_USD_METHOD: z.enum(["UNLIMINT", "PAYPAL", "STRIPE"]).default("UNLIMINT"),
  LAVA_MOCK: z.string().default(""),

  SMTP_HOST: z.string().default("smtp-pulse.com"),
  SMTP_PORT: z.coerce.number().int().default(2525),
  SMTP_USERNAME: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  MAIL_FROM: z.string().default("no-reply@pereval.top"),
  MAIL_FROM_NAME: z.string().default("Перевал"),
  ADMIN_EMAIL: z.string().default("admin@portbuddy.dev"),
  /** кто видит /admin: email'ы через запятую; ADMIN_EMAIL добавляется автоматически */
  ADMIN_EMAILS: z.string().default(""),

  SELLER_LEGAL: z.string().default(""),
  TRUSTED_PROXY_IPS: z.string().default("127.0.0.1"),
  GA_MEASUREMENT_ID: z.string().default("G-3BY15ZZD8D"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Некорректные переменные окружения: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}

export function isMock(): boolean {
  const v = env().LAVA_MOCK;
  return v === "1" || v === "true";
}

export function isProd(): boolean {
  return env().NODE_ENV === "production";
}

/** Для тестов: сбросить кеш после подмены process.env. */
export function resetEnvCache(): void {
  cached = null;
}
