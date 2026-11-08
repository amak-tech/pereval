import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal/LegalDocument";
import { privacyIntro, privacySections } from "@/content/legal";
import { SITE, formatRuDate } from "@/content/site";

const DESCRIPTION = `Политика конфиденциальности ${SITE.name}: какие технические данные обрабатывает DNS-прокси, что хранится для подписки Pro, платежи через lava.top и cookie сайта.`;

export const metadata: Metadata = {
  title: "Политика конфиденциальности",
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: { url: "/privacy", type: "article", title: `Политика конфиденциальности — ${SITE.name}`, description: DESCRIPTION },
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Политика конфиденциальности"
      lead={
        <>
          Редакция от {formatRuDate(SITE.legalUpdated)}. Настоящая Политика объясняет, какие технические данные затрагиваются при работе сервиса «{SITE.name}», веб-сайта <code>{SITE.origin}</code> и личного кабинета, и почему архитектура Сервиса исключает чтение пользовательского трафика.
        </>
      }
      intro={privacyIntro()}
      sections={privacySections()}
    />
  );
}
