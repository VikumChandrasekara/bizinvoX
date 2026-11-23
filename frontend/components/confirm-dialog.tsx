"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Something the user must confirm before it happens. */
export type Confirmation = { title: string; description: React.ReactNode; confirmLabel: string; run: () => void | Promise<void> };

/** "Are you sure?" popup for anything that deletes or removes. Cancel is focused first, so Enter is the safe answer. */
export function ConfirmDialog({ confirmation, busy = false, onClose }: { confirmation: Confirmation | null; busy?: boolean; onClose: () => void }) {
  return (
    <Dialog open={confirmation !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md">
        {confirmation && (
          <>
            <DialogHeader>
              <DialogTitle>{confirmation.title}</DialogTitle>
              <DialogDescription>{confirmation.description}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" autoFocus onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  await confirmation.run();
                  onClose();
                }}
              >
                {busy && <Loader2 className="animate-spin" />} {confirmation.confirmLabel}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
