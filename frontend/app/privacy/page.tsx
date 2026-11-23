import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage, type LegalSection } from "@/components/legal-page";
import { SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${SITE_NAME} collects, uses and protects your information.`,
  alternates: { canonical: "/privacy" },
};

const sections: LegalSection[] = [
  {
    heading: "Who we are",
    body: (
      <p>
        {SITE_NAME} (&quot;we&quot;, &quot;us&quot;) provides an online tool for creating invoices and downloading them as PDF files. This policy explains what information we handle when you use the site, and the choices you have.
      </p>
    ),
  },
  {
    heading: "Information we collect",
    body: (
      <>
        <p>We collect only what the service needs to work:</p>
        <ul>
          <li>
            <strong>Invoice content.</strong> Everything you type into an invoice: your business details, your client&apos;s name, address, email, phone and tax ID, line items, amounts, dates, notes and payment terms. If you upload a logo, we store it as well, with your invoice (or with your template if you&apos;re on Pro), so it can appear on the PDF.
          </li>
          <li>
            <strong>Account details.</strong> Your email address and a password. Passwords are never stored in readable form. We keep only a salted Argon2id hash.
          </li>
          <li>
            <strong>Plan and payment records.</strong> Your plan (Free or Pro), and for each payment its amount, status and Stripe reference numbers. We never see or store your card number.
          </li>
          <li>
            <strong>Session and security data.</strong> A hash of your IP address and your browser&apos;s user-agent string are saved with each login session. Your IP address is also used briefly, in memory, to rate-limit requests and block abuse.
          </li>
        </ul>
      </>
    ),
  },
  {
    heading: "How we use it",
    body: (
      <ul>
        <li>To let you create, save and download invoices, and to apply your template and logo.</li>
        <li>To run your account, including sign-in, email verification and password resets.</li>
        <li>To take payment for a download or a Pro subscription and to unlock what you paid for.</li>
        <li>To keep the service secure and to prevent fraud and abuse.</li>
        <li>To send transactional emails such as email verification and password resets. We do not send marketing emails.</li>
      </ul>
    ),
  },
  {
    heading: "Cookies and local storage",
    body: (
      <>
        <p>We use only what is needed to run the site, and no advertising or analytics cookies:</p>
        <ul>
          <li>Secure cookies that keep you signed in and protect forms from cross-site request forgery.</li>
          <li>A signed cookie that lets a guest reopen the invoice they started.</li>
          <li>Your browser&apos;s local storage, where your draft invoice is kept so it survives a refresh. It stays on your device until you clear it.</li>
        </ul>
      </>
    ),
  },
  {
    heading: "Who we share it with",
    body: (
      <>
        <p>We do not sell your information. We share it only with the providers that help us run the service:</p>
        <ul>
          <li>
            <strong>Stripe</strong> processes payments and subscriptions. Stripe collects your payment details directly and handles them under its own privacy policy.
          </li>
          <li>
            <strong>Our email provider</strong> delivers verification and password-reset messages to your address.
          </li>
          <li>
            <strong>Hosting and infrastructure providers</strong> store the data described above on our behalf.
          </li>
        </ul>
        <p>We may also disclose information where the law requires it, or to protect our rights and the security of the service.</p>
      </>
    ),
  },
  {
    heading: "How long we keep it",
    body: (
      <ul>
        <li>Invoices you save to an account are kept until you delete them or your account is removed.</li>
        <li>Invoices started as a guest and saved on our servers are kept for 48 hours, then removed. Your browser draft stays on your device.</li>
        <li>Login sessions and single-use tokens are deleted when they expire.</li>
        <li>Payment records may be kept for as long as we need them for accounting, tax and dispute purposes.</li>
        <li>If a Pro subscription ends, your account returns to Free. Your saved templates and invoices are kept but locked.</li>
      </ul>
    ),
  },
  {
    heading: "Security",
    body: (
      <p>
        We protect your data with encrypted connections, hashed passwords, HttpOnly cookies, request rate limiting and strict input checks. Logo files are re-encoded on upload to remove hidden data. No system is perfectly secure, so please use a strong, unique password.
      </p>
    ),
  },
  {
    heading: "Your choices and rights",
    body: (
      <>
        <p>Depending on where you live, you may have the right to access, correct, export or delete your personal information, to object to or restrict how we use it, and to complain to your local data protection authority.</p>
        <p>You can edit your invoices inside the editor, and clear your browser draft at any time by clearing this site&apos;s data. To exercise any other right, including deleting your account or your saved invoices, contact us using the details below.</p>
      </>
    ),
  },
  {
    heading: "Your clients' information",
    body: <p>When you enter your clients&apos; details into an invoice, you are responsible for having the right to do so. We process that information only to produce and store your invoice, on your behalf.</p>,
  },
  {
    heading: "Children",
    body: <p>The service is intended for businesses and is not directed to anyone under 16. We do not knowingly collect information from children.</p>,
  },
  {
    heading: "Changes to this policy",
    body: <p>We may update this policy from time to time. The date at the top shows when it last changed. If a change is significant, we will say so on the site.</p>,
  },
  {
    heading: "Contact",
    body: (
      <p>
        {SUPPORT_EMAIL ? (
          <>
            Questions about privacy? Email us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
          </>
        ) : (
          <>Questions about privacy? Contact us using the support details provided with your account or purchase receipt.</>
        )}{" "}
        See also our <Link href="/terms">Terms &amp; Conditions</Link>.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="23 November 2026"
      intro="Your invoices contain business and client details, so we keep what we collect to a minimum and explain it plainly here."
      sections={sections}
    />
  );
}
