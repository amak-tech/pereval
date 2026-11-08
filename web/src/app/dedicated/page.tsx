import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, Building, House, Layers, Lock, Wrench } from "lucide-react";
import { Faq } from "@/components/Faq";
import { Badge, Section } from "@/components/Section";
import { LeadForm } from "@/components/dedicated/LeadForm";
import { DEDICATED_FAQ } from "@/content/faq";
import { SITE } from "@/content/site";

const TITLE = `${SITE.name} Dedicated — выделенный DNS-прокси для семьи и команд`;
const DESCRIPTION = `Персональный DNS-прокси сервер со своим IP и доменом: на домашний роутер для всей семьи, Smart TV и консолей или для команды с собственным списком доменов.`;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/dedicated" },
  openGraph: { url: "/dedicated", title: TITLE, description: DESCRIPTION },
};

export default function DedicatedPage() {
  const { name, counts } = SITE;
  return (
    <div>
      <section className="border-b border-line bg-panel" aria-labelledby="ded-h">
        <div className="wrap py-12 sm:py-16">
          <div className="flex flex-wrap gap-2">
            <Badge>Для всей семьи и B2B-команд</Badge>
            <Badge tone="mute">Свой IP · свои домены · веб-кабинет</Badge>
          </div>
          <h1 id="ded-h" className="m-0 mt-4 max-w-[24ch] text-[clamp(28px,5vw,42px)] font-semibold leading-[1.1] tracking-tight">
            {name} Dedicated — ваш собственный DNS-прокси сервер для семьи или компании
          </h1>
          <p className="mt-5 max-w-[66ch] text-[17px] text-mute">
            Персональный изолированный узел «{name}» с выделенным IPv4-адресом, собственным поддоменом DNS-over-TLS / DoH и управлением через веб-кабинет. Настройте один раз на домашнем роутере для всей семьи или подключите команду — с полным каталогом сервисов и возможностью добавлять <strong>любые собственные домены</strong> за пару секунд.
          </p>
          <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <a href="#waitlist" className="btn-primary text-[16px]">
              Оставить заявку <ArrowDown className="h-4 w-4" aria-hidden />
            </a>
            <Link href="/pro" className="btn-secondary">
              Нужен доступ только для себя? {name} Pro
            </Link>
          </div>
        </div>
      </section>

      <Section id="scenarios" eyebrow="Сценарии" title="Два главных сценария использования">
        <div className="grid gap-4 md:grid-cols-2">
          <article className="card">
            <House className="h-6 w-6 text-accent" aria-hidden />
            <p className="eyebrow m-0 mt-3">Сценарий 1 · Для дома и всей семьи</p>
            <h3 className="m-0 mt-1 text-[17px] font-semibold">Один адрес DNS на роутере — и всё работает</h3>
            <p className="m-0 mt-2 text-[15px] text-mute">Пропишите выделенный IP вашего сервера в настройках домашнего роутера (Keenetic, MikroTik, ASUS, TP-Link) и выпустите профили для телефонов близких:</p>
            <ul className="m-0 mt-3 grid list-disc gap-2 pl-5 text-[15px]">
              <li>
                <strong>Все домашние устройства сразу:</strong> ноутбуки, смартфоны, планшеты, Smart TV и игровые приставки (Xbox без ошибки <code>0x80a40401</code>, PlayStation) без установки VPN на каждое устройство.
              </li>
              <li>
                <strong>Музыка, кино, соцсети и игры без ограничений:</strong> Spotify, Netflix, Twitch (1080p), TikTok, Reddit, Pinterest, Supercell (Brawl Stars, Clash Royale), Canva, Notion, Coursera и ChatGPT работают у всей семьи.
              </li>
              <li>
                <strong>Российские сервисы не ломаются:</strong> Кинопоиск, Госуслуги, банковские приложения и умный дом продолжают работать напрямую через вашего провайдера.
              </li>
            </ul>
          </article>
          <article className="card">
            <Building className="h-6 w-6 text-accent" aria-hidden />
            <p className="eyebrow m-0 mt-3">Сценарий 2 · Для команд и бизнеса (B2B)</p>
            <h3 className="m-0 mt-1 text-[17px] font-semibold">Корпоративный DNS-прокси для работы и дизайна</h3>
            <p className="m-0 mt-2 text-[15px] text-mute">Изолированный сервер для компании или продуктовой команды с фиксированным внешним IP-адресом и централизованным управлением:</p>
            <ul className="m-0 mt-3 grid list-disc gap-2 pl-5 text-[15px]">
              <li>
                <strong>Доступ к рабочему стеку:</strong> командные пространства Notion, Miro, Trello, Canva, ChatGPT Team, Claude, Cursor и JetBrains.
              </li>
              <li>
                <strong>Собственные домены под задачи команды:</strong> добавление любых нужных зарубежных сайтов, документации и SaaS-сервисов через личный кабинет за пару секунд.
              </li>
              <li>
                <strong>Чистый выделенный IP:</strong> на вашем сервере нет посторонних пользователей, поэтому аккаунты не сталкиваются с капчами и ограничениями со стороны платформ.
              </li>
            </ul>
          </article>
        </div>
      </Section>

      <Section id="features" eyebrow="Возможности" title={`Что даёт выделенный сервер ${name} Dedicated`}>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { icon: Layers, eyebrow: "Кастомные списки доменов", title: "Добавляйте свои сайты в веб-кабинете", text: "Нужен редкий зарубежный сайт, стриминг или рабочий сервис, который не открывается из РФ и РБ? Добавьте домен в личном кабинете — настройка сервера обновится автоматически за 2 секунды." },
            { icon: Lock, eyebrow: "Приватный доступ (ACL)", title: "Только ваши устройства и сети", text: "Сервер отвечает только вашим авторизованным IP/подсетям (дом, офис, корпоративный VPN) и именным профилям DoH / DoT (.mobileconfig). Никто посторонний не сможет использовать ваш канал." },
            { icon: Wrench, eyebrow: "Zero-Maintenance", title: "Обслуживание и обновления на нас", text: `Мы сами мониторим доступность узла 24/7, продлеваем TLS-сертификаты, поддерживаем базовый список из ${counts.free_services + counts.pro_services} сервисов и обновляем системное ПО без разрыва активных сессий.` },
          ].map((f) => (
            <div key={f.title} className="card">
              <f.icon className="h-6 w-6 text-accent" aria-hidden />
              <p className="eyebrow m-0 mt-3">{f.eyebrow}</p>
              <h3 className="m-0 mt-1 text-[17px] font-semibold">{f.title}</h3>
              <p className="m-0 mt-2 text-[15px] text-mute">{f.text}</p>
            </div>
          ))}
        </div>
        <div className="note mt-5 [&_p]:m-0" role="note">
          <p>
            <strong>Полная приватность на уровне архитектуры.</strong> Даже на выделенном управляемом сервере используется прозрачный TLS SNI-маршрутизатор без расшифровки трафика (без установки корневых CA-сертификатов). Все соединения вашей семьи или сотрудников с OpenAI, Anthropic, Spotify, Netflix, Notion, Miro или банками остаются зашифрованными от устройства до конечного сервиса.
          </p>
        </div>
      </Section>

      <Section id="waitlist" eyebrow="Заявка" title={`Оставьте заявку на ${name} Dedicated`} lead="Расскажите, для какой задачи нужен выделенный сервер (семья и роутер или команда) и какие сервисы важны в первую очередь. Мы отправим подтверждение на почту и свяжемся для выдачи тестового инстанса.">
        <LeadForm name={name} />
      </Section>

      <Faq items={DEDICATED_FAQ} title={`Частые вопросы о ${name} Dedicated`} />
    </div>
  );
}
