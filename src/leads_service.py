#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сервис приёма заявок на платные тарифы «Перевал Pro» и «Перевал Dedicated».

Слушает 127.0.0.1:8054 за nginx (location = /api/leads), валидирует входные
данные через Pydantic, сохраняет каждую заявку отдельной строкой JSON Lines
в /var/lib/pereval-leads/leads.jsonl и в фоновом режиме (FastAPI BackgroundTasks)
отправляет через SMTP:
  1) письмо-подтверждение пользователю от Port Buddy <no-reply@portbuddy.dev>
  2) уведомление администратору на admin@portbuddy.dev с Reply-To клиента.
"""

import argparse
import hashlib
import html
import json
import logging
import os
import re
import smtplib
import ssl
import threading
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("pereval-leads")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")

PLAN_TITLES = {
    "pro": "Перевал Pro (Расширенная индивидуальная подписка)",
    "dedicated": "Перевал Dedicated (Выделенный DNS-прокси сервер)",
}

SCENARIO_TITLES = {
    "personal": "Для себя (индивидуально, до 5 устройств)",
    "family": "Для всей семьи / на домашний роутер и Smart TV",
    "team_small": "Для команды или стартапа (до 20 человек)",
    "team_corp": "Для компании (20+ сотрудников, корпоративный контур)",
}

RATE_LIMIT_WINDOW_SEC = 15 * 60
RATE_LIMIT_MAX_REQUESTS = 5
EMAIL_COOLDOWN_SEC = 10 * 60


class LeadRequest(BaseModel):
    email: str = Field(default="")
    plan: str = Field(default="")
    scenario: str = Field(default="personal")
    desired_services: Union[List[str], str, None] = Field(default_factory=list)
    contact: Optional[str] = Field(default="")
    page: Optional[str] = Field(default="")
    website: Optional[str] = Field(default="")

    @field_validator("email", mode="before")
    @classmethod
    def validate_email(cls, v: Any) -> str:
        if not isinstance(v, str):
            raise ValueError("Укажите корректный адрес электронной почты.")
        cleaned = v.strip().lower()
        if not cleaned or len(cleaned) > 254 or not EMAIL_RE.match(cleaned):
            raise ValueError("Пожалуйста, укажите корректный адрес электронной почты.")
        return cleaned

    @field_validator("plan", mode="before")
    @classmethod
    def validate_plan(cls, v: Any) -> str:
        if not isinstance(v, str):
            raise ValueError("Выберите тариф (pro или dedicated).")
        cleaned = v.strip().lower()
        if cleaned not in PLAN_TITLES:
            raise ValueError("Неизвестный тариф. Допустимые значения: pro, dedicated.")
        return cleaned

    @field_validator("scenario", mode="before")
    @classmethod
    def validate_scenario(cls, v: Any) -> str:
        if not isinstance(v, str) or not v.strip():
            return "personal"
        cleaned = v.strip().lower()
        return cleaned if cleaned in SCENARIO_TITLES else "personal"

    @field_validator("desired_services", mode="before")
    @classmethod
    def validate_services(cls, v: Any) -> List[str]:
        if v is None:
            return []
        items: List[str] = []
        if isinstance(v, str):
            raw_parts = [p.strip() for p in v.split(",")]
            items = [p for p in raw_parts if p]
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, str):
                    s = item.strip()
                    if s:
                        items.append(s[:200])
        else:
            raise ValueError("Поле desired_services должно быть списком или строкой.")
        out: List[str] = []
        total_len = 0
        for item in items:
            if item not in out:
                if total_len + len(item) > 1000:
                    break
                out.append(item)
                total_len += len(item)
        return out

    @field_validator("contact", mode="before")
    @classmethod
    def validate_contact(cls, v: Any) -> str:
        if v is None:
            return ""
        return str(v).strip()[:200]

    @field_validator("page", mode="before")
    @classmethod
    def validate_page(cls, v: Any) -> str:
        if v is None:
            return ""
        return str(v).strip()[:100]

    @field_validator("website", mode="before")
    @classmethod
    def validate_website(cls, v: Any) -> str:
        if v is None:
            return ""
        return str(v).strip()[:200]


class LeadsState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.next_id: Optional[int] = None
        self.file_path_cached: Optional[Path] = None
        self.ip_hits: Dict[str, List[float]] = {}
        self.email_cooldowns: Dict[str, Dict[str, Any]] = {}

    def get_leads_file(self) -> Path:
        raw = os.environ.get("LEADS_FILE", "/var/lib/pereval-leads/leads.jsonl").strip()
        return Path(raw)

    def _ensure_counter_unlocked(self, path: Path) -> None:
        if self.next_id is not None and self.file_path_cached == path:
            return
        count = 0
        if path.is_file():
            try:
                with path.open("r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip():
                            count += 1
            except OSError as exc:
                logger.warning("Не удалось прочитать %s при подсчёте строк: %s", path, exc)
        self.next_id = count + 1
        self.file_path_cached = path

    def check_rate_limit(self, ip_hash: str, now: float) -> bool:
        with self.lock:
            cutoff = now - RATE_LIMIT_WINDOW_SEC
            hits = [t for t in self.ip_hits.get(ip_hash, []) if t > cutoff]
            if len(hits) >= RATE_LIMIT_MAX_REQUESTS:
                self.ip_hits[ip_hash] = hits
                return False
            hits.append(now)
            self.ip_hits[ip_hash] = hits
            return True

    def check_email_cooldown(self, email: str, plan: str, now: float) -> Optional[int]:
        key = f"{email}:{plan}"
        with self.lock:
            entry = self.email_cooldowns.get(key)
            if entry and (now - entry["ts"]) < EMAIL_COOLDOWN_SEC:
                return int(entry["id"])
            return None

    def append_lead(self, payload: Dict[str, Any], now: float) -> Dict[str, Any]:
        path = self.get_leads_file()
        with self.lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(path.parent, 0o700)
            except OSError:
                pass
            self._ensure_counter_unlocked(path)
            assert self.next_id is not None
            lead_id = self.next_id
            self.next_id += 1

            record = {
                "id": lead_id,
                "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "email": payload["email"],
                "plan": payload["plan"],
                "scenario": payload["scenario"],
                "desired_services": payload["desired_services"],
                "contact": payload["contact"],
                "page": payload["page"],
                "ip_hash": payload["ip_hash"],
                "user_agent": payload["user_agent"],
            }
            line = json.dumps(record, ensure_ascii=False) + "\n"
            fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass

            key = f"{record['email']}:{record['plan']}"
            self.email_cooldowns[key] = {"ts": now, "id": lead_id}
            return record


STATE = LeadsState()
app = FastAPI(title="Pereval Leads Service", docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    msg = "Проверьте правильность заполнения полей формы."
    for err in exc.errors():
        raw_msg = str(err.get("msg", ""))
        if raw_msg.startswith("Value error, "):
            raw_msg = raw_msg[len("Value error, "):]
        if raw_msg:
            msg = raw_msg
            break
    return JSONResponse(
        status_code=400,
        content={"ok": False, "detail": msg, "message": msg},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    msg = str(exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "detail": msg, "message": msg},
    )


def hash_client_ip(ip: str) -> str:
    day_bucket = int(time.time() // 86400)
    digest = hashlib.blake2b(f"pereval-leads:{day_bucket}:{ip}".encode("utf-8"), digest_size=8).hexdigest()
    return digest


def extract_client_ip(request: Request) -> str:
    xff = (request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for") or "").strip()
    if xff:
        return xff.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


def build_user_email(lead: Dict[str, Any], mail_from_header: str, admin_email: str) -> EmailMessage:
    plan_title = PLAN_TITLES.get(lead["plan"], lead["plan"])
    scenario_title = SCENARIO_TITLES.get(lead["scenario"], lead["scenario"])
    services_list = ", ".join(lead["desired_services"]) if lead["desired_services"] else "Базовый и расширенный каталог"

    msg = EmailMessage()
    msg["Subject"] = f"Заявка принята: ранний доступ к «{plan_title}»"
    msg["From"] = mail_from_header
    msg["To"] = lead["email"]
    msg["Reply-To"] = admin_email
    msg["Message-ID"] = make_msgid(domain="portbuddy.dev")

    text_body = (
        f"Здравствуйте!\n\n"
        f"Спасибо за интерес к развитию сервиса «Перевал» (https://pereval.portbuddy.tech).\n"
        f"Мы получили вашу заявку #{lead['id']} на ранний доступ:\n\n"
        f"• Выбранный тариф: {plan_title}\n"
        f"• Сценарий использования: {scenario_title}\n"
        f"• Отмеченные сервисы: {services_list}\n"
        + (f"• Контакт для связи: {lead['contact']}\n" if lead.get("contact") else "")
        + "\nКак только мы откроем доступ для вашей волны предзаказа, мы пришлём приглашение "
        "в личный Self-Service веб-кабинет на этот адрес электронной почты.\n\n"
        "Если у вас есть вопросы или вы хотите уточнить параметры подключения, просто ответьте на это письмо.\n\n"
        "— Команда Перевал & Port Buddy\n"
        "https://pereval.portbuddy.tech\n"
    )

    e = html.escape
    contact_row = (
        f"<tr><td style='padding:6px 0;color:#6b6b68;'>Контакт:</td>"
        f"<td style='padding:6px 0;font-weight:600;'>{e(lead['contact'])}</td></tr>"
        if lead.get("contact")
        else ""
    )
    html_body = f"""<!DOCTYPE html>
