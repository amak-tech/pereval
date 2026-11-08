import { env } from "@/lib/env";

/** Текстовые и HTML-шаблоны писем. Всё на русском; без внешних картинок и трекеров. */

type Tpl = { subject: string; text: string; html: string };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function layout(title: string, bodyHtml: string, footerNote?: string): string {
  const origin = env().PUBLIC_ORIGIN;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;color:#1a1a19;">
<div style="max-width:560px;margin:0 auto;padding:28px 16px;">
  <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#6b6b68;margin-bottom:14px;">Перевал · <a href="${origin}" style="color:#6b6b68;">${esc(origin.replace(/^https?:\/\//, ""))}</a></div>
  <div style="background:#fff;border:1px solid #e6e5e2;border-radius:12px;padding:24px 22px;">
    <h1 style="font-size:20px;line-height:1.3;margin:0 0 14px;">${esc(title)}</h1>
    ${bodyHtml}
  </div>
  <p style="font-size:12px;color:#6b6b68;line-height:1.5;margin-top:16px;">${footerNote ? esc(footerNote) : "Это письмо отправлено автоматически. Если вы ничего не запрашивали, просто проигнорируйте его."}</p>
</div></body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:18px 0;"><a href="${esc(href)}" style="display:inline-block;background:#0b5cff;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:9px;">${esc(label)}</a></p>
<p style="font-size:13px;color:#6b6b68;word-break:break-all;">Если кнопка не работает, откройте ссылку: ${esc(href)}</p>`;
}

export function magicLinkMail(url: string): Tpl {
  return {
    subject: "Вход в кабинет Перевала",
    text: `Чтобы войти в личный кабинет Перевала, откройте ссылку (действует 15 минут, один раз):\n\n${url}\n\nЕсли вы не запрашивали вход, просто проигнорируйте письмо.`,
    html: layout(
      "Вход в кабинет Перевала",
      `<p>Нажмите кнопку, чтобы войти. Ссылка действует 15 минут и срабатывает один раз.</p>${button(url, "Войти в кабинет")}`,
    ),
  };
}

export function onboardingMail(url: string, accessUntil: Date | null): Tpl {
  const until = accessUntil ? fmtDate(accessUntil) : "—";
  return {
    subject: "Оплата прошла — Перевал Pro активирован",
    text: `Спасибо! Подписка Перевал Pro активна до ${until}.\n\nВойдите в кабинет, чтобы получить персональные настройки DNS для телефона, компьютера и роутера:\n${url}\n\nСсылка действует 72 часа. Позже можно войти через Google или запросить новую ссылку на этот же email на ${env().PUBLIC_ORIGIN}/account/login.`,
    html: layout(
      "Оплата прошла — Перевал Pro активирован",
      `<p>Спасибо! Подписка <b>Перевал Pro</b> активна до <b>${esc(until)}</b>.</p>
<p>В кабинете вас ждут готовые настройки: профиль для iPhone/Mac, адрес для Android, DoH для Windows и браузеров, привязка IP для роутера.</p>
${button(url, "Открыть кабинет")}
<p style="font-size:13px;color:#6b6b68;">Ссылка действует 72 часа. Позже входите через Google с этим же email или запросите новую ссылку на странице входа.</p>`,
    ),
  };
}

export function renewedMail(accessUntil: Date | null): Tpl {
  const until = accessUntil ? fmtDate(accessUntil) : "—";
  return {
    subject: "Перевал Pro продлён",
    text: `Списание за следующий месяц прошло успешно. Подписка активна до ${until}.\nУправлять подпиской: ${env().PUBLIC_ORIGIN}/account`,
    html: layout(
      "Перевал Pro продлён",
      `<p>Списание за следующий месяц прошло успешно. Подписка активна до <b>${esc(until)}</b>.</p>${button(`${env().PUBLIC_ORIGIN}/account`, "Открыть кабинет")}`,
    ),
  };
}

export function pastDueMail(accessUntil: Date | null): Tpl {
  const until = accessUntil ? fmtDate(accessUntil) : "—";
  return {
    subject: "Не удалось продлить Перевал Pro",
    text: `Платёжная система не смогла списать оплату за следующий месяц. Доступ сохранится до ${until}, после чего DNS продолжит работать, но без доступа к закрытым сервисам.\nПроверьте карту или оформите подписку заново: ${env().PUBLIC_ORIGIN}/account`,
    html: layout(
      "Не удалось продлить Перевал Pro",
      `<p>Платёжная система не смогла списать оплату за следующий месяц. Доступ сохранится до <b>${esc(until)}</b>, после чего DNS продолжит работать, но без доступа к закрытым сервисам.</p>${button(`${env().PUBLIC_ORIGIN}/account`, "Проверить подписку")}`,
    ),
  };
}

export function cancelledMail(accessUntil: Date | null): Tpl {
  const until = accessUntil ? fmtDate(accessUntil) : "—";
  return {
    subject: "Подписка Перевал Pro отменена",
    text: `Автопродление отключено. Доступ к сервисам Pro сохранится до ${until}. Возобновить можно в любой момент: ${env().PUBLIC_ORIGIN}/account`,
    html: layout(
      "Подписка Перевал Pro отменена",
      `<p>Автопродление отключено. Доступ к сервисам Pro сохранится до <b>${esc(until)}</b>.</p>${button(`${env().PUBLIC_ORIGIN}/account`, "Возобновить подписку")}`,
    ),
  };
}

export function expiredMail(): Tpl {
  return {
    subject: "Перевал Pro: период закончился",
    text: `Оплаченный период закончился. Ваши DNS-настройки продолжают работать как обычный резолвер, но закрытые сервисы больше не проксируются. Продлить: ${env().PUBLIC_ORIGIN}/account`,
    html: layout(
      "Период подписки закончился",
      `<p>Оплаченный период закончился. Ваши DNS-настройки продолжают работать как обычный резолвер, но закрытые сервисы больше не проксируются.</p>${button(`${env().PUBLIC_ORIGIN}/account`, "Продлить подписку")}`,
    ),
  };
}

export function expiringSoonMail(accessUntil: Date): Tpl {
  return {
    subject: `Перевал Pro заканчивается ${fmtDate(accessUntil)}`,
    text: `Подписка отменена и закончится ${fmtDate(accessUntil)}. Если хотите продолжить — возобновите её в кабинете: ${env().PUBLIC_ORIGIN}/account`,
    html: layout(
      "Подписка скоро закончится",
      `<p>Подписка отменена и закончится <b>${esc(fmtDate(accessUntil))}</b>.</p>${button(`${env().PUBLIC_ORIGIN}/account`, "Возобновить")}`,
    ),
  };
}

export function ddnsFailingMail(hostname: string, error: string): Tpl {
  return {
    subject: "DDNS-имя не резолвится уже сутки",
    text: `Имя ${hostname}, привязанное в кабинете Перевала, не удаётся разрешить больше 24 часов (${error}). Проверьте настройки DDNS на роутере или привяжите IP вручную: ${env().PUBLIC_ORIGIN}/account`,
    html: layout(
      "DDNS-имя не резолвится",
      `<p>Имя <code>${esc(hostname)}</code>, привязанное в кабинете, не удаётся разрешить больше 24 часов (<i>${esc(error)}</i>).</p>${button(`${env().PUBLIC_ORIGIN}/account`, "Проверить привязки")}`,
    ),
  };
}

export function leadUserMail(planTitle: string): Tpl {
  return {
    subject: `Заявка на ${planTitle} принята`,
    text: `Спасибо! Мы получили вашу заявку на ${planTitle} и свяжемся с вами, как только будем готовы выдать доступ. Вопросы — ответом на это письмо.`,
    html: layout(
      "Заявка принята",
      `<p>Спасибо! Мы получили вашу заявку на <b>${esc(planTitle)}</b> и свяжемся с вами, как только будем готовы выдать доступ.</p><p>Вопросы можно задать ответом на это письмо.</p>`,
    ),
  };
}

export function adminLeadMail(lead: { email: string; plan: string; scenario: string; desiredServices: string[]; contact: string; page: string }): Tpl {
  const lines = [
    `Email: ${lead.email}`,
    `План: ${lead.plan}`,
    `Сценарий: ${lead.scenario}`,
    `Сервисы: ${lead.desiredServices.join(", ") || "—"}`,
    `Контакт: ${lead.contact || "—"}`,
    `Страница: ${lead.page || "—"}`,
  ];
  return {
    subject: `[Перевал] Новая заявка: ${lead.plan} — ${lead.email}`,
    text: lines.join("\n"),
    html: layout("Новая заявка", `<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,Menlo,monospace;">${esc(lines.join("\n"))}</pre>`, "Reply-To указывает на email клиента."),
  };
}

