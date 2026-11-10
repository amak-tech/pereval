import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ExternalLink, Heart, Send } from "lucide-react";
import { Faq } from "@/components/Faq";
import { JsonLd } from "@/components/JsonLd";
import { Badge, Section } from "@/components/Section";
import { ConnectivityCheck } from "@/components/home/ConnectivityCheck";
import { HowItWorks } from "@/components/home/HowItWorks";
import { LoadBadge } from "@/components/home/LoadBadge";
import { NotIncluded } from "@/components/home/NotIncluded";
import { ServiceCatalog } from "@/components/home/ServiceCatalog";
import { buildSetupTabs } from "@/components/home/SetupPanels";
import { SetupWizard } from "@/components/home/SetupWizard";
import { StickyCta } from "@/components/home/StickyCta";
import { PlansSection } from "@/components/plans/PlansSection";
import { HOME_FAQ } from "@/content/faq";
import { SITE } from "@/content/site";
import { catalog, freeCategories } from "@/lib/catalog";

const TITLE = `${SITE.name} — ChatGPT, Claude и Gemini без VPN: Smart DNS`;
const DESCRIPTION = `Бесплатный Smart DNS: ChatGPT, Claude, Gemini, Cursor и JetBrains без VPN, а российские сайты и банки работают напрямую. Настройка за минуту, без программ.`;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { url: "/", title: TITLE, description: DESCRIPTION },
};

