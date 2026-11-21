import Link from "next/link";
import { Check } from "lucide-react";
import { ProPrice } from "@/components/billing/ProPrice";
import { MouseTrailCanvas } from "@/components/MouseTrailCanvas";
import { Badge } from "@/components/Section";
import { SITE } from "@/content/site";

/** Три карточки тарифов. Используется на главной (полный вид). Цена Pro — клиентский ProPrice. */
export function PlansSection() {
  const { name, counts } = SITE;
  const plans = [
    {
      key: "free",
      eyebrow: "Бесплатно · без регистрации",
      title: `${name} Free`,
      price: <span className="text-[clamp(22px,4vw,28px)] font-semibold tracking-tight">0 ₽</span>,
      text: "Общий сервер для ежедневной работы с текстовыми нейросетями и инструментами разработки.",
      items: [`${counts.free_services} сервисов ИИ и инструментов разработки`, "Настройка за 1 минуту, без аккаунта", "Общий канал — возможна нагрузка в часы пик"],
      cta: (
        <a href="#setup" className="btn-secondary w-full">
          К настройке
        </a>
      ),
      featured: false,
    },
    {
      key: "pro",
      eyebrow: "Подписка · для себя",
      title: `${name} Pro`,
      price: <ProPrice size="lg" />,
      text: "Быстрые серверы без вечерних просадок и полный каталог: рабочие инструменты, дизайн и 3D, музыка, умный дом и игры.",
      items: [
        `Всё из Free + ${counts.pro_services} сервисов в ${counts.pro_categories} категориях`,
        "Notion, Miro, Coda, Lucidchart, Adobe, Autodesk, SketchUp",
        "Spotify, ElevenLabs, Coursera, edX, Home Connect, Dyson",
        "Supercell, Xbox, PlayStation + личный кабинет (DoH/DoT, IP)",
        "Отмена в любой момент, доступ до конца оплаченного месяца",
      ],
      cta: (
        <Link href="/pro#buy" className="btn-primary w-full">
          Оформить Pro
        </Link>
      ),
      featured: true,
    },
    {
      key: "dedicated",
      eyebrow: "Для семьи и команд",
      title: `${name} Dedicated`,
      price: <span className="text-[clamp(22px,4vw,28px)] font-semibold tracking-tight">по запросу</span>,
      text: "Выделенный персональный DNS-прокси сервер со своим IP и доменом.",
      items: ["На домашнем роутере — для всей семьи, Smart TV и консолей", "Или изолированный узел для компании", "Каталог Pro + ваши собственные домены", "Доступ только для ваших устройств"],
      cta: (
        <Link href="/dedicated" className="btn-secondary w-full">
          Оставить заявку
        </Link>
      ),
      featured: false,
    },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {plans.map((p) => (
        <article
          key={p.key}
          className={`relative overflow-hidden flex flex-col ${p.featured ? "card-featured" : "card hover:border-line-strong"}`}
          aria-labelledby={`plan-${p.key}`}
        >
          {p.featured ? (
            <MouseTrailCanvas cellSize={16} maxAlpha={0.18} decay={0.03} />
          ) : (
            <MouseTrailCanvas cellSize={16} maxAlpha={0.15} decay={0.03} />
          )}
          <div className="relative z-10 flex flex-1 flex-col">
            <div className="flex items-center justify-between gap-2">
              <p className="eyebrow m-0">{p.eyebrow}</p>
              {p.featured ? <Badge>популярный</Badge> : null}
            </div>
            <h3 id={`plan-${p.key}`} className="m-0 mt-3 text-[22px] font-semibold tracking-[-0.02em]">
              {p.title}
            </h3>
            <div className="mt-2 min-h-[36px]">{p.price}</div>
            <p className="m-0 mt-2.5 text-[14.5px] leading-relaxed text-mute">{p.text}</p>
            <ul className="m-0 mt-5 grid flex-1 list-none gap-2.5 border-t border-line/70 pt-5 p-0 text-[14.5px]">
              {p.items.map((it) => (
                <li key={it} className="flex gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                  <span className="text-ink/90">{it}</span>
                </li>
              ))}
            </ul>
            <div className="mt-6">{p.cta}</div>
          </div>
        </article>
      ))}
    </div>
  );
}
