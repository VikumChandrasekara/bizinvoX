"use client";

import { AlertCircle, ArrowUpRight, Check, CheckCircle2, CreditCard, Crown, ExternalLink, Loader2, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAuthUi } from "@/components/auth/auth-dialog";
import type { Pricing } from "@/components/invoice/paywall-dialog";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cardBrand, FALLBACK_PRICING, longDate, PRO_FEATURES, type PaymentRecord, type Subscription } from "@/lib/billing";
import { SUPPORT_EMAIL } from "@/lib/site";
import { cn, formatCents } from "@/lib/utils";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The Manage subscription page: plan and status, renewal, card, usage, receipts, and cancel / resume.
 *  `checkoutSessionId` is set when Stripe has just sent the customer back from paying. */
export function ManageSubscription({ checkoutSessionId }: { checkoutSessionId: string | null }) {
  const { user, loading: authLoading, refresh } = useAuth();
  const authUi = useAuthUi();
  const toast = useToast();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pricing, setPricing] = useState<Pricing>(FALLBACK_PRICING);
  // The return from Stripe: waiting for the payment to be confirmed, then a welcome (or a "taking a while" note).
  const [returning, setReturning] = useState<"confirming" | "welcome" | "slow" | "failed" | null>(checkoutSessionId ? "confirming" : null);
  const [busy, setBusy] = useState<"portal" | "cancel" | "resume" | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const started = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSub(await api<Subscription>("/api/v1/billing/subscription"));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    api<Pricing>("/api/v1/pricing").then(setPricing).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (authLoading || !user || started.current) return;
    started.current = true;
    if (!checkoutSessionId) {
      void load();
      return;
    }
    // Stripe redirected back. Ask the server to check the payment with Stripe (it never trusts the redirect),
    // retrying briefly in case Stripe is still finishing up.
    (async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          setSub(await api<Subscription>("/api/v1/billing/confirm", { method: "POST", json: { sessionId: checkoutSessionId } }));
          setReturning("welcome");
          window.history.replaceState(null, "", "/billing");
          void refresh();
          return;
        } catch (err) {
          if (err instanceof ApiError && err.code === "payment_pending") {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          setReturning("failed");
          window.history.replaceState(null, "", "/billing");
          await load();
          return;
        }
      }
      setReturning("slow");
      window.history.replaceState(null, "", "/billing");
      await load();
    })();
  }, [authLoading, user, checkoutSessionId, load, refresh]);

  async function openPortal() {
    setBusy("portal");
    try {
      const { url } = await api<{ url: string }>("/api/v1/billing/portal", { method: "POST" });
      window.location.assign(url);
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(null);
    }
  }

  async function setCancellation(cancel: boolean) {
    setBusy(cancel ? "cancel" : "resume");
    setCancelError(null);
    try {
      const next = await api<Subscription>(`/api/v1/billing/${cancel ? "cancel" : "resume"}`, { method: "POST" });
      setSub(next);
      setCancelOpen(false);
      toast(cancel ? `Your subscription will end on ${longDate(next.renewsAt)}. You keep Pro until then.` : `Welcome back! Your subscription renews on ${longDate(next.renewsAt)}.`, "success");
      void refresh();
    } catch (err) {
      if (cancel) setCancelError(errorMessage(err));
      else toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
      <div className="mx-auto max-w-4xl">
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Billing &amp; subscription</h1>
        <p className="mt-2 text-muted-foreground">Your plan, payment method and receipts in one place.</p>

        <div className="mt-8">
          {authLoading ? (
            <PageSkeleton />
          ) : !user ? (
            <SignedOut onLogin={() => authUi.open("login")} onSignup={() => authUi.open("signup")} />
          ) : loadError && !sub ? (
            <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-sm">
              <p className="flex items-center gap-2 font-medium text-destructive">
                <AlertCircle className="size-4" /> {loadError}
              </p>
              <Button variant="outline" className="mt-4" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : !sub || returning === "confirming" ? (
            <>
              {returning === "confirming" && (
                <div role="status" className="mb-6 flex items-center gap-3 rounded-xl border bg-card p-4 text-sm">
                  <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
                  <div>
                    <p className="font-medium">Confirming your payment...</p>
                    <p className="text-muted-foreground">This only takes a few seconds. Please don&apos;t close this page.</p>
                  </div>
                </div>
              )}
              <PageSkeleton />
            </>
          ) : (
            <div className="space-y-6">
              <Notices sub={sub} returning={returning} onDismiss={() => setReturning(null)} onPortal={() => void openPortal()} onReload={() => void load()} portalBusy={busy === "portal"} />

              {sub.plan === "pro" ? (
                <ProPlanCard sub={sub} email={user.email} busy={busy} onPortal={() => void openPortal()} onCancel={() => setCancelOpen(true)} onResume={() => void setCancellation(false)} />
              ) : (
                <FreePlanCard sub={sub} pricing={pricing} busy={busy === "portal"} onPortal={() => void openPortal()} />
              )}

              <div className="grid gap-6 md:grid-cols-2">
                <UsageCard sub={sub} />
                <BenefitsCard pro={sub.plan === "pro"} />
              </div>

              <PaymentHistory payments={sub.payments} email={user.email} />

              <p className="text-center text-sm text-muted-foreground">
                Questions about a charge?{" "}
                {SUPPORT_EMAIL ? (
                  <>
                    Email{" "}
                    <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4 hover:text-foreground">
                      {SUPPORT_EMAIL}
                    </a>
                    .{" "}
                  </>
                ) : null}
                Read the{" "}
                <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
                  Terms
                </Link>{" "}
                for how refunds and cancellations work.
              </p>
            </div>
          )}
        </div>
      </div>

      <Dialog open={cancelOpen} onOpenChange={(o) => !o && busy !== "cancel" && setCancelOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel your Pro subscription?</DialogTitle>
            <DialogDescription>You can change your mind any time before it ends.</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2 text-sm">
            {[
              sub?.renewsAt ? `You keep Pro until ${longDate(sub.renewsAt)}.` : "You keep Pro until the end of the period you've paid for.",
              "You won't be charged again.",
              "Your invoices and saved templates are kept, but locked until you resubscribe.",
              "After that, PDFs carry the watermark again.",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-brand-accent" /> {t}
              </li>
            ))}
          </ul>
          {cancelError && (
            <p role="alert" className="text-sm text-destructive">
              {cancelError}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="destructive" onClick={() => void setCancellation(true)} disabled={busy === "cancel"}>
              {busy === "cancel" && <Loader2 className="animate-spin" />} Cancel subscription
            </Button>
            <Button autoFocus onClick={() => setCancelOpen(false)} disabled={busy === "cancel"}>
              Keep Pro
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

/* ----------------------------------------------------------------------------------------------- */

function Notices({ sub, returning, onDismiss, onPortal, onReload, portalBusy }: { sub: Subscription; returning: "confirming" | "welcome" | "slow" | "failed" | null; onDismiss: () => void; onPortal: () => void; onReload: () => void; portalBusy: boolean }) {
  return (
    <>
      {returning === "welcome" && sub.plan === "pro" && (
        <div role="status" className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-brand-accent" />
            <div className="flex-1">
              <h2 className="font-semibold">Welcome to Pro!</h2>
              <p className="mt-1 text-sm text-muted-foreground">Your payment went through and everything is unlocked: no watermark, all the templates, and your own saved designs. A receipt is on its way to your inbox.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href="/#create" className={buttonVariants({ size: "sm" })}>
                  Start an invoice
                </Link>
                <Link href="/?dialog=templates" className={buttonVariants({ size: "sm", variant: "outline" })}>
                  Browse templates
                </Link>
              </div>
            </div>
            <button type="button" onClick={onDismiss} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
              Dismiss
            </button>
          </div>
        </div>
      )}
      {returning === "slow" && sub.plan !== "pro" && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-amber-600" />
          <p className="flex-1">
            <strong>Your payment is still being processed.</strong> Pro switches on as soon as Stripe confirms it, usually within a minute. You don&apos;t need to pay again.
          </p>
          <Button size="sm" variant="outline" onClick={onReload}>
            Check again
          </Button>
        </div>
      )}
      {returning === "failed" && sub.plan !== "pro" && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="flex-1">
            <strong>We couldn&apos;t confirm that payment.</strong> If you were charged, Pro will appear here shortly. Otherwise nothing was taken and you can try again.
          </p>
        </div>
      )}
      {sub.plan === "pro" && sub.status === "past_due" && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center">
          <p className="flex flex-1 items-start gap-3">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>
              <strong>Your last payment didn&apos;t go through.</strong> Update your card so Pro isn&apos;t interrupted. Stripe will retry the payment automatically.
            </span>
          </p>
          <Button size="sm" onClick={onPortal} disabled={portalBusy}>
            {portalBusy ? <Loader2 className="animate-spin" /> : <CreditCard />} Update payment method
          </Button>
        </div>
      )}
      {sub.plan === "pro" && sub.cancelAtPeriodEnd && sub.renewsAt && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p>
            <strong>Your subscription is set to end on {longDate(sub.renewsAt)}.</strong> You keep Pro until then and won&apos;t be charged again. Changed your mind? Resume it below.
          </p>
        </div>
      )}
      {!sub.paymentsConfigured && (
        <div role="status" className="flex items-start gap-3 rounded-xl border bg-muted/50 p-4 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <p>Online payments aren&apos;t switched on for this server, so subscribing and card changes are unavailable here.</p>
        </div>
      )}
    </>
  );
}

function StatusBadge({ sub }: { sub: Subscription }) {
  if (sub.plan !== "pro") return <Badge variant="draft">Free</Badge>;
  if (sub.cancelAtPeriodEnd && sub.renewsAt) return <Badge variant="paid">Ends {shortDate(sub.renewsAt)}</Badge>;
  if (sub.status === "past_due") return <Badge className="border-transparent bg-red-500/15 text-red-700">Payment failed</Badge>;
  if (sub.status === "trialing") return <Badge>Trial</Badge>;
  return <Badge variant="downloaded">Active</Badge>;
}

function ProPlanCard({ sub, email, busy, onPortal, onCancel, onResume }: { sub: Subscription; email: string; busy: "portal" | "cancel" | "resume" | null; onPortal: () => void; onCancel: () => void; onResume: () => void }) {
  const cur = sub.currency ?? "USD";
  const yearly = sub.interval === "annual";
  const price = sub.amountCents != null ? formatCents(sub.amountCents, cur) : null;
  const ending = sub.cancelAtPeriodEnd;
  return (
    <section aria-labelledby="plan-heading" className="rounded-2xl border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-emerald-500 text-white">
            <Crown className="size-5" />
          </span>
          <div>
            <h2 id="plan-heading" className="text-lg font-semibold">
              Pro{sub.interval ? ` · ${yearly ? "Yearly" : "Monthly"}` : ""}
            </h2>
            <p className="text-sm text-muted-foreground">Your current plan</p>
          </div>
        </div>
        <StatusBadge sub={sub} />
      </div>

      {price && (
        <p className="mt-5 font-display text-3xl font-bold">
          {price}
          <span className="text-base font-normal text-muted-foreground"> / {yearly ? "year" : "month"}</span>
          {yearly && sub.amountCents != null && <span className="ml-3 text-sm font-normal text-muted-foreground">({formatCents(Math.round(sub.amountCents / 12), cur)} a month)</span>}
        </p>
      )}

      <dl className="mt-6 grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
        {sub.renewsAt && (
          <Fact label={ending ? "Pro ends on" : "Next payment"}>
            {longDate(sub.renewsAt)}
            {!ending && price ? <span className="text-muted-foreground"> · {price}</span> : null}
          </Fact>
        )}
        {sub.startedAt && <Fact label="Pro member since">{longDate(sub.startedAt)}</Fact>}
        <Fact label="Payment method">
          {sub.card ? (
            <>
              {cardBrand(sub.card.brand)} •••• {sub.card.last4}
              <span className="text-muted-foreground"> · expires {String(sub.card.expMonth).padStart(2, "0")}/{sub.card.expYear}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Held securely by Stripe</span>
          )}
        </Fact>
        <Fact label="Receipts are sent to">{email}</Fact>
      </dl>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t pt-5">
        <Button variant="outline" onClick={onPortal} disabled={busy !== null || !sub.hasBillingAccount}>
          {busy === "portal" ? <Loader2 className="animate-spin" /> : <CreditCard />} Payment method &amp; billing details
          <ArrowUpRight className="opacity-60" />
        </Button>
        {ending ? (
          <Button onClick={onResume} disabled={busy !== null}>
            {busy === "resume" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Resume subscription
          </Button>
        ) : (
          <Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onCancel} disabled={busy !== null}>
            Cancel subscription
          </Button>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Payment details open on Stripe&apos;s secure page. You&apos;ll come straight back here afterwards.</p>
    </section>
  );
}

function FreePlanCard({ sub, pricing, busy, onPortal }: { sub: Subscription; pricing: Pricing; busy: boolean; onPortal: () => void }) {
  const ended = sub.hasBillingAccount && sub.status === "canceled";
  const cur = pricing.currency;
  return (
    <section aria-labelledby="plan-heading" className="rounded-2xl border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="plan-heading" className="text-lg font-semibold">
            {ended ? "Your Pro subscription has ended" : "Free plan"}
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {ended
              ? "You're on the Free plan now. Your invoices and saved templates are kept, and they unlock again the moment you resubscribe."
              : `Create and save invoices for free. PDFs carry a small watermark, which you can remove for ${formatCents(pricing.downloadPriceCents, cur)} per invoice, or for good with Pro.`}
          </p>
        </div>
        <StatusBadge sub={sub} />
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl bg-gradient-to-r from-indigo-600/10 to-emerald-500/10 p-4">
        <Sparkles className="size-5 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-sm">
          <strong>{ended ? "Come back to Pro" : "Upgrade to Pro"}</strong>
          <span className="text-muted-foreground">: from {formatCents(Math.round(pricing.proAnnualCents / 12), cur)} a month, billed yearly. Cancel any time.</span>
        </p>
        <Link href="/checkout" className={buttonVariants()}>
          <Crown /> {ended ? "Resubscribe" : "Upgrade to Pro"}
        </Link>
      </div>
      {sub.hasBillingAccount && (
        <div className="mt-4">
          <Button variant="outline" onClick={onPortal} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <CreditCard />} Billing details &amp; invoices
            <ArrowUpRight className="opacity-60" />
          </Button>
        </div>
      )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-medium">{children}</dd>
    </div>
  );
}

function UsageCard({ sub }: { sub: Subscription }) {
  const pro = sub.plan === "pro";
  const rows: [string, React.ReactNode][] = [
    ["Invoices saved", sub.usage.invoices],
    ["Saved templates", pro ? sub.usage.templates : <span className="text-muted-foreground">Pro only</span>],
    ["PDF downloads", pro ? "Unlimited, no watermark" : <span className="text-muted-foreground">Free, watermarked</span>],
  ];
  return (
    <section aria-labelledby="usage-heading" className="rounded-2xl border bg-card p-6">
      <h2 id="usage-heading" className="font-semibold">
        Your usage
      </h2>
      <dl className="mt-4 divide-y text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href="/invoices" className="text-primary underline-offset-4 hover:underline">
          My Invoices
        </Link>
        <Link href="/recycle-bin" className="text-primary underline-offset-4 hover:underline">
          Recycle bin
        </Link>
      </div>
    </section>
  );
}

function BenefitsCard({ pro }: { pro: boolean }) {
  return (
    <section aria-labelledby="benefits-heading" className="rounded-2xl border bg-card p-6">
      <h2 id="benefits-heading" className="font-semibold">
        {pro ? "Included in your plan" : "What you get with Pro"}
      </h2>
      <ul className="mt-4 space-y-2.5 text-sm">
        {PRO_FEATURES.map((f) => (
          <li key={f} className={cn("flex items-start gap-2", !pro && "text-muted-foreground")}>
            <Check className={cn("mt-0.5 size-4 shrink-0", pro ? "text-brand-accent" : "text-muted-foreground/60")} /> {f}
          </li>
        ))}
      </ul>
    </section>
  );
}

const PAYMENT_STATUS: Record<PaymentRecord["status"], { label: string; variant: "downloaded" | "draft" | "paid" }> = {
  succeeded: { label: "Paid", variant: "downloaded" },
  refunded: { label: "Refunded", variant: "draft" },
  pending: { label: "Pending", variant: "paid" },
  failed: { label: "Failed", variant: "paid" },
};

/** Only ever link to a Stripe-hosted https receipt. */
const safeReceipt = (url: string | null) => (url && url.startsWith("https://") ? url : null);

function PaymentHistory({ payments, email }: { payments: PaymentRecord[]; email: string }) {
  return (
    <section aria-labelledby="history-heading" className="rounded-2xl border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="history-heading" className="font-semibold">
          Payment history
        </h2>
        <p className="text-xs text-muted-foreground">Stripe emails a receipt to {email} for every payment.</p>
      </div>

      {payments.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No payments yet. Watermark removals and Pro payments will be listed here.</p>
      ) : (
        <>
          <table className="mt-4 hidden w-full text-sm sm:table">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="pb-2 font-medium">
                  Date
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Description
                </th>
                <th scope="col" className="pb-2 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="pb-2 pl-4 font-medium">
                  Status
                </th>
                <th scope="col" className="pb-2 text-right font-medium">
                  Receipt
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {payments.map((p) => {
                const s = PAYMENT_STATUS[p.status];
                const receipt = safeReceipt(p.receiptUrl);
                return (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap py-3 pr-4">{shortDate(p.createdAt)}</td>
                    <td className="py-3 pr-4">{p.description}</td>
                    <td className={cn("whitespace-nowrap py-3 text-right font-medium", p.status === "refunded" && "text-muted-foreground line-through")}>{formatCents(p.amountCents, p.currency)}</td>
                    <td className="py-3 pl-4">
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </td>
                    <td className="py-3 text-right">
                      {receipt ? (
                        <a href={receipt} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                          View <ExternalLink className="size-3.5" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">Emailed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <ul className="mt-4 divide-y sm:hidden">
            {payments.map((p) => {
              const s = PAYMENT_STATUS[p.status];
              const receipt = safeReceipt(p.receiptUrl);
              return (
                <li key={p.id} className="py-3 text-sm first:pt-0">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium">{p.description}</span>
                    <span className={cn("shrink-0 font-medium", p.status === "refunded" && "text-muted-foreground line-through")}>{formatCents(p.amountCents, p.currency)}</span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-3 text-muted-foreground">
                    <span>{shortDate(p.createdAt)}</span>
                    <span className="flex items-center gap-3">
                      <Badge variant={s.variant}>{s.label}</Badge>
                      {receipt && (
                        <a href={receipt} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                          Receipt <ExternalLink className="size-3.5" />
                        </a>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function SignedOut({ onLogin, onSignup }: { onLogin: () => void; onSignup: () => void }) {
  return (
    <div className="rounded-2xl border bg-card p-8 text-center">
      <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <CreditCard className="size-5" />
      </span>
      <h2 className="mt-4 text-lg font-semibold">Log in to manage your billing</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Your plan, payment method and receipts belong to your account. Log in, or create a free account, to see them.</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={onLogin}>Log in</Button>
        <Button variant="outline" onClick={onSignup}>
          Sign up
        </Button>
        <Link href="/checkout" className={buttonVariants({ variant: "ghost" })}>
          See Pro
        </Link>
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading your billing details">
      <Skeleton className="h-64 w-full rounded-2xl" />
      <div className="grid gap-6 md:grid-cols-2">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
      </div>
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  );
}
