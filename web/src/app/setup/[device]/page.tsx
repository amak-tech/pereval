import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Wrench } from "lucide-react";
import { Faq } from "@/components/Faq";
import { JsonLd } from "@/components/JsonLd";
import { MountainPassBackdrop } from "@/components/MountainPassBackdrop";
import { Badge, Section } from "@/components/Section";
import { ConnectivityCheck } from "@/components/home/ConnectivityCheck";
import { allDeviceGuides, deviceGuideBySlug } from "@/content/pseo-devices";
import { servicePageBySlug } from "@/content/pseo-services";
import { SITE } from "@/content/site";
import { pageOpenGraph } from "@/lib/metadata";

export const dynamicParams = false;

export function generateStaticParams() {
  return allDeviceGuides().map((g) => ({ device: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ device: string }> }): Promise<Metadata> {
  const { device } = await params;
  const guide = deviceGuideBySlug(device);
  if (!guide) return {};
  const path = `/setup/${guide.slug}`;
  return {
    title: { absolute: guide.title },
    description: guide.description,
    alternates: { canonical: path },
    openGraph: pageOpenGraph({ url: path, title: guide.title, description: guide.description }),
  };
}

export default async function DeviceSetupPage({ params }: { params: Promise<{ device: string }> }) {
  const { device } = await params;
  const guide = deviceGuideBySlug(device);
  if (!guide) notFound();

  const popularServices = guide.popularServiceSlugs
    .map((s) => servicePageBySlug(s))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  const otherGuides = allDeviceGuides().filter((g) => g.slug !== guide.slug);

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE.name, item: SITE.origin },
        { "@type": "ListItem", position: 2, name: "Настройка устройств", item: `${SITE.origin}/setup` },
        { "@type": "ListItem", position: 3, name: guide.shortName, item: `${SITE.origin}/setup/${guide.slug}` },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: guide.h1,
      description: guide.description,
      totalTime: "PT2M",
      step: guide.howToSteps.map((s, idx) => ({
        "@type": "HowToStep",
        position: idx + 1,
        name: s.name,
        text: s.text,
      })),
    },
  ];

  return (
    <div>
      <section className="hero-pass" aria-labelledby="dev-hero-h">
        <MountainPassBackdrop variant="subtle" />
        <div className="wrap relative z-10 py-12 sm:py-16">
          <nav aria-label="Хлебные крошки" className="mb-4 flex flex-wrap items-center gap-1.5 text-sm text-mute">
            <Link href="/" className="no-underline hover:text-ink hover:underline">
              Главная
            </Link>
            <span aria-hidden>/</span>
            <Link href="/setup" className="no-underline hover:text-ink hover:underline">
              Настройка устройств
            </Link>
            <span aria-hidden>/</span>
            <span className="text-ink font-medium">{guide.shortName}</span>
          </nav>

          <div className="flex flex-wrap gap-2">
            <Badge tone={guide.tierNote === "pro_recommended" ? "accent" : "ok"}>
              {guide.tierNote === "pro_recommended" ? `Для ${SITE.name} Pro` : `${SITE.name} Free и Pro`}
            </Badge>
            <Badge tone="mute">{guide.groupLabel}</Badge>
            <Badge tone="mute">{guide.protocolBadge}</Badge>
          </div>

          <h1 id="dev-hero-h" className="m-0 mt-4 max-w-[26ch] text-[clamp(28px,5vw,42px)] font-semibold leading-[1.12] tracking-tight">
            {guide.h1}
          </h1>

          <p className="mt-4 max-w-[68ch] text-[17px] leading-relaxed text-mute">{guide.lead}</p>
        </div>
      </section>

      <Section id="steps" eyebrow="Пошаговая инструкция" title={`Настройка на ${guide.shortName}`}>
        {guide.content}
      </Section>

      {guide.group !== "consoles" ? (
        <Section
          id="verify"
          eyebrow="Самопроверка"
          title="Проверить работу DNS прямо из браузера"
          lead="Если вы выполняли инструкцию на этом устройстве (или на домашнем роутере, к которому оно подключено), нажмите кнопку проверки связи."
        >
          <ConnectivityCheck />
        </Section>
      ) : null}

      {guide.troubleshooting.length > 0 ? (
        <Section id="troubleshooting" eyebrow="Диагностика" title="Частые причины, почему настройка не сработала">
          <div className="grid gap-3 md:grid-cols-2">
            {guide.troubleshooting.map((t) => (
              <article key={t.symptom} className="card">
                <div className="flex items-center gap-2 text-accent">
                  <Wrench className="h-4 w-4 shrink-0" aria-hidden />
                  <h3 className="m-0 text-[15.5px] font-semibold text-ink">{t.symptom}</h3>
                </div>
                <p className="m-0 mt-2 text-sm leading-relaxed text-mute">{t.fix}</p>
              </article>
            ))}
          </div>
        </Section>
      ) : null}

      {popularServices.length > 0 ? (
        <Section
          id="services"
          eyebrow="Что заработает после настройки"
          title={`Популярные сервисы на ${guide.shortName}`}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {popularServices.map((svc) => (
              <Link
                key={svc.slug}
                href={`/services/${svc.slug}`}
                className="card group flex flex-col justify-between no-underline transition-colors hover:border-accent"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink group-hover:text-accent">{svc.shortName}</span>
                    <Badge tone={svc.tier === "free" ? "mute" : "accent"}>{svc.tier === "free" ? "Free" : "Pro"}</Badge>
                  </div>
                  <p className="m-0 mt-1.5 text-xs text-mute">{svc.errorBadge}</p>
                </div>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent">
                  Подробнее <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </span>
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      <Section id="other-devices" eyebrow="Другие платформы" title="Инструкции для остальных устройств и роутеров">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {otherGuides.map((g) => (
            <Link
              key={g.slug}
              href={`/setup/${g.slug}`}
              className="rounded-[var(--radius-card)] border border-line bg-panel p-4 no-underline transition-colors hover:border-accent"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">{g.shortName}</span>
                <span className="text-xs text-accent">→</span>
              </div>
              <p className="m-0 mt-1 text-xs text-mute">{g.protocolBadge}</p>
            </Link>
          ))}
        </div>
      </Section>

      <Faq items={guide.faq} title={`Вопросы по настройке на ${guide.shortName}`} />
      <JsonLd data={jsonLd} />
    </div>
  );
}
