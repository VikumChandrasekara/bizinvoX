import { DEFAULT_LAYOUT, type InvoiceDraft, type TemplateLayout } from "@/lib/invoice";

/** The five built-in designs shown in the editor's left panel. Classic is the
 *  shared system template every plan can download; the others are applied
 *  per-account (as the user's own templates) and require Pro to download. */
export type DesignKey = "classic" | "modern" | "elegant" | "bold" | "typewriter";

export type Design = { key: DesignKey; name: string; tagline: string; layout: TemplateLayout };

export const DESIGNS: Design[] = [
  { key: "classic", name: "Classic", tagline: "Indigo band, clean and professional", layout: DEFAULT_LAYOUT },
  {
    key: "modern",
    name: "Modern",
    tagline: "Tinted header with teal accents",
    layout: { ...DEFAULT_LAYOUT, primaryColor: "#0F766E", accentColor: "#F59E0B", headerStyle: "tinted", density: "compact" },
  },
  {
    key: "elegant",
    name: "Elegant",
    tagline: "Serif type and a minimal header",
    layout: { ...DEFAULT_LAYOUT, font: "times", primaryColor: "#1F2937", accentColor: "#B45309", headerStyle: "minimal", titleText: "Invoice" },
  },
  {
    key: "bold",
    name: "Bold",
    tagline: "Strong crimson color band",
    layout: { ...DEFAULT_LAYOUT, primaryColor: "#BE123C", accentColor: "#F59E0B", headerStyle: "band", showDiscountColumn: false },
  },
  {
    key: "typewriter",
    name: "Typewriter",
    tagline: "Monospace and no-frills",
    layout: { ...DEFAULT_LAYOUT, font: "courier", primaryColor: "#111827", accentColor: "#10B981", headerStyle: "minimal", density: "compact", showDiscountColumn: false },
  },
];

export const designByKey = (key: DesignKey) => DESIGNS.find((d) => d.key === key) ?? DESIGNS[0];

/** JSON with sorted keys, so layouts compare equal regardless of key order. */
const stable = (o: unknown): string =>
  JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export function layoutsEqual(a: TemplateLayout, b: TemplateLayout) {
  return stable(a) === stable(b);
}

/** Which built-in design a saved template was created from (by name). */
export function designForTemplateName(name: string): DesignKey {
  const base = name.replace(/ \(custom\)$/, "");
  return DESIGNS.find((d) => d.name === base)?.key ?? "classic";
}

/** Realistic sample content for the template thumbnails. */
export const SAMPLE_DRAFT: InvoiceDraft = {
  templateId: null,
  invoiceNumber: "INV-0042",
  issueDate: "2026-11-22",
  dueDate: "2026-12-22",
  currency: "USD",
  business: { name: "Alex Rivera Design", email: "alex@riveradesign.studio", phone: "", address: "42 Harbor Lane\nPortland, OR 97201", taxId: "" },
  client: { name: "Northwind Coffee Co.", email: "accounts@northwind.coffee", phone: "", address: "1200 Market St\nSeattle, WA 98101", taxId: "" },
  lineItems: [
    { description: "Brand identity design", quantity: "1", unitPrice: "1800", taxRate: "0", discountRate: "0" },
    { description: "Website design (hours)", quantity: "12", unitPrice: "95", taxRate: "0", discountRate: "10" },
    { description: "Social media asset pack", quantity: "1", unitPrice: "450", taxRate: "0", discountRate: "0" },
  ],
  notes: "",
  paymentTerms: "Payment due within 30 days.",
};
