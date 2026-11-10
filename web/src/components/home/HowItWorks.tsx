import { Lock, Network, ShieldCheck } from "lucide-react";

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
          <li key={s.title} className="card relative pt-7">
            <span aria-hidden className="absolute -top-3 left-5 flex h-7 w-7 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-ink">
              {i + 1}
            </span>
            <h3 className="m-0 text-[16px] font-semibold">{s.title}</h3>
            <p className="m-0 mt-2 text-[15px] text-mute">{s.text}</p>
          </li>
        ))}
      </ol>
      <ul className="m-0 mt-5 grid list-none gap-3 p-0 sm:grid-cols-3">
        {facts.map((f) => (
          <li key={f.title} className="flex gap-3 rounded-lg border border-line bg-bg p-4">
            <f.icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
            <div>
              <div className="text-[15px] font-semibold">{f.title}</div>
              <p className="m-0 mt-1 text-sm text-mute">{f.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
