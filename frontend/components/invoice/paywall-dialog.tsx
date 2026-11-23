"use client";

import { Check, Crown, Download, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { formatCents } from "@/lib/utils";

export type Pricing = { downloadPriceCents: number; currency: string; proMonthlyCents: number; proAnnualCents: number };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Saves the invoice and returns its id (the checkout is tied to a saved invoice). */
  ensureSaved: () => Promise<string>;
  /** Downloads the watermarked PDF, which is free. */
  onDownloadFree: () => void;
};

/** Offered to Guest and Free users: pay once to take the watermark off this invoice's PDF. */
export function PaywallDialog({ open, onOpenChange, ensureSaved, onDownloadFree }: Props) {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !pricing) api<Pricing>("/api/v1/pricing").then(setPricing).catch(() => undefined);
  }, [open, pricing]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const id = await ensureSaved();
      const { url } = await api<{ url: string }>(`/api/v1/invoices/${id}/checkout`, { method: "POST" });
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const price = pricing ? formatCents(pricing.downloadPriceCents, pricing.currency) : "...";
  const monthly = pricing ? formatCents(pricing.proMonthlyCents, pricing.currency) : "...";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Sparkles className="size-5" />
          </div>
          <DialogTitle>Remove the watermark</DialogTitle>
          <DialogDescription>Free downloads carry a small repeating bizinvoX.com watermark. Pay once to get this invoice as a clean PDF. Secure checkout by Stripe.</DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border bg-muted/40 p-4">
          <div className="flex items-baseline justify-between">
            <span className="font-medium">No watermark, this invoice</span>
            <span className="font-display text-2xl font-bold">{price}</span>
          </div>
          <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            {["A clean, print-ready PDF of this invoice", "Download it again any time", "One-time payment, no subscription"].map((f) => (
              <li key={f} className="flex items-center gap-2">
                <Check className="size-4 text-brand-accent" /> {f}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">After payment the invoice is locked so the payment can&apos;t be reused for a different invoice. You can duplicate it to make changes.</p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button size="lg" onClick={pay} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null} Pay {price} & remove watermark
        </Button>
        <Button variant="outline" onClick={onDownloadFree} disabled={busy}>
          <Download /> Download with watermark (free)
        </Button>

        <div className="flex items-center gap-3 rounded-xl border border-dashed p-3 text-sm">
          <Crown className="size-5 shrink-0 text-amber-500" />
          <p className="flex-1 text-muted-foreground">
            Invoicing regularly? <strong className="text-foreground">Pro</strong> removes the watermark from every invoice and adds all templates, from {monthly}/mo.
          </p>
          <Button asChild variant="link" size="sm" className="px-0">
            <a href="#pricing" onClick={() => onOpenChange(false)}>
              Upgrade
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
