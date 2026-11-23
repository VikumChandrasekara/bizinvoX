import type { Metadata } from "next";

import { RecycleBin } from "@/components/recycle-bin";

export const metadata: Metadata = {
  title: "Recycle bin",
  description: "Deleted invoices and templates wait here for 30 days, so you can restore them.",
  alternates: { canonical: "/recycle-bin" },
  // Personal page: nothing here is worth indexing.
  robots: { index: false, follow: true },
};

export default function RecycleBinPage() {
  return <RecycleBin />;
}
