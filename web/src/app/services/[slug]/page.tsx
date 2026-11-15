import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowDown, ArrowRight, CheckCircle2, Globe, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { Faq } from "@/components/Faq";
import { JsonLd } from "@/components/JsonLd";
import { Badge, Section } from "@/components/Section";
import { ProPrice } from "@/components/billing/ProPrice";
import { ConnectivityCheck } from "@/components/home/ConnectivityCheck";
import { LoadBadge } from "@/components/home/LoadBadge";
import { buildSetupTabs } from "@/components/home/SetupPanels";
import { SetupWizard } from "@/components/home/SetupWizard";
import { Checkout } from "@/components/pro/Checkout";
import { deviceGuidesBySlugs } from "@/content/pseo-devices";
import { allServicePages, poolSummaryForPage, relatedServicePages, servicePageBySlug } from "@/content/pseo-services";
import { SITE } from "@/content/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return allServicePages().map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const entry = servicePageBySlug(slug);
  if (!entry) return {};
  const path = `/services/${entry.slug}`;
  return {
    title: { absolute: entry.title },
    description: entry.description,
    alternates: { canonical: path },
    openGraph: { url: path, title: entry.title, description: entry.description },
  };
}

export default async function ServiceSeoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = servicePageBySlug(slug);
  if (!entry) notFound();

  const { name, free, pro } = SITE;
  const isFree = entry.tier === "free";

  const setupTabs = isFree
    ? buildSetupTabs({
        name,
        ip: free.dns_ip,
        doh: free.doh_url,
        dot: free.dot_host,
        profilePath: SITE.appleProfilePath,
      })
    : buildSetupTabs({
        name: `${name} Pro`,
        ip: pro?.dns_ip ?? "85.209.148.147",
        doh: `https://${pro?.domain ?? "pro.pereval.top"}/dns/<ваш-токен>`,
        dot: `<ваш-токен>.${pro?.domain ?? "pro.pereval.top"}`,
        profilePath: "#buy",
        isProTemplate: true,
      });

  const guides = deviceGuidesBySlugs(entry.recommendedDevices);
  const related = relatedServicePages(entry, 6);

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE.name, item: SITE.origin },
      { "@type": "ListItem", position: 2, name: "Каталог сервисов", item: `${SITE.origin}/services` },
      { "@type": "ListItem", position: 3, name: entry.shortName, item: `${SITE.origin}/services/${entry.slug}` },
    ],
  };

  return (
    <div>
      {/* Герой */}
      <section className="border-b border-line bg-panel" aria-labelledby="svc-hero-h">
        <div className="wrap py-10 sm:py-14">
          <nav aria-label="Хлебные крошки" className="mb-4 flex flex-wrap items-center gap-1.5 text-sm text-mute">
            <Link href="/" className="no-underline hover:text-ink hover:underline">
              Главная
            </Link>
            <span aria-hidden>/</span>
            <Link href="/services" className="no-underline hover:text-ink hover:underline">
              Все сервисы
            </Link>
            <span aria-hidden>/</span>
            <span className="text-ink font-medium">{entry.shortName}</span>
          </nav>

          <div className="flex flex-wrap gap-2">
            <Badge tone={isFree ? "ok" : "accent"}>{isFree ? `Бесплатно · ${name} Free` : `Подписка · ${name} Pro`}</Badge>
            <Badge tone="mute">{entry.categoryName}</Badge>
            <Badge tone="warn">{entry.errorBadge}</Badge>
          </div>

          <h1 id="svc-hero-h" className="m-0 mt-4 max-w-[26ch] text-[clamp(28px,5vw,42px)] font-semibold leading-[1.12] tracking-tight">
            {entry.h1}
          </h1>

          <p className="mt-4 max-w-[68ch] text-[17px] leading-relaxed text-mute">{entry.lead}</p>

          {!isFree ? (
            <p className="mt-4 text-[16px]">
              <ProPrice size="md" /> <span className="text-mute">· все сервисы Free и Pro, отмена в любой момент</span>
            </p>
          ) : null}

          <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            {isFree ? (
              <>
                <a href="#setup" className="btn-primary text-[16px]">
                  Настроить бесплатно за 1 минуту <ArrowDown className="h-4 w-4" aria-hidden />
                </a>
                <LoadBadge />
              </>
            ) : (
              <>
                <a href="#buy" className="btn-primary text-[16px]">
                  Подключить {name} Pro <ArrowDown className="h-4 w-4" aria-hidden />
                </a>
                <a href="#setup" className="btn-secondary">
                  Посмотреть схему настройки
                </a>
              </>
            )}
          </div>

          <ul className="m-0 mt-7 flex list-none flex-wrap gap-2 p-0" aria-label="Свойства подключения">
            <li className="chip !font-sans !text-xs">Без установки VPN</li>
            <li className="chip !font-sans !text-xs">Сквозное шифрование TLS</li>
            <li className="chip !font-sans !text-xs">
              {entry.domains.length} базовых доменов + поддомены
            </li>
            <li className="chip !font-sans !text-xs">{poolSummaryForPage(entry.pool)}</li>
            <li className="chip !font-sans !text-xs">Банки и Госуслуги — напрямую</li>
          </ul>
        </div>
      </section>

      {/* Причина ограничения и принцип работы */}
      <Section
        id="reason"
        eyebrow="Технический разбор"
        title={`Почему ${entry.shortName} не открывается и как работает решение`}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <article className="card">
            <div className="flex items-center gap-2 text-warn">
              <Globe className="h-5 w-5 shrink-0" aria-hidden />
              <span className="text-xs font-semibold uppercase tracking-wider">Причина ограничения</span>
            </div>
            <h3 className="m-0 mt-2 text-[17px] font-semibold">Фильтрация по геолокации IP</h3>
            <p className="m-0 mt-2 text-[15px] leading-relaxed text-mute">{entry.whyBlocked}</p>
          </article>

          <article className="card">
            <div className="flex items-center gap-2 text-ok">
              <ShieldCheck className="h-5 w-5 shrink-0" aria-hidden />
              <span className="text-xs font-semibold uppercase tracking-wider">Как работает {name}</span>
            </div>
            <h3 className="m-0 mt-2 text-[17px] font-semibold">Прозрачный SNI-маршрут без расшифровки TLS</h3>
            <p className="m-0 mt-2 text-[15px] leading-relaxed text-mute">{entry.howSolved}</p>
          </article>
        </div>

        {entry.caveat ? (
          <div className="note mt-4 flex items-start gap-3 [&_p]:m-0" role="note">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
            <p>
              <strong>Важная особенность для {entry.shortName}:</strong> {entry.caveat}
            </p>
          </div>
        ) : null}
      </Section>

      {/* Для Pro-сервисов — блок оформления сразу перед/вместе с визардом */}
      {!isFree ? (
        <Section
          id="buy"
          eyebrow={`Подписка ${name} Pro`}
          title={`Подключить доступ к ${entry.shortName} без VPN`}
          lead={`В подписку ${name} Pro входят ${entry.shortName}, все остальные рабочие, медиа- и игровые сервисы каталога Pro, а также все ${SITE.counts.free_services} сервисов бесплатного тарифа на отдельных быстрых серверах.`}
        >
          <Checkout name={name} supportEmail={SITE.supportEmail} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-mute">
            <span>Сразу после оплаты на email придёт ссылка в кабинет с готовым профилем Apple, токеном DoH/DoT и привязкой домашнего IP.</span>
            <Link href="/pro" className="font-semibold text-accent no-underline hover:underline">
              Все возможности тарифа Pro →
            </Link>
          </div>
        </Section>
      ) : null}

      {/* Интерактивный мастер настройки */}
      <Section
        id="setup"
        eyebrow={isFree ? "Бесплатная настройка за 1 минуту" : "Как настраивается после подключения Pro"}
        title={`Настроить DNS для ${entry.shortName} на вашем устройстве`}
        lead={
          isFree
            ? `Выберите свою платформу — ${entry.shortName} начнёт открываться сразу после сохранения адреса DNS или установки профиля.`
            : `В личном кабинете ${name} Pro вы получаете персональный токен (вместо <ваш-токен> ниже) и кнопку привязки домашнего IP для роутеров и приставок.`
        }
      >
        <SetupWizard tabs={setupTabs} defaultTab={entry.defaultWizardTab} />

        {isFree ? (
          <div className="mt-6">
            <h3 className="m-0 mb-2.5 text-[16px] font-semibold">Быстрая проверка из браузера</h3>
            <ConnectivityCheck />
          </div>
        ) : null}

        {isFree ? (
          <div className="card mt-5 flex flex-col gap-3 border-accent/40 bg-accent-soft/50 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
              <p className="m-0 text-sm text-mute">
                <strong className="text-ink">Нужны также Notion, Miro, Canva, Spotify, TikTok или Xbox без вечерних очередей?</strong> В подписке {name} Pro работают отдельные свободные серверы и полный каталог сервисов.
              </p>
            </div>
            <Link href="/pro" className="btn-secondary shrink-0 !text-sm">
              Посмотреть {name} Pro
            </Link>
          </div>
        ) : null}
      </Section>

      {/* Покрытые домены из services.yaml */}
      <Section
        id="domains"
        eyebrow="Маршрутизация из services.yaml"
        title={`Какие домены ${entry.shortName} покрывает ${name}`}
        lead={`Перечислены базовые домены (${entry.domains.length} шт.). Все их дочерние поддомены вида *.domain включаются в DNS и SNI-прокси автоматически — веб-интерфейс, API, авторизация и статика работают согласованно с одного узла (${poolSummaryForPage(entry.pool)}).`}
      >
        <div className="card">
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={`Домены ${entry.shortName}`}>
            {entry.domains.map((d) => (
              <li key={d}>
                <code className="chip">{d}</code>
              </li>
            ))}
          </ul>
          {entry.parentSlug && entry.parentName ? (
            <p className="m-0 mt-4 border-t border-line pt-3 text-sm text-mute">
              Входит в единую группу маршрутизации{" "}
              <Link href={`/services/${entry.parentSlug}`} className="font-medium text-accent no-underline hover:underline">
                {entry.parentName}
              </Link>
              .
            </p>
          ) : null}
        </div>
      </Section>

      {/* Рекомендуемые инструкции под устройства */}
      {guides.length > 0 ? (
        <Section
          id="devices"
          eyebrow="Пошаговые гайды"
          title={`Подробные инструкции по настройке под ${entry.shortName}`}
          lead="Развёрнутые руководства с командами терминала, настройкой роутеров Keenetic / MikroTik и решением частых сетевых конфликтов."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {guides.map((g) => (
              <Link
                key={g.slug}
                href={`/setup/${g.slug}`}
                className="card group flex flex-col justify-between no-underline transition-colors hover:border-accent"
              >
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-mute">{g.protocolBadge}</div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[16px] font-semibold text-ink group-hover:text-accent">
                    <span>{g.shortName}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-mute transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
                  </div>
                  <p className="m-0 mt-1.5 text-sm text-mute">{g.summary}</p>
                </div>
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Соседние сервисы категории */}
      {related.length > 0 ? (
        <Section
          id="related"
          eyebrow={entry.categoryName}
          title="Другие сервисы из этой категории"
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((r) => (
              <Link
                key={r.slug}
                href={`/services/${r.slug}`}
                className="card group flex flex-col justify-between no-underline transition-colors hover:border-accent"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink group-hover:text-accent">{r.shortName}</span>
                    <Badge tone={r.tier === "free" ? "mute" : "accent"}>{r.tier === "free" ? "Free" : "Pro"}</Badge>
                  </div>
                  <p className="m-0 mt-1.5 line-clamp-2 text-sm text-mute">{r.whyBlocked}</p>
                </div>
                <div className="mt-3 flex items-center gap-1 text-xs font-medium text-accent">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {r.domains[0]} {r.domains.length > 1 ? `+ ещё ${r.domains.length - 1}` : ""}
                </div>
              </Link>
            ))}
          </div>
          <div className="mt-4">
            <Link href="/services" className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent no-underline hover:underline">
              Смотреть полный каталог сервисов ({allServicePages().length}) <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </Section>
      ) : null}

      <Faq items={entry.faq} title={`Частые вопросы о доступе к ${entry.shortName}`} />
      <JsonLd data={breadcrumbJsonLd} />
    </div>
  );
}
