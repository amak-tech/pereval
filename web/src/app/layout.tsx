import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { SITE } from "@/content/site";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.origin),
  title: {
    default: `${SITE.name} — ИИ-сервисы и инструменты разработки без VPN`,
    template: `%s — ${SITE.name}`,
  },
  description: SITE.description,
  applicationName: SITE.name,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: SITE.name,
    locale: "ru_RU",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: `${SITE.name} — Smart DNS для доступа к ИИ-сервисам` }],
  },
  twitter: { card: "summary_large_image", images: ["/og-image.png"] },
  robots: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#141413" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const ga = process.env.GA_MEASUREMENT_ID ?? "G-3BY15ZZD8D";
  const gtm = process.env.GTM_CONTAINER_ID ?? "GTM-NKC68GDT";
  return (
    <html lang="ru" className={inter.variable}>
      <body className="min-h-dvh flex flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-panel focus:px-3 focus:py-2 focus:shadow"
        >
          К содержимому
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
        {ga || gtm ? (
          <>
            {/* Google Tag Manager (контейнер) + Google Analytics 4 (gtag). Общий dataLayer. */}
            {gtm ? <Script src={`https://www.googletagmanager.com/gtm.js?id=${gtm}`} strategy="afterInteractive" /> : null}
            {ga ? <Script src={`https://www.googletagmanager.com/gtag/js?id=${ga}`} strategy="afterInteractive" /> : null}
            <Script id="gtag-init" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());${ga ? `gtag('config', '${ga}');` : ""}`}
            </Script>
          </>
        ) : null}
      </body>
    </html>
  );
}
