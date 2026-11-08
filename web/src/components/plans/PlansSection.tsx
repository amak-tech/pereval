import Link from "next/link";
import { Check } from "lucide-react";
import { ProPrice } from "@/components/billing/ProPrice";
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
      text: "Быстрые серверы без вечерних просадок и полный каталог: стриминги, соцсети, игры, приложения.",
      items: [
        `Всё из Free + ${counts.pro_services} сервисов в ${counts.pro_categories} категориях`,
        "Spotify, Netflix, Twitch, TikTok, Reddit, Pinterest",
        "Canva, Notion, Miro, Supercell, Xbox, PlayStation",
        "Личный кабинет: профили, персональные DoH/DoT, выбор категорий",
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
        <article key={p.key} className={`card flex flex-col ${p.featured ? "border-accent ring-1 ring-accent" : ""}`} aria-labelledby={`plan-${p.key}`}>
          <div className="flex items-center justify-between gap-2">
            <p className="eyebrow m-0">{p.eyebrow}</p>
            {p.featured ? <Badge>популярный</Badge> : null}
          </div>
          <h3 id={`plan-${p.key}`} className="m-0 mt-2 text-[20px] font-semibold tracking-tight">
            {p.title}
          </h3>
          <div className="mt-2 min-h-[34px]">{p.price}</div>
          <p className="m-0 mt-2 text-[15px] text-mute">{p.text}</p>
          <ul className="m-0 mt-4 grid flex-1 list-none gap-2 p-0 text-[15px]">
            {p.items.map((it) => (
              <li key={it} className="flex gap-2">
                <Check className="mt-1 h-4 w-4 shrink-0 text-ok" aria-hidden />
                <span>{it}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5">{p.cta}</div>
        </article>
      ))}
    </div>
  );
}
