import { Lock, Network, ShieldCheck } from "lucide-react";
import { MouseTrailCanvas } from "@/components/MouseTrailCanvas";

/** Три шага «как это работает» + три гарантии. Статический серверный компонент. */
export function HowItWorks({ ip, example = "claude.ai" }: { ip: string; example?: string }) {
  const steps = [
    {
      title: "Устройство спрашивает адрес сайта",
      text: (
        <>
          Ваш браузер или приложение запрашивает у DNS адрес <code>{example}</code>. Для доменов из списка наш сервер отвечает своим адресом <code>{ip}</code>, для всех остальных — настоящим.
        </>
      ),
    },
    {
      title: "Соединение проходит через наш узел",
      text: (
        <>
          Устройство открывает TLS-соединение к нам. Сервер читает только имя хоста из начала рукопожатия (SNI) и байт в байт пересылает соединение настоящему сервису через зарубежный узел.
        </>
      ),
    },
    {
      title: "Всё остальное — напрямую",
      text: (
        <>
          Госуслуги, банки, Ozon, Кинопоиск и любые домены вне списка работают через вашего провайдера, как раньше. Нечего включать и выключать.
        </>
      ),
    },
  ];
  const facts = [
    { icon: Lock, title: "Шифрование не затрагивается", text: "Трафик не расшифровывается: устройство само проверяет настоящий сертификат Anthropic, OpenAI или Google. Прочитать ваш трафик на сервере невозможно." },
    { icon: ShieldCheck, title: "Без клиентов и расширений", text: "Ни приложения, ни корневого сертификата, ни аккаунта. Один адрес DNS в настройках сети — и готово." },
    { icon: Network, title: "Только сервисы из списка", text: "Закрытый белый список доменов: сервер не работает как открытый прокси и не трогает ресурсы вне каталога." },
  ];
  return (
    <>
      <ol className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="card relative overflow-hidden flex flex-col justify-between hover:border-line-strong">
            <MouseTrailCanvas cellSize={16} maxAlpha={0.16} decay={0.03} />
            <div className="relative z-10">
              <div className="mb-4 flex items-center justify-between">
                <span aria-hidden className="inline-flex items-center rounded-md border border-accent/25 bg-accent-soft px-2 py-0.5 font-mono text-[12px] font-medium text-accent">
                  0{i + 1}
                </span>
                <span aria-hidden className="h-px flex-1 ml-3 bg-gradient-to-r from-line-strong to-transparent" />
              </div>
              <h3 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">{s.title}</h3>
              <p className="m-0 mt-2.5 text-[15px] leading-relaxed text-mute">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <ul className="m-0 mt-4 grid list-none gap-3 p-0 sm:grid-cols-3">
        {facts.map((f) => (
          <li key={f.title} className="flex gap-3.5 rounded-[var(--radius-card)] border border-line/90 bg-panel-elevated/60 p-4 sm:p-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent-soft text-accent">
              <f.icon className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <div className="text-[15px] font-semibold tracking-[-0.01em]">{f.title}</div>
              <p className="m-0 mt-1 text-sm leading-relaxed text-mute">{f.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
