import { ProPrice } from "@/components/billing/ProPrice";
import { SITE } from "@/content/site";

/** Сравнение Free / Pro / Dedicated; строка «Цена» для Pro читается клиентом из /api/billing/plans. */
export function CompareTable() {
  const { name, counts } = SITE;
  const rows: { label: string; free: React.ReactNode; pro: React.ReactNode; dedicated: React.ReactNode }[] = [
    {
      label: "Цена",
      free: <strong>0 ₽</strong>,
      pro: <ProPrice suffix="/мес" />,
      dedicated: "по запросу",
    },
    {
      label: "Серверы и скорость",
      free: "Общий бесплатный сервер (возможна нагрузка вечером)",
      pro: <strong>Отдельные быстрые серверы только для подписчиков</strong>,
      dedicated: "Персональный изолированный сервер (свой IP и домен)",
    },
    {
      label: "Доступные сервисы",
      free: `${counts.free_services} сервисов: текстовые ИИ и инструменты разработки`,
      pro: (
        <>
          <strong>Полный каталог:</strong> Free + {counts.pro_services} сервисов — Spotify, Netflix, Twitch, TikTok, Reddit, Pinterest, Canva, Notion, Miro, Supercell, Xbox, PlayStation и др.
        </>
      ),
      dedicated: (
        <>
          Каталог Pro + <strong>любые ваши собственные домены</strong>
        </>
      ),
    },
    {
      label: "Настройка и управление",
      free: "Общие адреса с главной страницы",
      pro: (
        <>
          <strong>Личный кабинет:</strong> профили для iOS/macOS, персональные DoH/DoT, привязка IP, выбор категорий
        </>
      ),
      dedicated: "Кабинет управления сервером, своими доменами и устройствами семьи/команды",
    },
    {
      label: "Кому подходит",
      free: "Базовая работа с текстовыми ИИ",
      pro: <strong>На каждый день для себя: смартфон, ноутбук, ПК</strong>,
      dedicated: "Вся семья (роутер, Smart TV) или компания и команда",
    },
    {
      label: "Оплата",
      free: "—",
      pro: "Ежемесячно, автопродление, отмена в кабинете",
      dedicated: "По договорённости",
    },
  ];
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-panel">
      <table className="w-full min-w-[640px] border-collapse text-[15px]">
        <caption className="sr-only">Сравнение тарифов {name}</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-mute">
            <th scope="col" className="px-4 py-3 font-semibold">
              Параметр
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Free
            </th>
            <th scope="col" className="bg-accent-soft/60 px-4 py-3 font-semibold text-accent">
              {name} Pro
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Dedicated
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-line align-top">
              <th scope="row" className="px-4 py-3 text-left font-semibold">
                {r.label}
              </th>
              <td className="px-4 py-3 text-mute">{r.free}</td>
              <td className="bg-accent-soft/40 px-4 py-3">{r.pro}</td>
              <td className="px-4 py-3 text-mute">{r.dedicated}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
