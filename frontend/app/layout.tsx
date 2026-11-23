import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";

import { Providers } from "@/components/providers";
import { SiteFooter } from "@/components/site-footer";
import { FloatingNav } from "@/components/floating-nav";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

import "./globals.css";

// Self-hosted at build time by next/font: no render-blocking third-party request.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap", weight: ["600", "700"] });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Free Invoice Generator | Create Invoices Online - bizinvoX.com", template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: SITE_NAME, url: SITE_URL, title: "Free Invoice Generator - bizinvoX.com", description: SITE_DESCRIPTION },
  twitter: { card: "summary_large_image", title: "Free Invoice Generator - bizinvoX.com", description: SITE_DESCRIPTION },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable}`}>
      <body className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:shadow">
          Skip to content
        </a>
        <Providers>
          <FloatingNav />
          <div id="main">{children}</div>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
