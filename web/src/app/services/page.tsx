import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { JsonLd } from "@/components/JsonLd";
import { MountainPassBackdrop } from "@/components/MountainPassBackdrop";
import { Badge, Section } from "@/components/Section";
import { CollapsibleServiceGrid } from "@/components/services/CollapsibleServiceGrid";
import { allServicePages } from "@/content/pseo-services";
import { SITE } from "@/content/site";
import { catalog } from "@/lib/catalog";
import { pageOpenGraph } from "@/lib/metadata";

const TITLE = `Каталог сервисов без VPN (${SITE.name} Free и Pro) — ИИ, работа, музыка и игры`;
const DESCRIPTION = `Полный список зарубежных платформ, которые открывает Smart DNS ${SITE.name} из России и Беларуси без VPN: ChatGPT, Claude, Gemini, Cursor, Notion, Miro, Coda, Adobe, Autodesk, Spotify, Xbox и ещё десятки сервисов.`;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/services" },
  openGraph: pageOpenGraph({ url: "/services", title: TITLE, description: DESCRIPTION }),
};

export default function ServicesIndexPage() {
  const pages = allServicePages();
  const freePages = pages.filter((p) => p.tier === "free");
  const proPages = pages.filter((p) => p.tier === "pro");

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE.name, item: SITE.origin },
      { "@type": "ListItem", position: 2, name: "Каталог сервисов", item: `${SITE.origin}/services` },
    ],
  };

  return (
    <div>
      <section className="hero-pass" aria-labelledby="services-h">
        <MountainPassBackdrop variant="subtle" />
        <div className="wrap relative z-10 py-14 sm:py-20">
          <nav aria-label="Хлебные крошки" className="mb-4 flex items-center gap-1.5 text-sm text-mute">
            <Link href="/" className="no-underline hover:text-ink hover:underline">
              Главная
            </Link>
            <span aria-hidden>/</span>
            <span className="text-ink font-medium">Все сервисы</span>
          </nav>
          <p className="eyebrow m-0 mb-3">Полный справочник · Free и Pro</p>
          <h1 id="services-h" className="m-0 max-w-[24ch] text-[clamp(30px,5vw,46px)] font-semibold leading-[1.08] tracking-[-0.03em]">
            Какие зарубежные сервисы открывает «{SITE.name}» без VPN
          </h1>
          <p className="mt-4 max-w-[68ch] text-[17px] text-mute">
            Выберите нужную платформу, чтобы посмотреть причину ограничения по IP, полный список покрываемых доменов и готовую инструкцию по настройке за 1 минуту.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Badge tone="ok">{freePages.length} страниц Free</Badge>
            <Badge tone="accent">{proPages.length} страниц Pro</Badge>
            <Link href="/setup" className="btn-secondary !py-1.5 !text-sm">
              Инструкции по устройствам и роутерам <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      <Section
        id="pro-list"
        eyebrow={`Подписка ${SITE.name} Pro`}
        title="Рабочие пространства, дизайн, музыка, умный дом и консоли"
        lead="Сервисы с подтверждённым геоблоком IP для РФ и РБ на выделенных незагруженных серверах."
      >
        {catalog.categories
          .filter((c) => c.tier === "pro")
          .map((cat) => {
            const items = proPages.filter((p) => p.categoryId === cat.id);
            return (
              <div key={cat.id} className="mt-6 first:mt-0">
                <h3 className="m-0 mb-3 text-[18px] font-semibold">
                  {cat.name} <span className="font-normal text-mute">· {items.length}</span>
                </h3>
                <CollapsibleServiceGrid
                  id={`pro-${cat.id}`}
                  variant="pro"
                  items={items.map((item) => ({
                    slug: item.slug,
                    shortName: item.shortName,
                    primaryDomain: item.domains[0] ?? "",
                    summary: item.whyBlocked,
                  }))}
                />
              </div>
            );
          })}
      </Section>

      <Section
        id="free-list"
        eyebrow={`Бесплатный тариф ${SITE.name} Free`}
        title="ИИ-платформы, языковые модели и инструменты разработки"
        lead="Работают бесплатно без регистрации и установки клиентов."
      >
        {catalog.categories
          .filter((c) => c.tier === "free")
          .map((cat) => {
            const items = freePages.filter((p) => p.categoryId === cat.id);
            return (
              <div key={cat.id} className="mt-8 first:mt-0">
                <h3 className="m-0 mb-3 text-[18px] font-semibold">
                  {cat.name} <span className="font-normal text-mute">· {items.length}</span>
                </h3>
                <CollapsibleServiceGrid
                  id={`free-${cat.id}`}
                  variant="free"
                  items={items.map((item) => ({
                    slug: item.slug,
                    shortName: item.shortName,
                    primaryDomain: item.domains[0] ?? "",
                    summary: item.errorBadge,
                  }))}
                />
              </div>
            );
          })}
      </Section>

      <JsonLd data={breadcrumbJsonLd} />
    </div>
  );
}
