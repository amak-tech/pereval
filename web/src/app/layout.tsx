import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { TouchSplashCanvas } from "@/components/TouchSplashCanvas";
import { SITE } from "@/content/site";
import { DEFAULT_OPEN_GRAPH, OG_IMAGE } from "@/lib/metadata";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-inter", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin", "cyrillic"], variable: "--font-jetbrains-mono", display: "swap" });

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
  openGraph: DEFAULT_OPEN_GRAPH,
  twitter: { card: "summary_large_image", images: [OG_IMAGE.url] },
  robots: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
};

export const viewport: Viewport = {
  themeColor: "#f7f9fc",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const ga = process.env.GA_MEASUREMENT_ID ?? "G-3BY15ZZD8D";
  const gtm = process.env.GTM_CONTAINER_ID ?? "GTM-NKC68GDT";
  const ymRaw = process.env.YM_COUNTER_ID ?? "114262096";
  const ym = /^\d+$/.test(ymRaw) ? Number(ymRaw) : null;
  return (
    <html lang="ru" className={`${inter.variable} ${jetbrainsMono.variable}`}>
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
        <TouchSplashCanvas />
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
        {ym ? (
          <>
            {/* Yandex.Metrika counter */}
            <Script id="yandex-metrika" strategy="afterInteractive">
              {`(function(m,e,t,r,i,k,a){
    m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
    m[i].l=1*new Date();
    for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
    k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
})(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=${ym}', 'ym');

window.__YM_COUNTER_ID = ${ym};
ym(${ym}, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});`}
            </Script>
            <noscript>
              <div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`https://mc.yandex.ru/watch/${ym}`} style={{ position: "absolute", left: "-9999px" }} alt="" />
              </div>
            </noscript>
          </>
        ) : null}
      </body>
    </html>
  );
}