<html lang="ru">
<body style="margin:0;padding:24px;background:#fbfbfa;color:#1a1a19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;">
  <div style="max-width:580px;margin:0 auto;background:#ffffff;border:1px solid #e6e5e2;border-radius:12px;padding:28px;">
    <p style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#0b5cff;font-weight:600;">Перевал · Port Buddy</p>
    <h2 style="margin:0 0 14px;font-size:21px;line-height:1.3;">Ваша заявка на ранний доступ принята!</h2>
    <p style="margin:0 0 16px;color:#444;">Спасибо за интерес к развитию сервиса <strong>«Перевал»</strong>. Мы зафиксировали вашу заявку <code>#{lead['id']}</code> в списке раннего доступа:</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;background:#f4f4f2;border-radius:8px;padding:12px 16px;margin-bottom:18px;">
      <tr><td style="padding:8px 12px;color:#6b6b68;width:38%;">Тариф:</td><td style="padding:8px 12px;font-weight:600;">{e(plan_title)}</td></tr>
      <tr><td style="padding:8px 12px;color:#6b6b68;">Сценарий:</td><td style="padding:8px 12px;">{e(scenario_title)}</td></tr>
      <tr><td style="padding:8px 12px;color:#6b6b68;">Желаемые сервисы:</td><td style="padding:8px 12px;">{e(services_list)}</td></tr>
      {contact_row}
    </table>
    <p style="margin:0 0 14px;color:#444;">Как только мы подготовим инфраструктуру для вашей группы, мы отправим приглашение в личный веб-кабинет на этот email.</p>
    <p style="margin:0;font-size:13px;color:#6b6b68;">Если вы хотите уточнить детали или обсудить корпоративное подключение, просто ответьте на это письмо.</p>
  </div>
