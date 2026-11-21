import Link from "next/link";
import { SITE } from "@/content/site";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line bg-panel-elevated/70">
      <div className="wrap grid gap-10 py-14 text-sm text-mute md:grid-cols-[1.2fr_1.3fr_0.9fr]">
        <div>
          <p className="m-0 font-semibold tracking-[-0.02em] text-ink">{SITE.name}</p>
          <p className="mt-3 max-w-[36ch] leading-relaxed">
            Smart DNS и прозрачный SNI-прокси для зарубежных ИИ-сервисов и инструментов разработки. Российские сайты и банки работают напрямую.
          </p>
          <p className="mt-3">
            Проект поддерживает команда{" "}
            <a href={`${SITE.portbuddy}&utm_content=footer`} target="_blank" rel="noopener" className="text-ink underline decoration-line-strong underline-offset-4 hover:text-accent hover:decoration-accent">
              Port Buddy
            </a>
            .
          </p>
        </div>
        <nav aria-label="Разделы" className="grid grid-cols-2 content-start gap-x-6 gap-y-2.5">
          <Link href="/" className="text-mute no-underline transition-colors hover:text-ink">Бесплатный DNS</Link>
          <Link href="/pro" className="text-mute no-underline transition-colors hover:text-ink">{SITE.name} Pro</Link>
          <Link href="/dedicated" className="text-mute no-underline transition-colors hover:text-ink">{SITE.name} Dedicated</Link>
          <Link href="/services" className="text-mute no-underline transition-colors hover:text-ink">Каталог сервисов</Link>
          <Link href="/setup" className="text-mute no-underline transition-colors hover:text-ink">Настройка устройств</Link>
          <Link href="/stats" className="text-mute no-underline transition-colors hover:text-ink">Статистика</Link>
          <Link href="/account" className="text-mute no-underline transition-colors hover:text-ink">Личный кабинет</Link>
          <Link href="/#faq" className="text-mute no-underline transition-colors hover:text-ink">Вопросы и ответы</Link>
          <Link href="/terms" className="text-mute no-underline transition-colors hover:text-ink">Пользовательское соглашение</Link>
          <Link href="/privacy" className="text-mute no-underline transition-colors hover:text-ink">Политика конфиденциальности</Link>
        </nav>
        <div className="grid content-start gap-2.5">
          <a href={SITE.telegram} target="_blank" rel="noopener" className="text-mute no-underline transition-colors hover:text-accent">Telegram-чат поддержки</a>
          <a href={SITE.github} target="_blank" rel="noopener" className="text-mute no-underline transition-colors hover:text-accent">Исходный код на GitHub</a>
          <a href={`mailto:${SITE.supportEmail}`} className="font-mono text-[13px] text-mute no-underline transition-colors hover:text-accent">{SITE.supportEmail}</a>
        </div>
      </div>
      <div className="border-t border-line/70">
        <div className="wrap py-6">
          <p className="m-0 text-xs leading-relaxed text-mute/80">
            Сервис не является средством обхода блокировок Роскомнадзора или Мининформа РБ, работает строго по фиксированному списку
            незапрещённых зарубежных IT-платформ и не предоставляет доступ к ресурсам, ограниченным законодательством РФ и РБ. Используя
            сервис, вы принимаете <Link href="/terms" className="text-mute underline decoration-line-strong underline-offset-2 hover:text-ink">Пользовательское соглашение</Link> и{" "}
            <Link href="/privacy" className="text-mute underline decoration-line-strong underline-offset-2 hover:text-ink">Политику конфиденциальности</Link>.
          </p>
        </div>
      </div>
    </footer>
  );
}
