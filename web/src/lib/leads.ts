import { z } from "zod";
import { db, schema } from "@/lib/db/client";
import { emailSchema } from "@/lib/http";
import { allow, cooldownLeft, touch } from "@/lib/ratelimit";
import { enqueueAdminMail, enqueueMail } from "@/lib/mail";
import { adminLeadMail, leadUserMail } from "@/lib/mail-templates";
import { hashIpDaily } from "@/lib/crypto";
import { env } from "@/lib/env";

/** Заявки на Dedicated (и, на всякий случай, Pro) — поведение перенесено из leads_service.py. */

export const PLAN_TITLES: Record<string, string> = {
  pro: "Перевал Pro",
  dedicated: "Перевал Dedicated",
};

export const SCENARIO_TITLES: Record<string, string> = {
  personal: "Для себя (до 5 устройств)",
  family: "Для всей семьи / роутер / Smart TV",
  team_small: "Для команды или стартапа (до 20 человек)",
  team_corp: "Для компании (20+ сотрудников)",
};

export const leadSchema = z.object({
  email: emailSchema,
  plan: z.enum(["pro", "dedicated"]),
  scenario: z.enum(["personal", "family", "team_small", "team_corp"]).default("personal"),
  desired_services: z
    .union([z.array(z.string()), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,;]+/) : [];
      const seen = new Set<string>();
      const out: string[] = [];
      let total = 0;
      for (const raw of list) {
        const s = raw.trim().slice(0, 200);
        if (!s || seen.has(s.toLowerCase())) continue;
        if (total + s.length > 1000) break;
        seen.add(s.toLowerCase());
        out.push(s);
        total += s.length;
      }
      return out;
    }),
  contact: z.string().trim().max(200).default(""),
  page: z.string().trim().max(100).default(""),
  website: z.string().trim().max(200).default(""), // honeypot
});

export type LeadInput = z.infer<typeof leadSchema>;

export const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
export const RATE_LIMIT_MAX = 5;
export const EMAIL_COOLDOWN_MS = 10 * 60_000;

export type LeadOutcome =
  | { kind: "honeypot" }
  | { kind: "cooldown"; seconds: number }
  | { kind: "rate_limited" }
  | { kind: "created"; id: string };

export async function submitLead(input: LeadInput, ip: string, userAgent: string): Promise<LeadOutcome> {
  if (input.website) return { kind: "honeypot" };
  const cdKey = `lead:${input.email}:${input.plan}`;
  const left = cooldownLeft(cdKey, EMAIL_COOLDOWN_MS);
  if (left > 0) return { kind: "cooldown", seconds: left };
  const ipHash = hashIpDaily(ip, "pereval-leads");
  if (!allow(`lead-ip:${ipHash}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) return { kind: "rate_limited" };
  touch(cdKey);
  const [row] = await db()
    .insert(schema.leads)
    .values({
      email: input.email,
      plan: input.plan,
      scenario: input.scenario,
      desiredServices: input.desired_services,
      contact: input.contact,
      page: input.page,
      ipHash,
      userAgent: userAgent.slice(0, 300),
    })
    .returning({ id: schema.leads.id });
  const planTitle = PLAN_TITLES[input.plan] ?? input.plan;
  const userTpl = leadUserMail(planTitle);
  await enqueueMail({ to: input.email, subject: userTpl.subject, text: userTpl.text, html: userTpl.html, replyTo: env().ADMIN_EMAIL });
  const adminTpl = adminLeadMail({
    email: input.email,
    plan: planTitle,
    scenario: SCENARIO_TITLES[input.scenario] ?? input.scenario,
    desiredServices: input.desired_services,
    contact: input.contact,
    page: input.page,
  });
  await enqueueAdminMail(adminTpl.subject, adminTpl.text, adminTpl.html, input.email);
  return { kind: "created", id: row?.id ?? "" };
}