</body>
</html>"""

    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")
    return msg


def build_admin_email(lead: Dict[str, Any], mail_from_header: str, admin_email: str) -> EmailMessage:
    plan_title = PLAN_TITLES.get(lead["plan"], lead["plan"])
    scenario_title = SCENARIO_TITLES.get(lead["scenario"], lead["scenario"])
    services_list = ", ".join(lead["desired_services"]) if lead["desired_services"] else "(не указаны)"

    msg = EmailMessage()
    msg["Subject"] = f"[Перевал Lead #{lead['id']}] {lead['plan'].upper()} — {lead['email']}"
    msg["From"] = mail_from_header
    msg["To"] = admin_email
    msg["Reply-To"] = lead["email"]
    msg["Message-ID"] = make_msgid(domain="portbuddy.dev")

    text_body = (
        f"Новая заявка #{lead['id']} на сайте Перевал:\n\n"
        f"ID заявки: #{lead['id']}\n"
        f"Время (UTC): {lead['created_at']}\n"
        f"Email клиента: {lead['email']}\n"
        f"Тариф: {plan_title} ({lead['plan']})\n"
        f"Сценарий: {scenario_title} ({lead['scenario']})\n"
        f"Желаемые сервисы: {services_list}\n"
        f"Контакт / Telegram: {lead.get('contact') or '—'}\n"
        f"Страница: {lead.get('page') or '—'}\n"
        f"IP hash: {lead.get('ip_hash') or '—'}\n"
    )

    e = html.escape
    html_body = f"""<!DOCTYPE html>
