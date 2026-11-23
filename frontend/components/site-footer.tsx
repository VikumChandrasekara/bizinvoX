import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { DialogLink } from "@/components/dialog-link";

export function SiteFooter() {
  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xs text-sm text-muted-foreground">Create professional invoices in under a minute. Free to build, pay only when you download, or go Pro.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <a href="/#create" className="transition hover:text-foreground">
            Create
          </a>
          <DialogLink name="templates" className="transition hover:text-foreground">
            Templates
          </DialogLink>
          <Link href="/invoices" className="transition hover:text-foreground">
            My Invoices
          </Link>
          <Link href="/recycle-bin" className="transition hover:text-foreground">
            Recycle bin
          </Link>
          <a href="/#pricing" className="transition hover:text-foreground">
            Pricing
          </a>
          <a href="/#faq" className="transition hover:text-foreground">
            FAQ
          </a>
          <Link href="/privacy" className="transition hover:text-foreground">
            Privacy Policy
          </Link>
          <Link href="/terms" className="transition hover:text-foreground">
            Terms &amp; Conditions
          </Link>
        </nav>
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-7xl px-4 py-5 text-xs text-muted-foreground sm:px-6">© {new Date().getFullYear()} bizinvoX.com. Payments are processed securely by Stripe.</p>
      </div>
    </footer>
  );
}
