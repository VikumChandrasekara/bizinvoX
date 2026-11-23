"use client";

import { CheckCircle2, Download, Loader2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAuthUi } from "@/components/auth/auth-dialog";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, apiFetch, ApiError, errorMessage, toApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { filenameFromResponse, saveBlob } from "@/lib/utils";

/** The site has one page, so everything Stripe and our emails link back to
 *  arrives as a query string on `/`. This component reads it once, acts on it,
 *  then cleans the address bar:
 *    ?checkout=success&invoice=..&session_id=..   confirm payment + download
 *    ?checkout=cancelled                          friendly notice
 *    ?billing=success                             subscription started
 *    ?verify=<token>                              confirm email address
 *    ?reset=<token>                               choose a new password */
export function UrlActions() {
  const { loading, refresh } = useAuth();
  const authUi = useAuthUi();
  const toast = useToast();
  const handled = useRef(false);
  const [checkout, setCheckout] = useState<{ invoiceId: string; sessionId: string } | null>(null);

  useEffect(() => {
    if (loading || handled.current) return;
    handled.current = true;
    const q = new URLSearchParams(window.location.search);
    const clean = () => window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);

    if (q.get("checkout") === "success" && q.get("invoice") && q.get("session_id")) {
      setCheckout({ invoiceId: q.get("invoice")!, sessionId: q.get("session_id")! });
      clean();
    } else if (q.get("checkout") === "cancelled") {
      // The editor has already read `?invoice=` by now (its effect runs first).
      toast("Checkout was cancelled. Your invoice is still here whenever you're ready.", "info");
      clean();
    } else if (q.get("billing") === "success") {
      toast("Welcome to Pro! Your plan is being activated.", "success");
      void refresh();
      // The Stripe webhook can land a moment after the redirect.
      setTimeout(() => void refresh(), 3000);
      clean();
    } else if (q.get("verify")) {
      const token = q.get("verify")!;
      clean();
      api("/api/v1/auth/verify-email", { method: "POST", json: { token } })
        .then(() => {
          toast("Email verified. Thank you!", "success");
          return refresh();
        })
        .catch((err) => toast(errorMessage(err), "error"));
    } else if (q.get("reset")) {
      const token = q.get("reset")!;
      clean();
      authUi.openReset(token);
    }
  }, [loading, refresh, authUi, toast]);

  return checkout ? <CheckoutReturn {...checkout} onClose={() => setCheckout(null)} /> : null;
}

/** Stripe sends the customer back here after a one-time download payment. We
 *  confirm the payment server-side (never trusting the redirect), receive a
 *  single-use token, and immediately exchange it for the PDF. */
function CheckoutReturn({ invoiceId, sessionId, onClose }: { invoiceId: string; sessionId: string; onClose: () => void }) {
  const [state, setState] = useState<"confirming" | "downloading" | "done" | "error">("confirming");
  const [error, setError] = useState("");
  const started = useRef(false);
  const toast = useToast();

  const run = useCallback(async () => {
    setError("");
    setState("confirming");
    let notice: number | undefined;
    try {
      // The webhook may land a moment after the redirect: retry "pending" briefly.
      let token = "";
      for (let attempt = 0; attempt < 6 && !token; attempt++) {
        try {
          const res = await api<{ downloadToken: string }>(`/api/v1/invoices/${invoiceId}/checkout/confirm`, { method: "POST", json: { sessionId } });
          token = res.downloadToken;
        } catch (err) {
          if (err instanceof ApiError && err.code === "payment_pending") await new Promise((r) => setTimeout(r, 1500));
          else throw err;
        }
      }
      if (!token) throw new Error("Payment is still processing. Please try again in a moment.");
      setState("downloading");
      // Same "Downloading" toast as every other download in the editor.
      notice = toast("Downloading 📥", "loading");
      const res = await apiFetch(`/api/v1/invoices/${invoiceId}/download`, { method: "POST", json: { token } });
      if (!res.ok) throw await toApiError(res);
      saveBlob(await res.blob(), filenameFromResponse(res, "invoice.pdf"));
      toast("Downloading 📥", "info", notice);
      setState("done");
      window.dispatchEvent(new CustomEvent("big:reload-invoice", { detail: { id: invoiceId } }));
    } catch (err) {
      setError(errorMessage(err));
      setState("error");
      if (notice !== undefined) toast(errorMessage(err), "error", notice);
    }
  }, [invoiceId, sessionId, toast]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  const Icon = state === "done" ? CheckCircle2 : state === "error" ? XCircle : Loader2;
  return (
    <Dialog open onOpenChange={(o) => !o && state !== "confirming" && state !== "downloading" && onClose()}>
      <DialogContent className="max-w-sm text-center">
        <DialogHeader className="items-center pr-0 text-center">
          <Icon className={state === "done" ? "size-12 text-brand-accent" : state === "error" ? "size-12 text-destructive" : "size-12 animate-spin text-primary"} />
          <DialogTitle className="mt-2">{state === "done" ? "Payment complete" : state === "error" ? "Something went wrong" : state === "downloading" ? "Preparing your PDF..." : "Confirming your payment..."}</DialogTitle>
          <DialogDescription>{state === "done" ? "Your watermark-free invoice PDF has been downloaded." : state === "error" ? error : "This only takes a moment."}</DialogDescription>
        </DialogHeader>
        {(state === "done" || state === "error") && (
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={() => void run()}>
              <Download /> Download again
            </Button>
            <Button onClick={onClose}>Back to invoice</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
