/** Invoice domain types + arithmetic that mirrors backend/src/invoice_calc.rs
 *  exactly (BigInt fixed-point, half-away-from-zero rounding), so the live
 *  preview always matches the server-computed totals. */

export type Party = { name: string; email: string; phone: string; address: string; taxId: string };

export type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  discountRate: string;
};

export type FontFamily = "helvetica" | "times" | "courier";
export type HeaderStyle = "band" | "tinted" | "minimal";
export type LogoPosition = "left" | "right" | "none";
export type Density = "compact" | "comfortable";

export type TemplateLayout = {
  font: FontFamily;
  primaryColor: string;
  accentColor: string;
  textColor: string;
  headerStyle: HeaderStyle;
  logoPosition: LogoPosition;
  showTaxColumn: boolean;
  showDiscountColumn: boolean;
  titleText: string;
  footerText: string;
  customFields: { label: string; value: string }[];
  density: Density;
  /** Elements the user removed from the invoice (Pro). Ids are listed in REMOVABLE_FIELDS. */
  hiddenFields: string[];
};

/** Elements Pro users can remove with the X on the canvas. Must match HIDEABLE_FIELDS in backend/src/models.rs. */
export const REMOVABLE_FIELDS: Record<string, string> = {
  "header.number": "Invoice number (header)",
  "business.address": "Your address",
  "business.email": "Your email",
  "business.phone": "Your phone",
  "business.taxId": "Your tax / VAT ID",
  "client.address": "Client address",
  "client.email": "Client email",
  "client.phone": "Client phone",
  "client.taxId": "Client tax / VAT ID",
  "detail.invoiceNumber": "Invoice # row",
  "detail.issueDate": "Issue date",
  "detail.dueDate": "Due date",
  "detail.currency": "Currency",
  paymentTerms: "Payment terms",
  notes: "Notes",
  footer: "Footer message",
};

export type Template = {
  id: string;
  name: string;
  isDefault: boolean;
  /** A named template the Pro user saved ("My templates"). Other non-default templates are managed by the editor itself. */
  saved: boolean;
  layout: TemplateLayout;
  /** Saved templates: the invoice details that come with it. Null for editor-managed templates and older saved ones. */
  content?: TemplateContent | null;
  hasLogo: boolean;
  createdAt: string;
  updatedAt: string;
  /** When it was moved to the recycle bin (only set for templates listed there). */
  deletedAt?: string | null;
};

/** What a saved template keeps of an invoice: the details that stay the same on every invoice (the header's business
 *  details, currency, payment terms, notes). Client, line items, invoice number and dates are never part of it. */
export type TemplateContent = {
  business: Party;
  currency: string;
  paymentTerms: string;
  notes: string;
};

export type InvoiceStatus = "draft" | "paid" | "downloaded";

export type InvoiceDraft = {
  templateId: string | null;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  business: Party;
  client: Party;
  lineItems: LineItem[];
  notes: string;
  paymentTerms: string;
};

export type Invoice = {
  id: string;
  templateId: string;
  status: InvoiceStatus;
  locked: boolean;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  business: Party;
  client: Party;
  lineItems: LineItem[];
  subtotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
  notes: string | null;
  paymentTerms: string | null;
  createdAt: string;
  updatedAt: string;
  /** Guest/Free customizations of the Classic template, stored on the invoice. Null for the plain look. */
  layout: TemplateLayout | null;
  /** A logo is stored on the invoice itself (Guest/Free). Pro logos live on templates. */
  hasLogo: boolean;
  /** When its PDF was last downloaded (free or paid), or null. `status` only changes for clean downloads. */
  downloadedAt: string | null;
  /** When it was moved to the recycle bin (only set for invoices listed there). Removed for good 30 days later. */
  deletedAt: string | null;
};

/** How long deleted invoices and templates stay in the recycle bin. */
export const RECYCLE_BIN_DAYS = 30;

export const DEFAULT_TEMPLATE_ID = "00000000-0000-0000-0000-000000000001";

export const DEFAULT_LAYOUT: TemplateLayout = {
  font: "helvetica",
  primaryColor: "#2E3A8C",
  accentColor: "#10B981",
  textColor: "#111827",
  headerStyle: "band",
  logoPosition: "none",
  showTaxColumn: true,
  showDiscountColumn: true,
  titleText: "INVOICE",
  footerText: "Thank you for your business.",
  customFields: [],
  density: "comfortable",
  hiddenFields: [],
};

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "INR", "LKR", "SGD", "JPY", "CHF", "ZAR", "AED", "MXN", "BRL"];

