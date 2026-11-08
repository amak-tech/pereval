"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { track } from "@/components/track";

type Scenario = "personal" | "family" | "team_small" | "team_corp";
type Status = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; message: string } | { kind: "error"; message: string };

const SCENARIOS: { value: Scenario; label: string }[] = [
  { value: "family", label: "Для всей семьи / на домашний роутер, Smart TV и мобильные устройства" },
  { value: "team_small", label: "Для команды или стартапа (до 20 сотрудников)" },
  { value: "team_corp", label: "Для компании (20+ сотрудников, офисная сеть / корпоративный VPN)" },
  { value: "personal", label: "Для себя (нужен личный выделенный IP и свои домены)" },
];

const SERVICES: { value: string; checked?: boolean }[] = [
  { value: "Spotify / Deezer", checked: true },
  { value: "Netflix / Twitch 1080p", checked: true },
  { value: "TikTok (актуальная лента)" },
  { value: "Reddit / Pinterest" },
  { value: "Canva", checked: true },
  { value: "Notion / Miro / Trello", checked: true },
  { value: "Supercell (Brawl Stars / Clash)" },
  { value: "Xbox / PlayStation / GeForce NOW" },
  { value: "ElevenLabs / Suno" },
  { value: "Coursera / Quizlet / Duolingo" },
];

/** Заявка на Dedicated → POST /api/leads (plan всегда "dedicated", поле website — honeypot). */
export function LeadForm({ name }: { name: string }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [scenario, setScenario] = useState<Scenario>("family");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(SERVICES.filter((s) => s.checked).map((s) => s.value)));
  const [custom, setCustom] = useState("");
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "busy";

  function toggle(v: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
      setStatus({ kind: "error", message: "Пожалуйста, укажите корректный адрес электронной почты." });
      return;
    }
    const desired = [...picked];
    if (custom.trim()) desired.push(custom.trim().slice(0, 500));
    setStatus({ kind: "busy" });
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: trimmed, plan: "dedicated", scenario, desired_services: desired, contact: contact.trim(), page: "/dedicated", website }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; cooldown?: boolean; message?: string };
      if (res.ok && data.ok) {
        setStatus({ kind: "ok", message: data.message || "Заявка принята! Мы отправили письмо с подтверждением на ваш email." });
        if (!data.cooldown) {
          track("lead_submit", { plan: "dedicated", scenario, page: "/dedicated" });
          setEmail("");
          setCustom("");
          setContact("");
        }
        return;
      }
      setStatus({
        kind: "error",
        message: data.message || (res.status === 429 ? "Слишком много заявок. Попробуйте позже." : res.status === 400 ? "Проверьте правильность заполнения полей формы." : "Не удалось отправить заявку. Пожалуйста, попробуйте чуть позже."),
      });
    } catch {
      setStatus({ kind: "error", message: "Ошибка соединения с сервером. Проверьте подключение и попробуйте ещё раз." });
    }
  }

  const input = "mt-2 w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-[15px] text-ink placeholder:text-mute focus:border-accent disabled:opacity-60";

  return (
    <form onSubmit={onSubmit} noValidate className="card relative grid gap-5">
      <div>
        <label htmlFor={`${id}-email`} className="block text-sm font-semibold">
          Ваш рабочий или личный email <span className="text-accent">*</span>
        </label>
        <p className="m-0 mt-1 text-sm text-mute">Сразу отправим письмо с подтверждением заявки и деталями запуска.</p>
        <input id={`${id}-email`} type="email" name="email" required autoComplete="email" inputMode="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} className={input} />
      </div>

      <div>
        <label htmlFor={`${id}-scenario`} className="block text-sm font-semibold">
          Сценарий и масштаб использования
        </label>
        <select id={`${id}-scenario`} name="scenario" value={scenario} onChange={(e) => setScenario(e.target.value as Scenario)} disabled={busy} className={input}>
          {SCENARIOS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="m-0 border-0 p-0">
        <legend className="text-sm font-semibold">Какие сервисы и стриминги нужны вашей семье или команде?</legend>
        <p className="m-0 mt-1 text-sm text-mute">Отметьте нужные платформы из расширенного каталога:</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SERVICES.map((s) => {
            const on = picked.has(s.value);
            return (
              <label key={s.value} className={`cursor-pointer select-none rounded-full border px-3 py-1.5 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${on ? "border-accent bg-accent-soft text-accent font-semibold" : "border-line bg-bg text-mute hover:text-ink"}`}>
                <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(s.value)} disabled={busy} />
                {s.value}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div>
        <label htmlFor={`${id}-custom`} className="block text-sm font-semibold">
          Какие собственные домены или сайты вы хотели бы добавить?
        </label>
        <input id={`${id}-custom`} type="text" name="custom_services" maxLength={500} placeholder="Например: tidal.com, imgur.com, свои рабочие или домашние сервисы" value={custom} onChange={(e) => setCustom(e.target.value)} disabled={busy} className={input} />
      </div>

      <div>
        <label htmlFor={`${id}-contact`} className="block text-sm font-semibold">
          Имя или Telegram для обсуждения деталей и выдачи тестового сервера <span className="font-normal text-mute">(необязательно)</span>
        </label>
        <input id={`${id}-contact`} type="text" name="contact" maxLength={200} placeholder="@username или имя" autoComplete="name" value={contact} onChange={(e) => setContact(e.target.value)} disabled={busy} className={input} />
      </div>

      {/* Honeypot: скрыт от людей и ассистивных технологий, боты заполняют */}
      <div className="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor={`${id}-website`}>Веб-сайт (не заполняйте это поле)</label>
        <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button type="submit" disabled={busy} className="btn-primary disabled:opacity-60">
          {busy ? <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          {busy ? "Отправляем заявку…" : `Оставить заявку на ${name} Dedicated`}
        </button>
        <p className="m-0 text-xs text-mute">
          Отправляя форму, вы соглашаетесь на получение письма с подтверждением заявки в соответствии с <Link href="/privacy">Политикой конфиденциальности</Link>.
        </p>
      </div>

      {status.kind === "ok" ? (
        <p role="status" className="m-0 rounded-lg bg-ok-bg px-4 py-3 text-sm text-ok">
          {status.message}
        </p>
      ) : status.kind === "error" ? (
        <p role="alert" className="m-0 rounded-lg bg-err-bg px-4 py-3 text-sm text-err">
          {status.message}
        </p>
      ) : null}
    </form>
  );
}
