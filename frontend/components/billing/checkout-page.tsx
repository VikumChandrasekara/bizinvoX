"use client";

import { AlertCircle, ArrowLeft, Check, CheckCircle2, Crown, FileText, Loader2, Lock, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useAuthUi } from "@/components/auth/auth-dialog";
import type { Pricing } from "@/components/invoice/paywall-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { FALLBACK_PRICING, longDateOf, PRO_FEATURES, renewalDate, type Interval } from "@/lib/billing";
import { cn, formatCents } from "@/lib/utils";

/** Where "Upgrade to Pro" lands. Everything is decided here (plan, account, what you pay and when) and then the
 *  card is entered on Stripe's own page, so card details never touch this site. */
export function CheckoutPage({ initialPlan, cancelled }: { initialPlan: Interval; cancelled: boolean }) {
  const { user, isPro, loading, refresh } = useAuth();
  const authUi = useAuthUi();
  const [pricing, setPricing] = useState<Pricing>(FALLBACK_PRICING);
  const [interval, setInterval] = useState<Interval>(initialPlan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(cancelled);
  // Computed after mount: it depends on the visitor's clock, which the server can't know.
  const [renews, setRenews] = useState("");

  useEffect(() => {
    api<Pricing>("/api/v1/pricing").then(setPricing).catch(() => undefined);
  }, []);
  useEffect(() => setRenews(longDateOf(renewalDate(interval))), [interval]);

  const cur = pricing.currency;
  const monthly = pricing.proMonthlyCents;
  const yearly = pricing.proAnnualCents;
  const yearlySaving = Math.max(0, monthly * 12 - yearly);
  const savingPct = monthly > 0 ? Math.round((yearlySaving / (monthly * 12)) * 100) : 0;
  const total = interval === "annual" ? yearly : monthly;
  const period = interval === "annual" ? "year" : "month";

  function choose(next: Interval) {
    setInterval(next);
    setError(null);
    window.history.replaceState(null, "", `/checkout?plan=${next}`);
  }

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/v1/billing/subscribe", { method: "POST", json: { interval } });
      window.location.assign(url);
    } catch (err) {
      // Pro already (another tab, or the webhook just landed): show the page that says so.
      if (err instanceof ApiError && err.code === "already_pro") void refresh();
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
      <div className="mx-auto max-w-5xl">
        <Link href="/#pricing" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground">
          <ArrowLeft className="size-4" /> Back to pricing
        </Link>
        <h1 className="mt-4 font-display text-3xl font-bold tracking-tight sm:text-4xl">Upgrade to Pro</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">Every invoice without a watermark, all the templates, and your own saved designs. Cancel any time.</p>

        {showCancelled && (
          <div role="status" className="mt-6 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p className="flex-1">
              <strong>Checkout cancelled.</strong> You haven&apos;t been charged. Your choices are still here whenever you&apos;re ready.
            </p>
            <button type="button" onClick={() => setShowCancelled(false)} className="text-muted-foreground underline-offset-4 hover:underline">
              Dismiss
            </button>
          </div>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:gap-x-10">
          {/* 1. plan */}
          <section aria-labelledby="step-plan" className="lg:col-start-1">
            <StepHeading n={1} id="step-plan">
              Choose how you pay
            </StepHeading>
            <div
              role="radiogroup"
              aria-labelledby="step-plan"
              className="mt-4 grid gap-4 sm:grid-cols-2"
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  choose(interval === "annual" ? "monthly" : "annual");
                }
              }}
            >
              <PlanOption
                selected={interval === "annual"}
                onSelect={() => choose("annual")}
                title="Yearly"
                price={formatCents(Math.round(yearly / 12), cur)}
                detail={`Billed ${formatCents(yearly, cur)} once a year`}
                badge={savingPct > 0 ? `Save ${savingPct}%` : undefined}
              />
              <PlanOption selected={interval === "monthly"} onSelect={() => choose("monthly")} title="Monthly" price={formatCents(monthly, cur)} detail="Billed every month" />
            </div>
          </section>

          {/* order summary: right column on desktop, right after the plan on a phone */}
          <aside aria-label="Order summary" className="lg:col-start-2 lg:row-span-3 lg:row-start-1">
            <div className="rounded-2xl border bg-card p-6 shadow-sm lg:sticky lg:top-28">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Order summary</h2>
                <Badge variant="pro">PRO</Badge>
              </div>

              <dl className="mt-5 space-y-3 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <dt>
                    <span className="font-medium">bizinvoX Pro</span>
                    <span className="block text-muted-foreground">{interval === "annual" ? "Yearly plan" : "Monthly plan"}</span>
                  </dt>
                  <dd className="font-medium">{formatCents(total, cur)}</dd>
                </div>
                {interval === "annual" && yearlySaving > 0 && (
                  <div className="flex items-start justify-between gap-4 text-brand-accent">
                    <dt>Saving vs. paying monthly</dt>
                    <dd className="font-medium">{formatCents(yearlySaving, cur)}</dd>
                  </div>
                )}
              </dl>

              <div className="my-4 h-px bg-border" />
              <div className="flex items-baseline justify-between">
                <span className="font-medium">Due today</span>
                <span className="font-display text-3xl font-bold">{formatCents(total, cur)}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {renews ? `Renews on ${renews} at ` : "Then "}
                {formatCents(total, cur)} per {period} until you cancel. Taxes, if any, are shown on the payment page before you pay.
              </p>

              <div className="mt-5">
                {loading ? (
                  <Skeleton className="h-12 w-full rounded-xl" />
                ) : isPro ? (
                  <Link href="/billing" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
                    <Crown /> You&apos;re on Pro: manage it
                  </Link>
                ) : user ? (
                  <Button size="lg" className="w-full" onClick={pay} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" /> : <Lock />} Continue to secure payment
                  </Button>
                ) : (
                  <>
                    <Button size="lg" className="w-full" onClick={() => authUi.open("signup")}>
                      <Crown /> Create a free account to continue
                    </Button>
                    <p className="mt-3 text-center text-sm text-muted-foreground">
                      Already have one?{" "}
                      <button type="button" onClick={() => authUi.open("login")} className="font-medium text-primary underline-offset-4 hover:underline">
                        Log in
                      </button>
                    </p>
                  </>
                )}
              </div>

              {error && (
                <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
                </p>
              )}

              <ul className="mt-5 space-y-2 border-t pt-4 text-xs text-muted-foreground">
                <li className="flex items-center gap-2">
                  <Lock className="size-3.5 shrink-0" /> Encrypted checkout by Stripe
                </li>
                <li className="flex items-center gap-2">
                  <RefreshCw className="size-3.5 shrink-0" /> Cancel any time, keep Pro until the period ends
                </li>
                <li className="flex items-center gap-2">
                  <FileText className="size-3.5 shrink-0" /> A receipt is emailed for every payment
                </li>
              </ul>
              <p className="mt-4 text-xs text-muted-foreground">
                By continuing you agree to our{" "}
                <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
                  Terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
                  Privacy Policy
                </Link>
                .
              </p>
            </div>
          </aside>

          {/* 2. account, 3. payment */}
          <div className="space-y-8 lg:col-start-1">
            <section aria-labelledby="step-account">
              <StepHeading n={2} id="step-account">
                Your account
              </StepHeading>
              <div className="mt-4 rounded-2xl border bg-card p-5">
                {loading ? (
                  <Skeleton className="h-10 w-2/3" />
                ) : isPro ? (
                  <div className="flex items-start gap-3">
                    <Crown className="mt-0.5 size-5 shrink-0 text-amber-500" />
                    <div className="text-sm">
                      <p className="font-medium">{user?.email} is already on Pro.</p>
                      <p className="mt-1 text-muted-foreground">There&apos;s nothing to buy. You can see your plan, receipts and renewal date on the billing page.</p>
                    </div>
                  </div>
                ) : user ? (
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand-accent" />
                    <div className="text-sm">
                      <p className="font-medium">Signed in as {user.email}</p>
                      <p className="mt-1 text-muted-foreground">Pro is added to this account the moment your payment goes through, and your saved invoices stay exactly as they are.</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-muted-foreground">
                      <strong className="text-foreground">Pro belongs to an account</strong>, so it follows you to any device and your invoices are saved. It&apos;s free to create one.
                    </p>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="outline" onClick={() => authUi.open("login")}>
                        Log in
                      </Button>
                      <Button onClick={() => authUi.open("signup")}>Sign up</Button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section aria-labelledby="step-payment">
              <StepHeading n={3} id="step-payment">
                Pay securely with Stripe
              </StepHeading>
              <div className="mt-4 rounded-2xl border bg-card p-5 text-sm">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-accent" />
                  <ul className="space-y-2 text-muted-foreground">
                    <li>
                      <strong className="text-foreground">You enter your card on Stripe&apos;s page, not ours.</strong> We never see or store your card details.
                    </li>
                    <li>Have a promo code? There&apos;s a field for it on the payment page.</li>
                    <li>Afterwards you&apos;re brought straight back here to see your plan.</li>
                  </ul>
                </div>
              </div>
            </section>
          </div>

          {/* what you get + FAQ */}
          <div className="space-y-8 lg:col-start-1">
            <section aria-labelledby="included">
              <h2 id="included" className="text-lg font-semibold">
                Everything in Pro
              </h2>
              <ul className="mt-4 grid gap-3 rounded-2xl border bg-card p-5 text-sm sm:grid-cols-2">
                {PRO_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-brand-accent" /> {f}
                  </li>
                ))}
                <li className="flex items-start gap-2 text-muted-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-brand-accent" /> Plus everything in the free plan
                </li>
              </ul>
            </section>

            <section aria-labelledby="faq-billing">
              <h2 id="faq-billing" className="text-lg font-semibold">
                Billing questions
              </h2>
              <div className="mt-4 divide-y rounded-2xl border bg-card">
                <Faq q="When will I be charged?">Today, as soon as you complete payment on Stripe. After that your card is charged automatically every {period} until you cancel. Stripe emails a receipt each time.</Faq>
                <Faq q="Can I cancel whenever I want?">Yes. Open Manage subscription from your account menu and cancel in two clicks. You keep Pro until the end of the period you&apos;ve already paid for and you won&apos;t be charged again.</Faq>
                <Faq q="What happens to my invoices if I cancel?">
                  Nothing is deleted. Your account goes back to Free: your invoices and saved templates are kept but locked until you resubscribe, and PDFs carry the watermark again (you can remove it per invoice for {formatCents(pricing.downloadPriceCents, cur)}).
                </Faq>
                <Faq q="Do you store my card?">No. Card details go straight to Stripe, our payment processor. We only keep your plan, renewal date and the last four digits and brand of your card so you can recognise it.</Faq>
                <Faq q="What about refunds?">
                  The refund policy is in our{" "}
                  <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
                    Terms
                  </Link>
                  . If you were charged by mistake, contact us and we&apos;ll put it right.
                </Faq>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function StepHeading({ n, id, children }: { n: number; id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="flex items-center gap-3 text-lg font-semibold">
      <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
        {n}
      </span>
      {children}
    </h2>
  );
}

function PlanOption({ selected, onSelect, title, price, detail, badge }: { selected: boolean; onSelect: () => void; title: string; price: string; detail: string; badge?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn("relative rounded-2xl border bg-card p-5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", selected ? "border-primary bg-primary/5 ring-2 ring-primary/25" : "hover:border-primary/40")}
    >
      {badge && (
        <Badge variant="pro" className="absolute -top-3 right-4">
          {badge}
        </Badge>
      )}
      <span className="flex items-center justify-between">
        <span className="font-medium">{title}</span>
        <span aria-hidden className={cn("flex size-5 items-center justify-center rounded-full border-2", selected ? "border-primary" : "border-muted-foreground/40")}>
          {selected && <span className="size-2.5 rounded-full bg-primary" />}
        </span>
      </span>
      <span className="mt-3 block font-display text-3xl font-bold">
        {price}
        <span className="text-base font-normal text-muted-foreground"> / month</span>
      </span>
      <span className="mt-1 block text-sm text-muted-foreground">{detail}</span>
    </button>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group px-5 py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium [&::-webkit-details-marker]:hidden">
        {q}
        <span aria-hidden className="text-muted-foreground transition group-open:rotate-45">
          +
        </span>
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </details>
  );
}
