import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Самодостаточный server.js для Docker (копируется вместе с .next/static и public).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Кабинет и API не индексируем
        source: "/(account|api)/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
  async redirects() {
    return [
      // Старые адреса страниц со статического сайта
      { source: "/index.html", destination: "/", permanent: true },
      { source: "/pro.html", destination: "/pro", permanent: true },
      { source: "/dedicated.html", destination: "/dedicated", permanent: true },
      { source: "/stats.html", destination: "/stats", permanent: true },
      { source: "/terms.html", destination: "/terms", permanent: true },
      { source: "/privacy.html", destination: "/privacy", permanent: true },
    ];
  },
};

export default nextConfig;
