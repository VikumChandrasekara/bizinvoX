"use client";

import { AuthDialogProvider } from "@/components/auth/auth-dialog";
import { LocalInvoiceSync } from "@/components/local-invoice-sync";
import { ToastProvider } from "@/components/toast";
import { AuthProvider } from "@/lib/auth";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>
        <LocalInvoiceSync />
        <AuthDialogProvider>{children}</AuthDialogProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
