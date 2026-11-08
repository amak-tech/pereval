import {
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------- Auth.js
// Стандартная схема @auth/drizzle-adapter (users / accounts / sessions / verification_tokens).

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique().notNull(),
  emailVerified: ts("email_verified"),
  image: text("image"),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: ts("expires").notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: ts("expires").notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// ---------------------------------------------------------------- Наши таблицы

export const usersMeta = pgTable("users_meta", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastLoginAt: ts("last_login_at"),
  locale: text("locale").notNull().default("ru"),
});

export type SubscriptionStatus = "pending" | "active" | "past_due" | "cancelled" | "expired";

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plan: text("plan").notNull().default("pro"),
    provider: text("provider").notNull().default("lava"),
    parentContractId: text("parent_contract_id").unique(),
    offerId: text("offer_id"),
    currency: text("currency"),
    periodicity: text("periodicity").notNull().default("MONTHLY"),
    status: text("status").$type<SubscriptionStatus>().notNull().default("pending"),
    startedAt: ts("started_at"),
    // Чистый конец оплаченного периода; grace добавляется только при past_due (см. lib/subscription.ts)
    periodEnd: ts("period_end"),
    cancelledAt: ts("cancelled_at"),
    lastEventAt: ts("last_event_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("subscriptions_user_idx").on(t.userId), index("subscriptions_status_idx").on(t.status)],
);

export type InvoiceKind = "first" | "renewal";

export const invoices = pgTable(
  "invoices",
  {
    // id инвойса/контракта lava.top
    id: text("id").primaryKey(),
    ref: text("ref").notNull().unique(),
    email: text("email").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    subscriptionId: text("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    kind: text("kind").$type<InvoiceKind>().notNull().default("first"),
    status: text("status").notNull().default("new"),
    amount: text("amount"),
    currency: text("currency"),
    paymentUrl: text("payment_url"),
    raw: jsonb("raw"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("invoices_email_idx").on(t.email), index("invoices_user_idx").on(t.userId)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    bodySha256: text("body_sha256").notNull().unique(),
    eventType: text("event_type").notNull(),
    contractId: text("contract_id"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    error: text("error"),
    payload: jsonb("payload").notNull(),
  },
  (t) => [index("webhook_events_contract_idx").on(t.contractId)],
);

export const accessTokens = pgTable(
  "access_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("access_tokens_user_idx").on(t.userId)],
);

export type BoundIpKind = "static" | "ddns_host" | "ddns_push";

export const boundIps = pgTable(
  "bound_ips",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<BoundIpKind>().notNull().default("static"),
    ip: inet("ip"),
    hostname: text("hostname"),
    label: text("label").notNull().default(""),
    lastResolvedAt: ts("last_resolved_at"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("bound_ips_user_idx").on(t.userId), uniqueIndex("bound_ips_ip_uidx").on(t.ip)],
);

export const ddnsKeys = pgTable("ddns_keys", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastUsedAt: ts("last_used_at"),
});

export const userPolicy = pgTable("user_policy", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  disabledCategories: text("disabled_categories").array().notNull().default([]),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const tokenActivity = pgTable(
  "token_activity",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    ipHash: text("ip_hash").notNull(),
    firstSeen: ts("first_seen").notNull(),
    lastSeen: ts("last_seen").notNull(),
    queries: integer("queries").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day, t.ipHash] })],
);

export const aclDynamic = pgTable(
  "acl_dynamic",
  {
    ip: inet("ip").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("acl_dynamic_expires_idx").on(t.expiresAt)],
);

export type NodeKind = "pro_dns" | "pro_worker" | "dedicated";

export const nodes = pgTable("nodes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  kind: text("kind").$type<NodeKind>().notNull(),
  name: text("name").notNull().unique(),
  ip: text("ip"),
  secretHash: text("secret_hash").notNull(),
  tenantUserId: text("tenant_user_id").references(() => users.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(true),
  lastSeenAt: ts("last_seen_at"),
  lastHealth: jsonb("last_health"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const mailOutbox = pgTable(
  "mail_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    html: text("html"),
    replyTo: text("reply_to"),
    createdAt: ts("created_at").notNull().defaultNow(),
    sentAt: ts("sent_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
  },
  (t) => [index("mail_outbox_pending_idx").on(t.sentAt, t.nextAttemptAt)],
);

export const leads = pgTable("leads", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  createdAt: ts("created_at").notNull().defaultNow(),
  email: text("email").notNull(),
  plan: text("plan").notNull(),
  scenario: text("scenario").notNull(),
  desiredServices: text("desired_services").array().notNull().default([]),
  contact: text("contact").notNull().default(""),
  page: text("page").notNull().default(""),
  ipHash: text("ip_hash").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
});

export const auditLog = pgTable("audit_log", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  at: ts("at").notNull().defaultNow(),
  userId: text("user_id"),
  action: text("action").notNull(),
  details: jsonb("details"),
});
