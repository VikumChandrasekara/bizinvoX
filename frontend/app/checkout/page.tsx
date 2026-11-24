import type { Metadata } from "next";

import { CheckoutPage } from "@/components/billing/checkout-page";
import { isInterval } from "@/lib/billing";

export const metadata: Metadata = {
  title: "Upgrade to Pro",
  description: "Pick monthly or yearly, review what you pay and when, then finish on Stripe's secure payment page.",
  alternates: { canonical: "/checkout" },
  // A personal step in a purchase: nothing here is worth indexing.
  robots: { index: false, follow: true },
};

export default async function CheckoutRoute({ searchParams }: { searchParams: Promise<{ plan?: string; cancelled?: string }> }) {
  const { plan, cancelled } = await searchParams;
  return <CheckoutPage initialPlan={isInterval(plan) ? plan : "annual"} cancelled={cancelled === "1"} />;
}