export default function HomePage() {
  const { name, free, counts } = SITE;
  const tabs = buildSetupTabs({ name, ip: free.dns_ip, doh: free.doh_url, dot: free.dot_host, profilePath: SITE.appleProfilePath });

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name,
      url: SITE.origin,
      logo: `${SITE.origin}/apple-touch-icon.png`,
      sameAs: [SITE.telegram, SITE.github],
      contactPoint: [{ "@type": "ContactPoint", contactType: "customer support", email: SITE.supportEmail, availableLanguage: ["ru"] }],
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name,
      url: SITE.origin,
      inLanguage: "ru",
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${SITE.origin}/?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
  ];

  return (
    <div className="pb-20 md:pb-0">
      {/* Герой */}
      <section className="border-b border-line bg-panel" aria-labelledby="hero-h">
        <div className="wrap py-12 sm:py-16">
          <p className="eyebrow m-0 mb-3">Smart DNS · без VPN · бесплатно</p>
          <h1 id="hero-h" className="m-0 max-w-[22ch] text-[clamp(30px,5.5vw,46px)] font-semibold leading-[1.1] tracking-tight">
            ChatGPT, Claude, Gemini и инструменты разработки — без VPN
          </h1>
          <p className="mt-5 max-w-[66ch] text-[17px] text-mute">
            Если ChatGPT отвечает «not available in your country», Claude не открывается, а Gemini просит сменить регион — дело в вашем IP-адресе, а не в блокировках. {name} — DNS-сервер, который направляет через зарубежный узел только {counts.free_services} сервисов из списка, а всё остальное оставляет как есть: без VPN-клиента, расширений и настройки каждого приложения.
          </p>
          <div id="hero-cta" className="mt-7 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <a href="#setup" className="btn-primary text-[16px]">
              Выбрать устройство <ArrowDown className="h-4 w-4" aria-hidden />
            </a>
            <LoadBadge />
          </div>
          <ul className="m-0 mt-8 flex list-none flex-wrap gap-2 p-0" aria-label="Ключевые свойства">
            {["Ничего не устанавливать", "Сквозное шифрование TLS", `${counts.free_services} сервисов · ${counts.free_domains} доменов`, "Российские сайты — напрямую", "Без аккаунта и регистрации"].map((t) => (
              <li key={t}>
                <Badge tone="mute">{t}</Badge>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Section id="how" eyebrow="Как это работает" title="Один адрес DNS вместо VPN" lead="Сервер делает две вещи: как DNS отвечает своим адресом только на домены из списка, а как TCP-прокси читает имя хоста в начале TLS-рукопожатия и передаёт соединение настоящему сервису.">
        <HowItWorks ip={free.dns_ip} />
      </Section>

      <Section id="setup" eyebrow="Настройка за 1 минуту" title="Выберите устройство" lead="Инструкции для каждой платформы — 2–4 шага. Адреса можно скопировать одной кнопкой, профиль для Apple устанавливается в один клик.">
        <SetupWizard tabs={tabs} />
        <div className="note mt-5 [&_p]:m-0 [&_p+p]:mt-2" role="note">
          <p>
            <strong>Настроили DNS в системе? Проверьте «Безопасный DNS» в браузере.</strong> Chrome, Edge и Firefox могут использовать собственный DNS-over-HTTPS (Cloudflare или Google), который игнорирует системные настройки. Укажите в браузере наш адрес <code>{free.doh_url}</code> или отключите встроенный безопасный DNS (вкладка «Браузеры»). Safari всегда следует системным настройкам.
          </p>
          <p>
            <strong>Сайт открывается, но всё равно пишет о недоступности в регионе?</strong> Скорее всего соединение прошло по IPv6, минуя подмену. Отключите IPv6 на интерфейсе или подключитесь к сети без IPv6.
          </p>
        </div>
      </Section>

      <Section id="check" eyebrow="Проверка" title="Проверить, работает ли" lead="После настройки убедитесь, что соединения с сервисами проходят через новый DNS.">
        <ConnectivityCheck />
      </Section>

      <Section id="services" eyebrow="Каталог" title="Какие сервисы охвачены" lead={`${counts.free_services} сервисов в ${counts.free_categories} категориях — ${counts.free_domains} базовых доменов и все их поддомены. Нужны Notion, Miro, Canva, Spotify, TikTok или игровые сервисы — они в каталоге Pro.`}>
        <ServiceCatalog categories={freeCategories()} telegram={SITE.telegram} />
      </Section>

      <Section id="request" eyebrow="Не нашли сервис?" title="Предложите домен — добавим за пару минут">
        <div className="card flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <p className="m-0 max-w-[60ch] text-[15px] text-mute">
            Если зарубежный сайт или приложение закрывает доступ по региону, но его ещё нет в списке — напишите в Telegram-чат или создайте Issue на GitHub. Укажите название сервиса и основной домен (а если знаете — домены API или статики).
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <a href={SITE.telegram} target="_blank" rel="noopener" className="btn-primary">
              <Send className="h-4 w-4" aria-hidden /> Написать в Telegram
            </a>
            <a href={`${SITE.githubIssues}/new`} target="_blank" rel="noopener" className="btn-secondary">
              <ExternalLink className="h-4 w-4" aria-hidden /> Issue на GitHub
            </a>
          </div>
        </div>
      </Section>

      <Section id="plans" eyebrow="Тарифы" title="Free, Pro и выделенный сервер" lead={`Базовый сервер «${name}» бесплатен и рассчитан на текстовые нейросети и инструменты разработки. Нужна стабильная скорость вечером, рабочие инструменты вроде Notion и Miro, музыка, TikTok и игры — это Pro. Свой сервер на роутер для семьи или команды — Dedicated.`}>
        <PlansSection />
      </Section>

      <Faq items={HOME_FAQ} />

      <Section id="limits" eyebrow="Ограничения" title="Что важно знать">
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-panel">
          <table className="w-full min-w-[560px] border-collapse text-[15px]">
            <caption className="sr-only">Ограничения DNS-прокси</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-mute">
                <th scope="col" className="px-4 py-3 font-semibold">
                  Ситуация
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Что происходит
                </th>
              </tr>
            </thead>
            <tbody className="[&_td]:px-4 [&_td]:py-3 [&_td]:align-top [&_tr]:border-t [&_tr]:border-line">
              <tr>
                <td>Сервис проверяет страну аккаунта или платёжного средства, а не адрес</td>
                <td className="text-mute">Прокси не поможет — например, при проверке платёжного региона для лицензий JetBrains</td>
              </tr>
              <tr>
                <td>Мобильные приложения с закреплением сертификата (pinning)</td>
                <td className="text-mute">Работают: сертификат настоящий, соединение сквозное</td>
              </tr>
              <tr>
                <td>Домена нет в списке</td>
                <td className="text-mute">
                  Он разрешается обычным образом и остаётся недоступным из вашего региона. Предложите его в{" "}
                  <a href={SITE.telegram} target="_blank" rel="noopener">
                    Telegram-чате
                  </a>{" "}
                  или через{" "}
                  <a href={SITE.githubIssues} target="_blank" rel="noopener">
                    GitHub Issues
                  </a>{" "}
                  — добавим
                </td>
              </tr>
              <tr>
                <td>Ресурсы, доступ к которым ограничен законодательством РФ или РБ</td>
                <td className="text-mute">Не входит в задачу. Сервис восстанавливает доступ только к зарубежным платформам, которые сами ограничивают российские и белорусские IP-адреса по геолокации</td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3 id="excluded" className="mb-3 mt-8 scroll-mt-20 text-[17px] font-semibold">
          Что не входит и почему
        </h3>
        <NotIncluded disabled={catalog.disabled} passthrough={catalog.passthrough} />
      </Section>

      <Section id="support" eyebrow="Поддержка" title="Помощь и поддержка проекта" lead={`Базовый DNS «${name}» бесплатен, без рекламы и регистрации. Вопросы — в Telegram-чате и по почте; если сервис помогает в работе, можно поддержать оплату серверов.`}>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="card">
            <p className="eyebrow m-0">Поддержка</p>
            <h3 className="m-0 mt-2 text-[17px] font-semibold">Вопросы и помощь</h3>
            <ul className="m-0 mt-3 grid list-none gap-2 p-0 text-[15px]">
              <li>
                <a href={SITE.telegram} target="_blank" rel="noopener">
                  Telegram-чат сообщества
                </a>
              </li>
              <li>
                <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a>
              </li>
              <li>
                <a href={SITE.github} target="_blank" rel="noopener">
                  Исходный код на GitHub
                </a>
              </li>
            </ul>
          </div>
          <div className="card">
            <p className="eyebrow m-0">Карты РФ, СБП и зарубежные карты</p>
            <h3 className="m-0 mt-2 text-[17px] font-semibold">Lava.top</h3>
            <p className="m-0 mt-2 text-[15px] text-mute">Поддержка в рублях (картами российских банков и через СБП) или с зарубежных карт.</p>
            <a href={SITE.donate.lava} target="_blank" rel="noopener" className="btn-secondary mt-4">
              <Heart className="h-4 w-4" aria-hidden /> Поддержать на Lava.top
            </a>
          </div>
          <div className="card">
            <p className="eyebrow m-0">Зарубежные карты и PayPal</p>
            <h3 className="m-0 mt-2 text-[17px] font-semibold">Ko-fi</h3>
            <p className="m-0 mt-2 text-[15px] text-mute">Разовый донат или подписка через международную платформу Ko-fi.</p>
            <a href={SITE.donate.kofi} target="_blank" rel="noopener" className="btn-secondary mt-4">
              <Heart className="h-4 w-4" aria-hidden /> Поддержать на Ko-fi
            </a>
          </div>
        </div>
        <aside className="card mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between" aria-label="Port Buddy — проект создателей сервиса">
          <div>
            <p className="eyebrow m-0">От создателей «{name}» · Open Source</p>
            <p className="m-0 mt-1 text-[15px]">
              Разрабатываете локально? <strong>Port Buddy</strong> открывает <code>localhost</code> в интернет одной командой: HTTP, TCP и UDP-туннели, постоянные поддомены и свои домены с авто-SSL. {name} работает бесплатно благодаря этой команде.
            </p>
          </div>
          <a href={`${SITE.portbuddy}&utm_content=home_card`} target="_blank" rel="noopener" className="btn-secondary shrink-0">
            Попробовать Port Buddy <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        </aside>
        <p className="mt-6 text-sm text-mute">
          Используя сервис, вы принимаете <Link href="/terms">Пользовательское соглашение</Link> и <Link href="/privacy">Политику конфиденциальности</Link>.
        </p>
      </Section>

      <StickyCta />
      <JsonLd data={jsonLd} />
    </div>
  );
}
