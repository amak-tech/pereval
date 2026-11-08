import Link from "next/link";
import { SITE } from "@/content/site";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line bg-panel">
      <div className="wrap grid gap-8 py-10 text-sm text-mute md:grid-cols-3">
        <div>
          <p className="m-0 text-ink font-semibold">{SITE.name}</p>
          <p className="mt-2">
            Smart DNS и прозрачный SNI-прокси для зарубежных ИИ-сервисов и инструментов разработки. Российские сайты и банки работают напрямую.
          </p>
          <p className="mt-2">
            Проект поддерживает команда{" "}
            <a href={`${SITE.portbuddy}&utm_content=footer`} target="_blank" rel="noopener">
              Port Buddy
            </a>
            .
          </p>
        </div>
        <nav aria-label="Разделы" className="grid grid-cols-2 gap-x-6 gap-y-2">
          <Link href="/" className="no-underline hover:underline">Бесплатный DNS</Link>
          <Link href="/pro" className="no-underline hover:underline">{SITE.name} Pro</Link>
          <Link href="/dedicated" className="no-underline hover:underline">{SITE.name} Dedicated</Link>
          <Link href="/stats" className="no-underline hover:underline">Статистика</Link>
          <Link href="/account" className="no-underline hover:underline">Личный кабинет</Link>
          <Link href="/#faq" className="no-underline hover:underline">Вопросы и ответы</Link>
          <Link href="/terms" className="no-underline hover:underline">Пользовательское соглашение</Link>
          <Link href="/privacy" className="no-underline hover:underline">Политика конфиденциальности</Link>
        </nav>
        <div className="grid gap-2">
          <a href={SITE.telegram} target="_blank" rel="noopener" className="no-underline hover:underline">Telegram-чат поддержки</a>
          <a href={SITE.github} target="_blank" rel="noopener" className="no-underline hover:underline">Исходный код на GitHub</a>
          <a href={`mailto:${SITE.supportEmail}`} className="no-underline hover:underline">{SITE.supportEmail}</a>
        </div>
      </div>
      <div className="wrap pb-8">
        <p className="m-0 text-xs leading-relaxed text-mute/90">
          Сервис не является средством обхода блокировок Роскомнадзора или Мининформа РБ, работает строго по фиксированному списку
          незапрещённых зарубежных IT-платформ и не предоставляет доступ к ресурсам, ограниченным законодательством РФ и РБ. Используя
          сервис, вы принимаете <Link href="/terms">Пользовательское соглашение</Link> и <Link href="/privacy">Политику конфиденциальности</Link>.
        </p>
      </div>
    </footer>
  );
}
