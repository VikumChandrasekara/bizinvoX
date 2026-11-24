import type { Pricing } from "@/components/invoice/paywall-dialog";
import type { Plan } from "@/lib/auth";

export type Interval = "monthly" | "annual";

export type PaymentRecord = {
  id: string;
  kind: "single_download" | "pro_subscription";
  description: string;
  amountCents: number;
  currency: string;
  status: "succeeded" | "refunded" | "pending" | "failed";
  createdAt: string;
  receiptUrl: string | null;
};

/** What `GET /api/v1/billing/subscription` returns: everything the Manage subscription page shows. */
export type Subscription = {
  plan: Plan;
  /** Stripe's status: active, trialing, past_due, canceled. Null before the first subscription. */
  status: string | null;
  interval: Interval | null;
  amountCents: number | null;
  currency: string | null;
  /** The next renewal, or (when `cancelAtPeriodEnd`) the moment Pro ends. */
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  startedAt: string | null;
  hasBillingAccount: boolean;
  /** False when the server has no Stripe keys, so nothing can be paid. */
  paymentsConfigured: boolean;
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  usage: { invoices: number; templates: number };
  payments: PaymentRecord[];
};

/** Shown until /pricing answers, and if it never does. Same numbers as the seeded config. */
export const FALLBACK_PRICING: Pricing = { downloadPriceCents: 99, currency: "USD", proMonthlyCents: 599, proAnnualCents: 5247 };

/** What Pro includes. The pricing cards, the checkout and the billing page all list the same things. */
export const PRO_FEATURES = [
  "Unlimited downloads, never a watermark",
  "All five templates, in your PDF",
  "Save your own templates and logo",
  "No branding footer",
  "Search, filters & CSV export",
] as const;

export function isInterval(v: string | null | undefined): v is Interval {
  return v === "monthly" || v === "annual";
}

/** `2026-12-24T04:00:00Z` -> `December 24, 2026`. */
export function longDate(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** When a subscription started today renews: one month or one year on. */
export function renewalDate(interval: Interval, from = new Date()) {
  const d = new Date(from);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + (interval === "annual" ? 12 : 1));
  // Jan 31 + 1 month is Feb 28/29, never March 3.
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}

export function longDateOf(d: Date) {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay", cartes_bancaires: "Cartes Bancaires" };

export function cardBrand(brand: string) {
  return BRANDS[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}