export function adminPaymentMail(p: {
  ok: boolean;
  title: string;
  email: string;
  amount: string;
  currency: string;
  eventType: string;
  contractId: string;
  parentContractId?: string | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  errorMessage?: string | null;
  note?: string;
}): Tpl {
  const icon = p.ok ? "✅" : "❌";
  const lines = [
    `Событие: ${p.eventType}`,
    `Пользователь: ${p.email}`,
    `Сумма: ${p.amount} ${p.currency}`,
    `contractId: ${p.contractId}`,
    `parentContractId: ${p.parentContractId ?? "—"}`,
    `Статус подписки: ${p.statusBefore ?? "—"} → ${p.statusAfter ?? "—"}`,
    p.errorMessage ? `Ошибка: ${p.errorMessage}` : "",
    p.note ? `Примечание: ${p.note}` : "",
    `Инвойсы lava.top: https://app.lava.top/`,
  ].filter(Boolean);
  return {
    subject: `[Перевал] ${icon} ${p.title} ${p.amount} ${p.currency} — ${p.email}`,
    text: lines.join("\n"),
    html: layout(`${icon} ${p.title}`, `<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,Menlo,monospace;">${esc(lines.join("\n"))}</pre>`, "Уведомление администратору."),
  };
}

export function adminAlertMail(title: string, body: string): Tpl {
  return {
    subject: `[Перевал] ⚠️ ${title}`,
    text: body,
    html: layout(`⚠️ ${title}`, `<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,Menlo,monospace;">${esc(body)}</pre>`, "Уведомление администратору."),
  };
}

export function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" }).format(d);
}
