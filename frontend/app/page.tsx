import type { Metadata } from "next";

import { JsonLd } from "@/components/json-ld";
import { Editor } from "@/components/editor/editor";
import { Faq } from "@/components/landing/faq";
import { PricingCards } from "@/components/landing/pricing-cards";
import { UrlActions } from "@/components/url-actions";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Free Invoice Generator | Create Invoices Online - bizinvoX.com" },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
};

/** The whole site is this one page: the editor first, then pricing and the FAQ. */
export default function HomePage() {
  return (
    <main>
      <Editor />

      <section id="pricing" aria-labelledby="pricing-title" className="mx-auto max-w-7xl scroll-mt-24 px-4 py-20 sm:px-6">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <h2 id="pricing-title" className="text-3xl font-bold sm:text-4xl">
            Simple, fair pricing
          </h2>
          <p className="mt-3 text-muted-foreground">Start free. Download with a watermark, remove it for one invoice, or unlock everything with Pro.</p>
        </div>
        <PricingCards />
      </section>

      <Faq />
      <UrlActions />

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: SITE_NAME,
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          url: SITE_URL,
          description: SITE_DESCRIPTION,
          offers: [
            { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
            { "@type": "Offer", name: "Watermark removal (per invoice)", price: "0.99", priceCurrency: "USD" },
            { "@type": "Offer", name: "Pro", price: "5.99", priceCurrency: "USD" },
          ],
        }}
      />
    </main>
  );
}
