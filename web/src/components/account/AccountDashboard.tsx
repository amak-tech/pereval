"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Apple, Globe, Monitor, RefreshCw, Router, Smartphone } from "lucide-react";
import { CopyField } from "@/components/CopyButton";
import { Badge } from "@/components/Section";
import type { AccountSummary } from "@/lib/account";

type Summary = AccountSummary;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; message?: string };
  if (!res.ok || data.ok === false) throw new Error(data.message || `Ошибка ${res.status}`);
  return data;
}

function fmt(d: string | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(d));
}

const STATUS_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "mute" | "accent" }> = {
  active: { text: "Активна", tone: "ok" },
  past_due: { text: "Проблема с оплатой", tone: "warn" },
  cancelled: { text: "Отменена", tone: "mute" },
  expired: { text: "Истекла", tone: "mute" },
  pending: { text: "Ожидает оплаты", tone: "mute" },
};

export function AccountDashboard() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      api<Summary>("/api/account/me")
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    const p = reload();
    return () => {
      void p;
    };
  }, [reload]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="mt-6 rounded-xl border border-err bg-err-bg px-4 py-3 text-err">{error}</div>;
  if (!data) return <p className="mt-6 text-mute">Загружаем кабинет…</p>;

  const st = data.subscription;
  const label = STATUS_LABEL[st.status ?? ""] ?? { text: "Нет подписки", tone: "mute" as const };
  const proxyOn = st.mode === "proxy";

  return (
    <div className="mt-6 grid gap-6">
      {notice ? (
        <div className="rounded-xl border border-warn bg-warn-bg px-4 py-3 text-warn" role="status">
          {notice}
        </div>
      ) : null}

      {/* Подписка */}
      <section className="card" aria-labelledby="sub-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="sub-h" className="m-0 text-lg font-semibold">
            Подписка
          </h2>
          <Badge tone={label.tone}>{label.text}</Badge>
        </div>
        <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-3 border-b border-line py-1.5 sm:border-0">
            <dt className="text-mute">Доступ к сервисам Pro</dt>
            <dd className="m-0 font-semibold">{proxyOn ? `до ${fmt(st.accessUntil)}` : "неактивен"}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line py-1.5 sm:border-0">
            <dt className="text-mute">Следующее списание</dt>
            <dd className="m-0 font-semibold">{st.status === "active" ? fmt(st.periodEnd) : "—"}</dd>
          </div>
          <div className="flex justify-between gap-3 py-1.5">
            <dt className="text-mute">Валюта</dt>
            <dd className="m-0 font-semibold">{st.currency ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-3 py-1.5">
            <dt className="text-mute">Режим DNS</dt>
            <dd className="m-0 font-semibold">{proxyOn ? "Pro: сервисы проксируются" : st.mode === "plain" ? "Обычный резолвер (без Pro)" : "Отключён"}</dd>
          </div>
        </dl>
        {st.status === "past_due" ? (
          <p className="note mt-4">
            <AlertTriangle className="mr-1 inline h-4 w-4" aria-hidden /> Не удалось списать оплату. Доступ сохраняется до {fmt(st.accessUntil)}. Проверьте карту —
            lava.top повторит попытку, либо оформите подписку заново ниже.
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-3">
          {st.canCancel ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy === "cancel"}
              onClick={() =>
                window.confirm("Отключить автопродление? Доступ сохранится до конца оплаченного периода.") &&
                run("cancel", () => api("/api/account/subscription/cancel", { method: "POST" }))
              }
            >
              Отменить подписку
            </button>
          ) : null}
          {st.canRenew ? (
            <>
              <button
                type="button"
                className="btn-primary"
                disabled={busy === "renew"}
                onClick={() =>
                  run("renew", async () => {
                    const r = await api<{ paymentUrl: string }>("/api/account/subscription/renew", { method: "POST", body: JSON.stringify({ currency: "RUB" }) });
                    window.location.assign(r.paymentUrl);
                  })
                }
              >
                Оплатить в рублях
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy === "renew"}
                onClick={() =>
                  run("renew", async () => {
                    const r = await api<{ paymentUrl: string }>("/api/account/subscription/renew", { method: "POST", body: JSON.stringify({ currency: "USD" }) });
                    window.location.assign(r.paymentUrl);
                  })
                }
              >
                Оплатить в долларах
              </button>
            </>
          ) : null}
          <Link href="/pro" className="btn-secondary">
            Что входит в Pro
          </Link>
        </div>
      </section>

      {/* Настройка устройств */}
      {data.token ? <DevicesCard data={data} /> : (
        <section className="card">
          <h2 className="m-0 text-lg font-semibold">Настройка устройств</h2>
          <p className="mt-2 text-mute">Персональные адреса появятся после первой оплаты.</p>
        </section>
      )}

      {/* IP и DDNS */}
      <BoundIpsCard data={data} busy={busy} run={run} />

      {/* Категории */}
      <section className="card" aria-labelledby="cat-h">
        <h2 id="cat-h" className="m-0 text-lg font-semibold">
          Категории сервисов
        </h2>
        <p className="mt-1 text-sm text-mute">Снимите галочку, чтобы категория резолвилась напрямую, минуя прокси. Изменения применяются за секунды.</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {data.categories.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-bg px-3 py-2.5">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[var(--accent)]"
                checked={c.enabled}
                disabled={busy === "cat"}
                onChange={(e) => {
                  const disabled = data.categories.filter((x) => (x.id === c.id ? !e.target.checked : !x.enabled)).map((x) => x.id);
                  void run("cat", () => api("/api/account/categories", { method: "PUT", body: JSON.stringify({ disabled }) }));
                }}
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{c.name}</span>
                <span className="block text-xs text-mute">
                  {c.serviceCount} сервисов · {c.tier === "pro" ? "Pro" : "Free"} · пул {c.pool}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* Активность и безопасность */}
      <section className="card" aria-labelledby="act-h">
        <h2 id="act-h" className="m-0 text-lg font-semibold">
          Активность и безопасность
        </h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          <div className="rounded-lg border border-line bg-bg px-3 py-2">
            <dt className="text-xs text-mute">Устройств за 24 ч</dt>
            <dd className="m-0 text-xl font-semibold">{data.activity.devices24h}</dd>
          </div>
          <div className="rounded-lg border border-line bg-bg px-3 py-2">
            <dt className="text-xs text-mute">DNS-запросов за 24 ч</dt>
            <dd className="m-0 text-xl font-semibold">{data.activity.queries24h.toLocaleString("ru-RU")}</dd>
          </div>
          <div className="rounded-lg border border-line bg-bg px-3 py-2">
            <dt className="text-xs text-mute">Последний запрос</dt>
            <dd className="m-0 text-sm font-semibold">{data.activity.lastSeen ? new Date(data.activity.lastSeen).toLocaleString("ru-RU") : "—"}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy === "rotate" || !data.token}
            onClick={() =>
              window.confirm("Сбросить доступ? Все устройства нужно будет перенастроить. Старые настройки продолжат работать ещё 48 часов.") &&
              run("rotate", () => api("/api/account/token/rotate", { method: "POST" }))
            }
          >
            <RefreshCw className="h-4 w-4" aria-hidden /> Сбросить персональный адрес
          </button>
          {data.previousToken ? (
            <span className="text-xs text-mute">Предыдущий адрес работает до {new Date(data.previousToken.validUntil).toLocaleString("ru-RU")}.</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function DevicesCard({ data }: { data: Summary }) {
  const [tab, setTab] = useState<"apple" | "android" | "desktop" | "router">("apple");
  const tabs = [
    { id: "apple" as const, label: "iPhone / iPad / Mac", icon: Apple },
    { id: "android" as const, label: "Android", icon: Smartphone },
    { id: "desktop" as const, label: "Windows / браузеры", icon: Monitor },
    { id: "router" as const, label: "Роутер / ПК", icon: Router },
  ];
  return (
    <section className="card" aria-labelledby="dev-h">
      <h2 id="dev-h" className="m-0 text-lg font-semibold">
        Настройка устройств
      </h2>
      <p className="mt-1 text-sm text-mute">Персональные адреса — ваш ключ доступа. Не публикуйте их.</p>
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Тип устройства">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${tab === t.id ? "border-accent bg-accent-soft text-accent font-semibold" : "border-line text-mute"}`}
          >
            <t.icon className="h-4 w-4" aria-hidden /> {t.label}
          </button>
        ))}
      </div>
      <div className="mt-4 grid gap-3" role="tabpanel">
        {tab === "apple" ? (
          <>
            <ol className="prose-pereval m-0 grid gap-1.5 text-sm text-mute">
              <li>Скачайте профиль и откройте его. На iPhone: Настройки → Профиль загружен → Установить.</li>
              <li>На Mac: Системные настройки → Конфиденциальность и безопасность → Профили → Установить.</li>
              <li>Готово: DNS-over-HTTPS работает в Wi-Fi и сотовой сети.</li>
            </ol>
            <a href="/api/account/dns.mobileconfig" className="btn-primary w-fit">
              Скачать профиль для Apple
            </a>
            {data.dns.dohUrl ? <CopyField label="DoH URL (если настраиваете вручную)" value={data.dns.dohUrl} /> : null}
          </>
        ) : null}
        {tab === "android" ? (
          <>
            <ol className="prose-pereval m-0 grid gap-1.5 text-sm text-mute">
              <li>Настройки → Сеть и интернет → Частный DNS (Private DNS).</li>
              <li>Выберите «Имя хоста поставщика частного DNS» и вставьте адрес ниже.</li>
              <li>Сохраните. Работает во всех сетях без приложений.</li>
            </ol>
            {data.dns.dotHost ? <CopyField label="Имя хоста частного DNS (DoT)" value={data.dns.dotHost} /> : null}
          </>
        ) : null}
        {tab === "desktop" ? (
          <>
            <ol className="prose-pereval m-0 grid gap-1.5 text-sm text-mute">
              <li>Windows 11: Параметры → Сеть и интернет → Wi-Fi/Ethernet → Назначение DNS-сервера → Вручную → IPv4, укажите IP ниже, шифрование «Только зашифрованные» и шаблон DoH.</li>
              <li>Chrome / Edge / Яндекс / Firefox: в настройках безопасности включите DNS-over-HTTPS с «своим провайдером» и вставьте DoH URL.</li>
            </ol>
            {data.dns.dohUrl ? <CopyField label="DoH URL" value={data.dns.dohUrl} /> : null}
            <CopyField label="IP DNS-сервера" value={data.dns.dnsIp || "—"} />
          </>
        ) : null}
        {tab === "router" ? (
          <>
            <ol className="prose-pereval m-0 grid gap-1.5 text-sm text-mute">
              <li>Привяжите внешний IP вашей сети в блоке «IP-адреса и DDNS» ниже (или настройте DDNS, если IP меняется).</li>
              <li>В роутере или ПК укажите IP DNS-сервера ниже как единственный DNS.</li>
              <li>Все устройства сети получат доступ без настройки каждого.</li>
            </ol>
            <CopyField label="IP DNS-сервера" value={data.dns.dnsIp || "—"} />
          </>
        ) : null}
      </div>
    </section>
  );
}

