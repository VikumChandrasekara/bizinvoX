"use client";

import { Download, Loader2, Sparkles } from "lucide-react";

import { InvoiceCanvas } from "@/components/editor/canvas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { BindCtx } from "@/lib/bindings";

/** The invoice shown as a normal page inside the popup (no PDF viewer, no server round trip).
 *  Guest/Free see the same tiled watermark the downloaded PDF carries, and choose at the top between
 *  paying to remove it or downloading free with it. Pro (and paid invoices) just get a Download button. */
export function InvoicePreviewDialog({
  open,
  ctx,
  logoUrl,
  branding,
  watermark,
  priceLabel,
  busy,
  onRemoveAndDownload,
  onDownload,
  onClose,
}: {
  open: boolean;
  ctx: BindCtx;
  logoUrl: string | null;
  branding: boolean;
  /** The invoice still carries the watermark (Guest/Free, not paid off). */
  watermark: boolean;
  priceLabel: string;
  busy: boolean;
  /** Starts the one-time payment that removes the watermark; the clean PDF is downloaded after checkout. */
  onRemoveAndDownload: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl grid-rows-[auto_1fr]">
        {/* The X in the corner closes the popup; the download choices sit at the top. */}
        <DialogHeader className="pr-8">
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>{watermark ? "This is how your downloaded invoice will look, including the watermark." : "This is how your downloaded invoice will look."}</DialogDescription>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {watermark ? (
              <>
                <Button variant="accent" size="sm" onClick={onRemoveAndDownload} disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Remove watermark &amp; download · {priceLabel}
                </Button>
                <Button variant="outline" size="sm" onClick={onDownload} disabled={busy}>
                  <Download /> Download FREE
                </Button>
              </>
            ) : (
              <Button variant="accent" size="sm" onClick={onDownload} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Download />} Download PDF
              </Button>
            )}
          </div>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto rounded-lg border bg-muted p-3 sm:p-5">
          {open && <InvoiceCanvas ctx={ctx} logoUrl={logoUrl} branding={branding} watermark={watermark} thumbnail />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
