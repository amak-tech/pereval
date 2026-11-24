import type { Metadata } from "next";
import { DiagnosticsClient } from "@/components/check/DiagnosticsClient";
import { SITE } from "@/content/site";
import { pageOpenGraph } from "@/lib/metadata";

const DESCRIPTION = `Автоматическая диагностика DNS ${SITE.name}: за пару секунд определяет, не применился ли DNS или соединение ограничивает ТСПУ провайдера, проверяет любой сайт по каталогу и готовит отчёт для поддержки.`;

export const metadata: Metadata = {
  title: "Диагностика DNS и доступа",
  description: DESCRIPTION,
  alternates: { canonical: "/check" },
  openGraph: pageOpenGraph({
    url: "/check",
    title: `Диагностика DNS и доступа — ${SITE.name}`,
    description: DESCRIPTION,
  }),
};

export default function CheckPage() {
  return (
    <div className="wrap py-10 sm:py-14">
      <p className="eyebrow m-0 mb-2">Диагностика · DNS vs ТСПУ</p>
      <h1 className="m-0 text-[clamp(26px,5vw,38px)] font-semibold tracking-tight">
        Почему не открывается сервис?
      </h1>
      <p className="mt-3 max-w-[74ch] text-[16px] leading-relaxed text-mute">
        Инструмент автоматически проверяет, работает ли DNS {SITE.name} в вашем браузере, доходят ли соединения до контрольных сервисов и входит ли нужный сайт в список. Вы сразу увидите, где проблема — в настройках DNS на устройстве или в фильтрации на стороне сети/ТСПУ.
      </p>

      <div className="mt-8">
        <DiagnosticsClient />
      </div>
    </div>
  );
}
