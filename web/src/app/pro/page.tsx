import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, Gauge, KeyRound, Mail, Sparkles, UserRound, Zap } from "lucide-react";
import { Faq } from "@/components/Faq";
import { JsonLd } from "@/components/JsonLd";
import { Badge, Section } from "@/components/Section";
import { ProPrice } from "@/components/billing/ProPrice";
import { Checkout } from "@/components/pro/Checkout";
import { CompareTable } from "@/components/pro/CompareTable";
import { ProCatalog } from "@/components/pro/ProCatalog";
import { PRO_FAQ } from "@/content/faq";
import { SITE } from "@/content/site";
import { proCategories } from "@/lib/catalog";

const TITLE = `${SITE.name} Pro — стриминги, соцсети и игры без VPN`;
const DESCRIPTION = `Подписка ${SITE.name} Pro: Spotify, Netflix, Twitch, TikTok, Reddit, Canva, Notion, Supercell и Xbox без VPN на быстрых серверах. Отмена в любой момент.`;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/pro" },
  openGraph: { url: "/pro", title: TITLE, description: DESCRIPTION },
};

/** Цены для Offer в JSON-LD: запрос к собственному API с ревалидацией раз в 10 минут; при ошибке — без цены. */
async function fetchPlansForSeo(): Promise<{ RUB?: number; USD?: number } | null> {
  try {
    const res = await fetch(`${SITE.origin}/api/billing/plans`, { next: { revalidate: 600 }, signal: AbortSignal.timeout(3000), headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { prices?: { RUB?: number; USD?: number } };
    return data.prices ?? null;
  } catch {
    return null;
  }
}

export default async function ProPage() {
  const { name, counts } = SITE;
  const prices = await fetchPlansForSeo();
  const cats = proCategories();

  const offer: Record<string, unknown> = {
    "@type": "Offer",
    url: `${SITE.origin}/pro#buy`,
    availability: "https://schema.org/InStock",
    category: "subscription",
    eligibleRegion: ["RU", "BY"],
  };
  if (typeof prices?.RUB === "number") {
    offer.price = prices.RUB;
    offer.priceCurrency = "RUB";
    offer.priceSpecification = {
      "@type": "UnitPriceSpecification",
      price: prices.RUB,
      priceCurrency: "RUB",
      billingDuration: 1,
      billingIncrement: 1,
      unitCode: "MON",
    };
  }
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${name} Pro`,
    description: DESCRIPTION,
    brand: { "@type": "Brand", name },
    url: `${SITE.origin}/pro`,
    image: `${SITE.origin}/og-image.png`,
    offers: offer,
  };

  const benefits = [
    { icon: Gauge, eyebrow: "Стабильная скорость", title: "Никаких вечерних просадок", text: "На бесплатном сервере один канал делится на всех. В Pro работают отдельные незагруженные серверы только для подписчиков — музыка, видео в высоком качестве, голосовые режимы ChatGPT и игры летают в любое время суток." },
    { icon: Sparkles, eyebrow: "Стриминги, соцсети и игры", title: "Музыка, кино, лента и творчество", text: "Видеосервисы, стриминги и игры нельзя добавить в бесплатную версию без перегрузки общего канала. В Pro открыты самые востребованные сервисы на каждый день, которые не работают из РФ и РБ без VPN." },
    { icon: KeyRound, eyebrow: "Личный кабинет", title: "Настройка устройств за 1 клик", text: "В кабинете вы скачиваете готовый профиль для iPhone / macOS, получаете персональные адреса DoH и DoT для Android, Windows и браузера, привязываете домашний IP и включаете нужные категории сайтов." },
  ];

  return (
    <div>
      <section className="border-b border-line bg-panel" aria-labelledby="pro-h">
        <div className="wrap py-12 sm:py-16">
          <div className="flex flex-wrap gap-2">
            <Badge>Подписка · для себя</Badge>
            <Badge tone="mute">Оплата картой РФ, СБП или зарубежной картой</Badge>
          </div>
          <h1 id="pro-h" className="m-0 mt-4 max-w-[24ch] text-[clamp(28px,5vw,42px)] font-semibold leading-[1.1] tracking-tight">
            {name} Pro — полный каталог и быстрые серверы без вечерних тормозов
          </h1>
          <p className="mt-5 max-w-[66ch] text-[17px] text-mute">
            Бесплатный сервер хорош для текстовых нейросетей, но им пользуются тысячи людей одновременно. В {name} Pro вы подключаетесь к свободным серверам и получаете все {counts.free_services} сервисов Free плюс {counts.pro_services} популярных сервисов, которые сами закрыли доступ для России и Беларуси: <strong>Spotify, Netflix, Twitch (1080p), TikTok, Reddit, Pinterest, Canva, Notion, Miro, Supercell, Xbox и PlayStation</strong>.
          </p>
          <p className="mt-4 text-[17px]">
            <ProPrice size="lg" /> <span className="text-mute">· отмена в любой момент, доступ до конца оплаченного месяца</span>
          </p>
          <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <a href="#buy" className="btn-primary text-[16px]">
              Оформить подписку <ArrowDown className="h-4 w-4" aria-hidden />
            </a>
            <Link href="/dedicated" className="btn-secondary">
              Нужно для семьи или компании? Dedicated
            </Link>
          </div>
        </div>
      </section>

      <Section id="why-pro" eyebrow="Преимущества" title={`Чем ${name} Pro лучше бесплатной версии`}>
        <div className="grid gap-4 md:grid-cols-3">
          {benefits.map((b) => (
            <div key={b.title} className="card">
              <b.icon className="h-6 w-6 text-accent" aria-hidden />
              <p className="eyebrow m-0 mt-3">{b.eyebrow}</p>
              <h3 className="m-0 mt-1 text-[17px] font-semibold">{b.title}</h3>
              <p className="m-0 mt-2 text-[15px] text-mute">{b.text}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="catalog" eyebrow="Каталог Pro" title={`Какие сервисы входят в ${name} Pro`} lead={`Помимо всех ${counts.free_services} сервисов бесплатного тарифа (ChatGPT, Claude, Gemini, Cursor, JetBrains и др.), в подписку входят ${counts.pro_services} сервисов в ${counts.pro_categories} категориях — ${counts.pro_domains} доменов со всеми поддоменами. Каждый сервис закреплён за пулом узлов: ИИ-платформы идут с постоянного IP, тяжёлый медиа-трафик — через отдельные узлы.`}>
        <ProCatalog categories={cats} />
        <div className="note mt-5 [&_p]:m-0" role="note">
          <p>
            <strong>Сквозное TLS-шифрование и работа российских сайтов сохраняются.</strong> Как и в бесплатной версии, {name} Pro не расшифровывает HTTPS-трафик и перенаправляет только домены из списка. Госуслуги, банки, маркетплейсы, Кинопоиск и ВК открываются напрямую через вашего провайдера на полной скорости.
          </p>
        </div>
      </Section>

      <Section id="compare" eyebrow="Сравнение" title="Free, Pro и Dedicated">
        <CompareTable />
      </Section>

      <Section id="buy" eyebrow="Оформление" title={`Оформить ${name} Pro`} lead="Без регистрации: укажите email, выберите валюту и перейдите к оплате. Подписка продлевается автоматически раз в месяц, отменить можно в любой момент в кабинете.">
        <Checkout name={name} supportEmail={SITE.supportEmail} />
        <ol className="m-0 mt-6 grid list-none gap-3 p-0 sm:grid-cols-3">
          {[
            { icon: Zap, title: "Оплата через платёжный сервис", text: "Карта РФ, СБП или зарубежная карта. Данные карты остаются у платёжного сервиса." },
            { icon: Mail, title: "Письмо со ссылкой для входа", text: "Сразу после оплаты на email придёт чек и ссылка в кабинет. Пароль не нужен." },
            { icon: UserRound, title: "Профили и адреса в кабинете", text: "Скачайте профиль для iPhone/macOS, скопируйте DoT/DoH для Android и браузера, привяжите домашний IP." },
          ].map((s, i) => (
            <li key={s.title} className="flex gap-3 rounded-lg border border-line bg-bg p-4">
              <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                {i + 1}
              </span>
              <div>
                <div className="text-[15px] font-semibold">{s.title}</div>
                <p className="m-0 mt-1 text-sm text-mute">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Faq items={PRO_FAQ} title={`Частые вопросы о ${name} Pro`} />
      <JsonLd data={jsonLd} />
    </div>
  );
}
