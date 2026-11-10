import type { Metadata } from "next";
import Script from "next/script";
import { LegalDocument } from "@/components/legal/LegalDocument";
import { termsIntro, termsSections } from "@/content/legal";
import { SITE, formatRuDate } from "@/content/site";

const DESCRIPTION = `Пользовательское соглашение DNS-сервиса ${SITE.name}: правила использования, отказ от гарантий, ограничение ответственности и условия платной подписки Pro.`;

export const metadata: Metadata = {
  title: "Пользовательское соглашение",
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: { url: "/terms", type: "article", title: `Пользовательское соглашение — ${SITE.name}`, description: DESCRIPTION },
};

export default function TermsPage() {
  // Реквизиты продавца подставляются из окружения при сборке; пусто — нейтральная формулировка.
  const sections = termsSections(process.env.SELLER_LEGAL ?? "");
  return (
    <LegalDocument
      title="Пользовательское соглашение (Условия использования)"
      lead={
        <>
          Редакция от {formatRuDate(SITE.legalUpdated)}. Настоящий документ является юридически обязывающим соглашением между Пользователем и владельцами (администрацией) сервиса «{SITE.name}».
        </>
      }
      intro={termsIntro()}
      sections={sections}
      after={
        <>
          {/* Виджет Paydex (платёжный агент) — по требованию провайдера размещается в конце оферты. */}
          <div data-paydex-agent />
          <Script src="https://paydex.pro/api/public/agent?p=3bd5400e-e098-46d5-bab4-81f735c37eff" strategy="afterInteractive" />
        </>
      }
    />
  );
}