<html lang="ru">
<body style="margin:0;padding:20px;background:#f4f4f2;color:#1a1a19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e6e5e2;border-radius:10px;padding:24px;">
    <h3 style="margin:0 0 14px;color:#0b5cff;">Новая заявка #{lead['id']} · {e(plan_title)}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#6b6b68;width:36%;">Email:</td><td style="padding:6px 0;font-weight:600;"><a href="mailto:{e(lead['email'])}">{e(lead['email'])}</a></td></tr>
      <tr><td style="padding:6px 0;color:#6b6b68;">Тариф:</td><td style="padding:6px 0;font-weight:600;">{e(plan_title)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b6b68;">Сценарий:</td><td style="padding:6px 0;">{e(scenario_title)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b6b68;">Желаемые сервисы:</td><td style="padding:6px 0;">{e(services_list)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b6b68;">Контакт / Telegram:</td><td style="padding:6px 0;">{e(lead.get('contact') or '—')}</td></tr>
      <tr><td style="padding:6px 0;color:#6b6b68;">Страница:</td><td style="padding:6px 0;"><code>{e(lead.get('page') or '—')}</code></td></tr>
      <tr><td style="padding:6px 0;color:#6b6b68;">Время (UTC):</td><td style="padding:6px 0;">{e(lead['created_at'])}</td></tr>
    </table>
  </div>
</body>
</html>"""

    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")
    return msg


def _deliver_smtp_messages(messages: List[EmailMessage]) -> None:
    smtp_host = os.environ.get("SMTP_HOST", "smtp-pulse.com").strip() or "smtp-pulse.com"
    smtp_port_raw = os.environ.get("SMTP_PORT", "2525").strip() or "2525"
    try:
        smtp_port = int(smtp_port_raw)
    except ValueError:
        smtp_port = 2525
    smtp_user = os.environ.get("SMTP_USERNAME", "").strip()
    smtp_pass = os.environ.get("SMTP_PASSWORD", "").strip()

    is_local_smtp = smtp_host in ("127.0.0.1", "localhost", "::1")
    if not is_local_smtp and (not smtp_user or not smtp_pass):
        logger.warning(
            "SMTP_USERNAME / SMTP_PASSWORD не заданы — пропуск отправки писем через %s:%d (заявка сохранена в файл)",
            smtp_host,
            smtp_port,
        )
        return

    last_err: Optional[Exception] = None
    for attempt in range(1, 3):
        try:
            if smtp_port == 465:
                context = ssl.create_default_context()
                with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=10, context=context) as server:
                    if smtp_user and smtp_pass:
                        server.login(smtp_user, smtp_pass)
                    for m in messages:
                        server.send_message(m)
            else:
                with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
                    server.ehlo()
                    if server.has_extn("starttls"):
                        context = ssl.create_default_context()
                        server.starttls(context=context)
                        server.ehlo()
                    if smtp_user and smtp_pass:
                        server.login(smtp_user, smtp_pass)
                    for m in messages:
                        server.send_message(m)
            logger.info("Успешно отправлено %d SMTP-сообщений через %s:%d", len(messages), smtp_host, smtp_port)
            return
        except Exception as exc:
            last_err = exc
            logger.warning("Ошибка отправки SMTP (попытка %d/2): %s", attempt, exc)
            if attempt == 1:
                time.sleep(1.0)
    if last_err is not None:
        logger.error("Не удалось отправить письма по SMTP после 2 попыток: %s", last_err)


def send_lead_notifications(lead: Dict[str, Any]) -> None:
    mail_from = os.environ.get("MAIL_FROM", "no-reply@portbuddy.dev").strip() or "no-reply@portbuddy.dev"
    mail_from_name = os.environ.get("MAIL_FROM_NAME", "Port Buddy").strip() or "Port Buddy"
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@portbuddy.dev").strip() or "admin@portbuddy.dev"
    mail_from_header = formataddr((mail_from_name, mail_from))

    user_msg = build_user_email(lead, mail_from_header, admin_email)
    admin_msg = build_admin_email(lead, mail_from_header, admin_email)
    _deliver_smtp_messages([user_msg, admin_msg])


@app.get("/api/leads/healthz")
@app.get("/healthz")
async def healthz() -> Dict[str, Any]:
    return {"ok": True, "service": "pereval-leads"}


@app.post("/api/leads")
async def create_lead(req: LeadRequest, request: Request, background_tasks: BackgroundTasks) -> Dict[str, Any]:
    # 1. Honeypot: если спам-бот заполнил скрытое поле website — тихо возвращаем 200 OK
    if req.website:
        logger.info("Сработал honeypot для заявки %s", req.email)
        return {
            "ok": True,
            "id": 0,
            "message": "Заявка принята! Мы отправили письмо с подтверждением на ваш email.",
        }

    now = time.time()
    client_ip = extract_client_ip(request)
    ip_hash = hash_client_ip(client_ip)

    # 2. Кулдаун на повторную отправку того же (email, plan)
    existing_id = STATE.check_email_cooldown(req.email, req.plan, now)
    if existing_id is not None:
        logger.info("Повторная отправка для %s (%s) в пределах кулдауна (id=%d)", req.email, req.plan, existing_id)
        return {
            "ok": True,
            "id": existing_id,
            "cooldown": True,
            "message": "Ваша заявка уже принята! Проверьте папку «Входящие» или «Спам» — письмо с подтверждением уже отправлено.",
        }

    # 3. Rate-limit по IP
    if not STATE.check_rate_limit(ip_hash, now):
        raise HTTPException(
            status_code=429,
            detail="Слишком много запросов с вашего адреса. Пожалуйста, подождите несколько минут и попробуйте снова.",
        )

    user_agent = (request.headers.get("user-agent") or "").strip()[:300]
    record = STATE.append_lead(
        {
            "email": req.email,
            "plan": req.plan,
            "scenario": req.scenario,
            "desired_services": req.desired_services,
            "contact": req.contact,
            "page": req.page,
            "ip_hash": ip_hash,
            "user_agent": user_agent,
        },
        now=now,
    )
    logger.info("Сохранена заявка #%d: email=%s plan=%s scenario=%s", record["id"], record["email"], record["plan"], record["scenario"])

    background_tasks.add_task(send_lead_notifications, record)

    return {
        "ok": True,
        "id": record["id"],
        "message": "Заявка принята! Мы отправили письмо с подтверждением на ваш email.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Pereval Leads FastAPI Service")
    parser.add_argument("--host", default=os.environ.get("LEADS_BIND_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("LEADS_BIND_PORT", "8054")))
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
