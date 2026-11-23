import type { Metadata } from "next";

import { MyInvoices } from "@/components/invoice/my-invoices";

export const metadata: Metadata = {
  title: "My Invoices",
  description: "Your invoices in one place: saved in this browser as a guest, or in your account when you're logged in.",
  alternates: { canonical: "/invoices" },
  // Personal page: nothing here is worth indexing.
  robots: { index: false, follow: true },
};

export default function InvoicesPage() {
  return <MyInvoices />;
}
