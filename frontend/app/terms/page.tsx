import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage, type LegalSection } from "@/components/legal-page";
import { SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description: `The terms that apply when you use ${SITE_NAME}.`,
  alternates: { canonical: "/terms" },
};

const sections: LegalSection[] = [
  {
    heading: "Agreement",
    body: (
      <p>
        By using {SITE_NAME} (the &quot;Service&quot;) you agree to these Terms &amp; Conditions and to our <Link href="/privacy">Privacy Policy</Link>. If you don&apos;t agree, please don&apos;t use the Service. If you use it for a business, you confirm you are allowed to accept these terms on its behalf.
      </p>
    ),
  },
  {
    heading: "The Service",
    body: (
      <p>
        The Service lets you create invoices in your browser and download them as PDF files. You can build and preview an invoice without paying. Downloads, saved invoices and custom templates depend on the plan described below.
      </p>
    ),
  },
  {
    heading: "Plans and what they include",
    body: (
      <ul>
        <li>
          <strong>Guest and Free.</strong> You can use and fully customize the Classic template (logo, colors, fonts, removing fields). Downloads are free, but the PDF carries a small repeating &quot;bizinvoX.com&quot; watermark and a small &quot;Created with bizinvoX.com&quot; line. You can remove the watermark from an invoice with a one-time payment. Other templates can be previewed but not edited or downloaded.
        </li>
        <li>
          <strong>Pro.</strong> A paid subscription that includes unlimited downloads with no watermark and no branding line, all templates, and saved templates and logo. It is billed monthly, or yearly at a discount.
        </li>
        <li>Prices and what&apos;s included are shown on the site and at checkout, and may change for future purchases.</li>
      </ul>
    ),
  },
  {
    heading: "Payments",
    body: (
      <>
        <p>Payments are processed securely by Stripe. We never see or store your card details.</p>
        <ul>
          <li>
            <strong>Watermark removal.</strong> One payment removes the watermark from one invoice&apos;s PDF, and you can download that invoice again. After payment the invoice is locked so the payment can&apos;t be reused for a different invoice. You can duplicate it to make changes.
          </li>
          <li>
            <strong>Pro subscription.</strong> It renews automatically each billing period until you cancel. You can manage or cancel it from the account menu (Manage subscription). If it ends, your account returns to Free, and your saved templates and invoices are kept but locked.
          </li>
          <li>Prices are shown at checkout. Taxes may be added where required.</li>
        </ul>
      </>
    ),
  },
  {
    heading: "Refunds",
    body: (
      <p>
        Because a PDF is a digital product delivered immediately, payments are generally not refundable once the file has been generated. If something went wrong, such as a charge without a working download, contact us and we will fix it or refund you. Nothing in these terms limits any refund right you have under the law.
      </p>
    ),
  },
  {
    heading: "Your account",
    body: (
      <ul>
        <li>Give accurate information and keep your password secure. You are responsible for activity on your account.</li>
        <li>Tell us promptly if you think your account has been accessed without permission.</li>
        <li>You must be at least 16 years old to create an account.</li>
      </ul>
    ),
  },
  {
    heading: "Your content",
    body: (
      <>
        <p>You keep ownership of everything you enter or upload, including invoice details and logos. You give us permission to store, process and render it only to provide the Service to you.</p>
        <p>You are responsible for your content, for having the right to use any logo or client information you add, and for the accuracy of every invoice you issue.</p>
      </>
    ),
  },
  {
    heading: "Not professional advice",
    body: (
      <p>
        The Service calculates totals, tax and discounts from the numbers you enter. It is a tool, not tax, legal or accounting advice. Check that your invoices meet the requirements that apply to your business and your country, such as tax identifiers and invoice numbering.
      </p>
    ),
  },
  {
    heading: "Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>use the Service for anything unlawful, fraudulent or misleading, including issuing invoices for goods or services that don&apos;t exist;</li>
          <li>upload content that is harmful, infringing or that you have no right to use;</li>
          <li>try to break, overload, scrape or reverse engineer the Service, or get around its limits and plan restrictions;</li>
          <li>access other people&apos;s accounts or data.</li>
        </ul>
        <p>We may limit or suspend access if these rules are broken.</p>
      </>
    ),
  },
  {
    heading: "Our property",
    body: <p>The Service, its design, templates and software belong to us or our licensors. These terms give you the right to use the Service, not to copy or resell it. The invoices you create are yours.</p>,
  },
  {
    heading: "Availability and changes",
    body: <p>We work to keep the Service available but do not promise it will always be uninterrupted or error-free. We may change, add or remove features, and we may update these terms. The date at the top shows the latest version. Continuing to use the Service after a change means you accept it.</p>,
  },
  {
    heading: "Disclaimer",
    body: <p>The Service is provided &quot;as is&quot; and &quot;as available&quot;. To the extent the law allows, we make no warranties, express or implied, including about fitness for a particular purpose or that invoices will be accepted by any tax authority or client.</p>,
  },
  {
    heading: "Limit of liability",
    body: (
      <p>
        To the extent the law allows, we are not liable for indirect or consequential losses, lost profits or lost data, and our total liability for any claim is limited to the amount you paid us in the 12 months before it arose. Nothing here excludes liability that cannot be excluded by law, such as for fraud or for death or personal injury caused by negligence.
      </p>
    ),
  },
  {
    heading: "Ending your use",
    body: <p>You can stop using the Service at any time, and cancel a Pro subscription as described above. We may suspend or end your access if you break these terms or misuse the Service. Sections that by their nature should continue, such as ownership, disclaimers and liability, continue after that.</p>,
  },
  {
    heading: "Governing law",
    body: <p>These terms are governed by the laws of the place where the operator of the Service is established, without affecting any mandatory consumer rights you have where you live.</p>,
  },
  {
    heading: "Contact",
    body: (
      <p>
        {SUPPORT_EMAIL ? (
          <>
            Questions about these terms? Email us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
          </>
        ) : (
          <>Questions about these terms? Contact us using the support details provided with your account or purchase receipt.</>
        )}
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms & Conditions"
      updated="23 November 2026"
      intro="These terms are the rules for using the invoice generator. They are written to be read, so please take a minute."
      sections={sections}
    />
  );
}
