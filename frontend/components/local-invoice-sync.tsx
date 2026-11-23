"use client";

import { useEffect } from "react";

import { useToast } from "@/components/toast";
import { useAuth } from "@/lib/auth";
import { importLocalInvoices } from "@/lib/local-invoices";

/** Renders nothing. When someone signs in (or signs up), the invoices they made as a guest, kept in this browser,
 *  are saved to their account, so "My Invoices" then shows everything in one place. */
export function LocalInvoiceSync() {
  const { user, isPro } = useAuth();
  const toast = useToast();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;
    void importLocalInvoices(isPro).then((moved) => {
      if (moved > 0) toast(`${moved === 1 ? "1 invoice" : `${moved} invoices`} from this browser ${moved === 1 ? "was" : "were"} saved to your account.`, "success");
    });
  }, [userId, isPro, toast]);

  return null;
}