export const emptyParty = (): Party => ({ name: "", email: "", phone: "", address: "", taxId: "" });
export const emptyLine = (): LineItem => ({ description: "", quantity: "1", unitPrice: "0", taxRate: "0", discountRate: "0" });

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function newDraft(): InvoiceDraft {
  const today = new Date();
  const due = new Date(today.getTime() + 30 * 86_400_000);
  return {
    templateId: null,
    invoiceNumber: "",
    issueDate: isoDate(today),
    dueDate: isoDate(due),
    currency: "USD",
    business: emptyParty(),
    client: emptyParty(),
    lineItems: [emptyLine()],
    notes: "",
    paymentTerms: "Payment due within 30 days.",
  };
}

export function draftFromInvoice(inv: Invoice): InvoiceDraft {
  return {
    templateId: inv.templateId === DEFAULT_TEMPLATE_ID ? null : inv.templateId,
    invoiceNumber: inv.invoiceNumber,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate ?? "",
    currency: inv.currency,
    business: inv.business,
    client: inv.client,
    lineItems: inv.lineItems.map((l) => ({ ...l, quantity: String(l.quantity), unitPrice: String(l.unitPrice), taxRate: String(l.taxRate), discountRate: String(l.discountRate) })),
    notes: inv.notes ?? "",
    paymentTerms: inv.paymentTerms ?? "",
  };
}

/** Normalise a free-typed numeric field into a decimal string the API accepts. */
export function cleanNumber(v: string, maxDp: number): string {
  const s = v.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return "0";
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, maxDp);
  return `${i || "0"}${frac ? `.${frac}` : ""}`;
}

/** `layout` is sent for Guest/Free accounts, whose Classic customizations live on the invoice. Pro uses templates. */
export function toApiPayload(d: InvoiceDraft, layout?: TemplateLayout) {
  return {
    ...(layout ? { layout } : {}),
    templateId: d.templateId,
    invoiceNumber: d.invoiceNumber.trim() || null,
    issueDate: d.issueDate,
    dueDate: d.dueDate || null,
    currency: d.currency,
    business: d.business,
    client: d.client,
    lineItems: d.lineItems.map((l) => ({
      description: l.description.trim() || "Item",
      quantity: cleanNumber(l.quantity, 4),
      unitPrice: cleanNumber(l.unitPrice, 2),
      taxRate: cleanNumber(l.taxRate, 3),
      discountRate: cleanNumber(l.discountRate, 3),
    })),
    notes: d.notes,
    paymentTerms: d.paymentTerms,
  };
}

// ---------------------------------------------------------------------------
// Exact fixed-point arithmetic
// ---------------------------------------------------------------------------

/** Parse a decimal string into an integer scaled by 10^scale (truncating extra digits). */
function scaled(v: string, scale: number): bigint {
  const s = cleanNumber(v, scale);
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 10n ** BigInt(scale) + BigInt((f + "0".repeat(scale)).slice(0, scale) || "0");
}

/** Divide non-negative a by b, rounding half away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

export type Breakdown = { net: bigint; discount: bigint; tax: bigint; amount: bigint }; // all in cents

export function breakdown(item: LineItem): Breakdown {
  const q = scaled(item.quantity, 4); // x1e4
  const p = scaled(item.unitPrice, 2); // x1e2
  const net = divRound(q * p, 10_000n); // cents
  const discount = divRound(net * scaled(item.discountRate, 3), 100_000n);
  const tax = divRound((net - discount) * scaled(item.taxRate, 3), 100_000n);
  return { net, discount, tax, amount: net - discount + tax };
}

export type Totals = { subtotal: bigint; discount: bigint; tax: bigint; total: bigint };

export function totals(items: LineItem[]): Totals {
  return items.reduce<Totals>(
    (t, item) => {
      const b = breakdown(item);
      return { subtotal: t.subtotal + b.net, discount: t.discount + b.discount, tax: t.tax + b.tax, total: t.total + b.amount };
    },
    { subtotal: 0n, discount: 0n, tax: 0n, total: 0n },
  );
}

export function formatMoney(cents: bigint, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(cents) / 100);
  } catch {
    return `${currency} ${(Number(cents) / 100).toFixed(2)}`;
  }
}

export function formatAmount(cents: bigint) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(cents) / 100);
}

export function formatDate(iso: string) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}