function BoundIpsCard({ data, busy, run }: { data: Summary; busy: string | null; run: (k: string, fn: () => Promise<void>) => Promise<void> }) {
  const [host, setHost] = useState("");
  const [ddnsKey, setDdnsKey] = useState<string | null>(null);
  const [showDdns, setShowDdns] = useState(false);
  const full = data.boundIps.length >= data.maxBoundIps;
  return (
    <section className="card" aria-labelledby="ip-h">
      <h2 id="ip-h" className="m-0 text-lg font-semibold">
        IP-адреса и DDNS
      </h2>
      <p className="mt-1 text-sm text-mute">
        Для роутера, ПК или приставки с обычным DNS. Ваш текущий IP: <b className="font-mono">{data.detectedIp ?? "не определён"}</b>. Можно привязать до {data.maxBoundIps} записей.
      </p>
      {data.boundIps.length ? (
        <ul className="mt-4 grid gap-2">
          {data.boundIps.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-mono">{b.ip ?? "ожидает первого обновления"}</div>
                <div className="text-xs text-mute">
                  {b.kind === "static" ? "Статический IP" : b.kind === "ddns_host" ? `DDNS: ${b.hostname}` : "Обновляется роутером (DynDNS2)"}
                  {b.label ? ` · ${b.label}` : ""}
                  {b.lastError ? <span className="text-warn"> · {b.lastError}</span> : null}
                </div>
              </div>
              <button type="button" className="text-xs text-err underline" disabled={busy === "ip"} onClick={() => run("ip", () => api(`/api/account/ips/${b.id}`, { method: "DELETE" }))}>
                Удалить
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-mute">Привязанных адресов нет.</p>
      )}
      {!full ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy === "ip" || !data.detectedIp}
            onClick={() => run("ip", () => api("/api/account/ips", { method: "POST", body: JSON.stringify({ kind: "static", label: "Мой IP" }) }))}
          >
            <Globe className="h-4 w-4" aria-hidden /> Привязать мой текущий IP
          </button>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!host.trim()) return;
              void run("ip", async () => {
                await api("/api/account/ips", { method: "POST", body: JSON.stringify({ kind: "ddns_host", hostname: host.trim() }) });
                setHost("");
              });
            }}
          >
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="home.duckdns.org"
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm"
              aria-label="DDNS-имя"
            />
            <button type="submit" className="btn-secondary !px-3" disabled={busy === "ip"}>
              Добавить DDNS
            </button>
          </form>
        </div>
      ) : null}
      <details className="mt-4" open={showDdns} onToggle={(e) => setShowDdns((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-sm font-semibold">Автообновление IP с роутера (DynDNS2)</summary>
        <div className="mt-3 grid gap-3 text-sm text-mute">
          <p className="m-0">
            Keenetic, MikroTik, ASUS, OpenWrt и Synology умеют сообщать свой IP «кастомному DynDNS-провайдеру». Укажите в роутере:
          </p>
          <CopyField label="URL обновления" value={data.ddns.updateUrl} />
          <CopyField label="Логин" value={data.ddns.login} mono={false} />
          {ddnsKey ? (
            <CopyField label="Пароль (ключ — показан один раз)" value={ddnsKey} />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span>Пароль: {data.ddns.hasKey ? "ключ выпущен (скрыт)" : "ключ ещё не выпущен"}</span>
              <button
                type="button"
                className="btn-secondary !px-3 !py-1.5 !text-xs"
                disabled={busy === "ddns"}
                onClick={() =>
                  run("ddns", async () => {
                    const r = await api<{ key: string }>("/api/account/ddns-key/rotate", { method: "POST" });
                    setDdnsKey(r.key);
                    if (!data.boundIps.some((b) => b.kind === "ddns_push")) {
                      await api("/api/account/ips", { method: "POST", body: JSON.stringify({ kind: "ddns_push", label: "Роутер" }) });
                    }
                  })
                }
              >
                {data.ddns.hasKey ? "Перевыпустить ключ" : "Выпустить ключ и включить"}
              </button>
            </div>
          )}
          <p className="m-0 text-xs">
            Формат запроса: <code className="chip">GET {data.ddns.updateUrl}?hostname=router&amp;myip=&lt;ip&gt;</code> с HTTP Basic-авторизацией. Ответы: good, nochg, badauth.
          </p>
        </div>
      </details>
    </section>
  );
}
