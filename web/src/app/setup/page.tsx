import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { JsonLd } from "@/components/JsonLd";
import { Badge, Section } from "@/components/Section";
import { allDeviceGuides, type DeviceGroup } from "@/content/pseo-devices";
import { SITE } from "@/content/site";

const TITLE = `Настройка Smart DNS ${SITE.name} на iPhone, Android, Windows, Keenetic, MikroTik и Xbox`;
const DESCRIPTION = `Пошаговые инструкции по настройке зашифрованного DNS ${SITE.name} (DoH, DoT, .mobileconfig, update_hosts.py) на смартфонах, компьютерах, роутерах Keenetic и MikroTik, консолях Xbox и PlayStation.`;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/setup" },
  openGraph: { url: "/setup", title: TITLE, description: DESCRIPTION },
};

const GROUPS: { id: DeviceGroup; eyebrow: string; title: string; lead: string }[] = [
  {
    id: "personal",
    eyebrow: "Смартфоны, ноутбуки и браузеры",
    title: "Личные устройства",
    lead: "Готовые профили Apple, встроенный «Частный DNS» на Android, нативный DoH в Windows 11 и настройка отдельного браузера.",
  },
  {
    id: "routers",
    eyebrow: "Один раз на всю домашнюю сеть",
    title: "Роутеры Keenetic, MikroTik, OpenWrt, ASUS и TP-Link",
    lead: "Зашифрованный DNS на маршрутизаторе раздаёт доступ сразу всем телефонам, ноутбукам, Smart TV и приставкам дома.",
  },
  {
    id: "consoles",
    eyebrow: "Игровые приставки",
    title: "Xbox Series X|S, Xbox One, PlayStation 5 и PS4",
    lead: "Устранение региональной ошибки 0x80a40401 на Xbox и стабильная работа PSN с сохранением максимальной скорости скачивания игр.",
  },
  {
    id: "developers",
    eyebrow: "Терминал и рабочие сети",
    title: "Linux и совместная работа с корпоративным VPN",
    lead: "Конфигурации systemd-resolved / NetworkManager и скрипт с открытым исходным кодом update_hosts.py для работы поверх Cloudflare WARP и AnyConnect.",
  },
];

export default function SetupIndexPage() {
  const guides = allDeviceGuides();

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE.name, item: SITE.origin },
      { "@type": "ListItem", position: 2, name: "Настройка устройств", item: `${SITE.origin}/setup` },
    ],
  };

  return (
    <div>
      <section className="border-b border-line bg-panel" aria-labelledby="setup-idx-h">
        <div className="wrap py-12 sm:py-16">
          <nav aria-label="Хлебные крошки" className="mb-4 flex items-center gap-1.5 text-sm text-mute">
            <Link href="/" className="no-underline hover:text-ink hover:underline">
              Главная
            </Link>
            <span aria-hidden>/</span>
            <span className="text-ink font-medium">Настройка устройств</span>
          </nav>
          <p className="eyebrow m-0 mb-3">База знаний · {guides.length} инструкций</p>
          <h1 id="setup-idx-h" className="m-0 max-w-[26ch] text-[clamp(28px,5vw,42px)] font-semibold leading-[1.12] tracking-tight">
            Инструкции по настройке «{SITE.name}» для всех устройств и роутеров
          </h1>
          <p className="mt-4 max-w-[66ch] text-[17px] text-mute">
            Выберите операционную систему, роутер или игровую консоль — внутри готовые адреса для копирования, команды терминала и разбор типичных ошибок.
          </p>
        </div>
      </section>

      {GROUPS.map((grp) => {
        const items = guides.filter((g) => g.group === grp.id);
        return (
          <Section key={grp.id} id={grp.id} eyebrow={grp.eyebrow} title={grp.title} lead={grp.lead}>
            <div className="grid gap-4 md:grid-cols-2">
              {items.map((g) => (
                <Link
                  key={g.slug}
                  href={`/setup/${g.slug}`}
                  className="card group flex flex-col justify-between no-underline transition-colors hover:border-accent"
                >
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[17px] font-semibold text-ink group-hover:text-accent">{g.name}</span>
                      <Badge tone={g.tierNote === "pro_recommended" ? "accent" : "mute"}>
                        {g.tierNote === "pro_recommended" ? "Pro" : "Free / Pro"}
                      </Badge>
                    </div>
                    <p className="m-0 mt-2 text-sm text-mute">{g.summary}</p>
                  </div>
                  <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs">
                    <span className="text-mute">{g.protocolBadge}</span>
                    <span className="inline-flex items-center gap-1 font-semibold text-accent">
                      Открыть гайд <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </Section>
        );
      })}

      <JsonLd data={breadcrumbJsonLd} />
    </div>
  );
}
