import type { Metadata } from "next";
import { StatsDashboard } from "@/components/stats/StatsDashboard";
import { SITE } from "@/content/site";

const DESCRIPTION = `Нагрузка DNS-прокси ${SITE.name} в реальном времени: пользователи онлайн, запросы в минуту, трафик, популярные сервисы и состояние узлов кластера.`;

export const metadata: Metadata = {
  title: "Статистика и нагрузка",
  description: DESCRIPTION,
  alternates: { canonical: "/stats" },
  openGraph: { url: "/stats", title: `Статистика и нагрузка — ${SITE.name}`, description: DESCRIPTION },
};

export default function StatsPage() {
  const { name, free, pro, counts } = SITE;
  return (
    <div className="wrap py-10 sm:py-14">
      <p className="eyebrow m-0 mb-2">Мониторинг · обновление каждые 5 секунд</p>
      <h1 className="m-0 text-[clamp(26px,5vw,36px)] font-semibold tracking-tight">Статистика и нагрузка в реальном времени</h1>
      <p className="mt-3 max-w-[72ch] text-[16px] text-mute">
        Сводка по трафику SNI/HTTP-прокси бесплатного кластера {name} (<code>{free.domain}</code>): уникальные пользователи, интенсивность запросов, распределение по {counts.free_services} сервисам за последние 24 часа и состояние узлов Free и Pro.
      </p>
      <div className="mt-8">
        <StatsDashboard freeDomain={free.domain} proDomain={pro?.domain ?? null} serviceCount={counts.free_services} />
      </div>
    </div>
  );
}
