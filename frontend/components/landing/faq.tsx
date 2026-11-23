import { ChevronDown } from "lucide-react";

import { JsonLd } from "@/components/json-ld";
import { FAQ } from "@/lib/content";

/** FAQ rendered with native <details> (accessible, zero JS) + FAQPage schema. */
export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="mx-auto max-w-3xl scroll-mt-24 px-4 py-20 sm:px-6">
      <h2 id="faq-title" className="text-center text-3xl font-bold">Frequently asked questions</h2>
      <div className="mt-10 divide-y rounded-2xl border bg-card">
        {FAQ.map((f) => (
          <details key={f.q} className="group p-5 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
              {f.q}
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition group-open:rotate-180" />
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
          </details>
        ))}
      </div>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
        }}
      />
    </section>
  );
}
