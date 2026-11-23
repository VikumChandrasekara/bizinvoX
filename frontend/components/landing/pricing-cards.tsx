"use client";

import { Check, Crown, Loader2, Minus } from "lucide-react";
import { useEffect, useState } from "react";

import { useAuthUi } from "@/components/auth/auth-dialog";
import type { Pricing } from "@/components/invoice/paywall-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatCents } from "@/lib/utils";

const FALLBACK: Pricing = { downloadPriceCents: 99, currency: "USD", proMonthlyCents: 599, proAnnualCents: 5247 };

export function PricingCards() {
  const { user, isPro } = useAuth();
  const authUi = useAuthUi();
  const [pricing, setPricing] = useState<Pricing>(FALLBACK);
  const [interval, setInterval] = useState<"monthly" | "annual">("annual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Pricing>("/api/v1/pricing").then(setPricing).catch(() => undefined);
  }, []);

  async function upgrade() {
    if (!user) return authUi.open("signup");
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/v1/billing/subscribe", { method: "POST", json: { interval } });
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function manage() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/v1/billing/portal", { method: "POST" });
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const cur = pricing.currency;
  const proPrice = interval === "annual" ? formatCents(Math.round(pricing.proAnnualCents / 12), cur) : formatCents(pricing.proMonthlyCents, cur);
  const saving = pricing.proMonthlyCents > 0 ? Math.round((1 - pricing.proAnnualCents / (pricing.proMonthlyCents * 12)) * 100) : 0;

  return (
    <div>
      <div className="mb-8 flex justify-center">
        <div role="radiogroup" aria-label="Billing interval" className="inline-flex rounded-full border bg-muted p-1 text-sm">
          {(["monthly", "annual"] as const).map((i) => (
            <button key={i} role="radio" aria-checked={interval === i} onClick={() => setInterval(i)} className={cn("rounded-full px-4 py-1.5 capitalize transition", interval === i ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>
              {i}
              {i === "annual" && saving > 0 && <span className="ml-1.5 text-xs text-brand-accent">-{saving}%</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Plan
          name="Guest"
          price="Free"
          sub={`Remove the watermark for ${formatCents(pricing.downloadPriceCents, cur)} per invoice`}
          cta={
            <Button asChild variant="outline" className="w-full">
              <a href="#create">Start an invoice</a>
            </Button>
          }
          features={[["Classic template, fully customizable", true], ["Your logo, colors, fonts & fields", true], ["Free PDF downloads, with a watermark", true], ["Save invoices to an account", false], ["Other templates & no watermark", false]]}
        />
        <Plan
          name="Free account"
          price="Free"
          sub={`Remove the watermark for ${formatCents(pricing.downloadPriceCents, cur)} per invoice`}
          cta={
            user ? (
              <Button variant="outline" className="w-full" disabled>
                {isPro ? "Included in Pro" : "You're on this plan"}
              </Button>
            ) : (
              <Button variant="outline" className="w-full" onClick={() => authUi.open("signup")}>
                Create free account
              </Button>
            )
          }
          features={[["Everything in Guest", true], ["Invoices saved to your account", true], ["Reuse your business details", true], ["Search, filter & CSV export", false], ["Other templates & no watermark", false]]}
        />
        <Plan
          highlight
          name="Pro"
          price={proPrice}
          sub={interval === "annual" ? `per month, billed ${formatCents(pricing.proAnnualCents, cur)} yearly` : "per month"}
          cta={
            isPro ? (
              <Button className="w-full" onClick={manage} disabled={busy}>
                {busy && <Loader2 className="animate-spin" />} Manage subscription
              </Button>
            ) : (
              <Button className="w-full" onClick={upgrade} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Crown />} Upgrade to Pro
              </Button>
            )
          }
          features={[["Unlimited downloads, never a watermark", true], ["All five templates, in your PDF", true], ["Save your own templates and logo", true], ["No branding footer", true], ["Search, filters & CSV export", true]]}
        />
      </div>
      {error && (
        <p role="alert" className="mt-4 text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Plan({ name, price, sub, features, cta, highlight = false }: { name: string; price: string; sub: string; features: [string, boolean][]; cta: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={cn("relative flex flex-col rounded-2xl border bg-card p-6 transition hover:-translate-y-0.5 hover:shadow-lg", highlight && "border-primary/50 shadow-xl shadow-primary/10 ring-1 ring-primary/20")}>
      {highlight && (
        <Badge variant="pro" className="absolute -top-3 left-6">
          Most popular
        </Badge>
      )}
      <h3 className="text-lg font-semibold">{name}</h3>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-display text-4xl font-bold">{price}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{sub}</p>
      <ul className="my-6 flex-1 space-y-2.5 text-sm">
        {features.map(([f, ok]) => (
          <li key={f} className={cn("flex items-start gap-2", !ok && "text-muted-foreground/70")}>
            {ok ? <Check className="mt-0.5 size-4 shrink-0 text-brand-accent" /> : <Minus className="mt-0.5 size-4 shrink-0" />} {f}
          </li>
        ))}
      </ul>
      {cta}
    </div>
  );
}
