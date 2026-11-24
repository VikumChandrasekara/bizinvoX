import type { Metadata } from "next";

import { ManageSubscription } from "@/components/billing/manage-subscription";

export const metadata: Metadata = {
  title: "Billing & subscription",
  description: "Your plan, payment method, renewal date and receipts. Cancel or resume Pro any time.",
  alternates: { canonical: "/billing" },
  // Personal page: nothing here is worth indexing.
  robots: { index: false, follow: true },
};

export default async function BillingRoute({ searchParams }: { searchParams: Promise<{ checkout?: string; session_id?: string }> }) {
  const { checkout, session_id } = await searchParams;
  // Stripe appends the session id when it sends the customer back after paying.
  const sessionId = checkout === "success" && typeof session_id === "string" && session_id.startsWith("cs_") ? session_id : null;
  return <ManageSubscription checkoutSessionId={sessionId} />;
}
