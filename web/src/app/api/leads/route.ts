import { assertSameOrigin, handle, json, readJson } from "@/lib/http";
import { clientIp } from "@/lib/ip";
import { leadSchema, submitLead } from "@/lib/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    assertSameOrigin(req);
    const input = await readJson(req, leadSchema);
    const outcome = await submitLead(input, clientIp(req.headers), req.headers.get("user-agent") ?? "");
    switch (outcome.kind) {
      case "honeypot":
        return json({ ok: true, id: 0, message: "Заявка принята! Мы отправили письмо с подтверждением на ваш email." });
      case "cooldown":
        return json({ ok: true, cooldown: true, message: `Заявка с этим email уже принята. Повторить можно через ${Math.ceil(outcome.seconds / 60)} мин.` });
      case "rate_limited":
        return json({ ok: false, error: "rate_limited", message: "Слишком много заявок. Попробуйте позже." }, { status: 429 });
      case "created":
        return json({ ok: true, id: outcome.id, message: "Заявка принята! Мы отправили письмо с подтверждением на ваш email." });
    }
  });
}

export async function GET() {
  return json({ ok: true });
}
