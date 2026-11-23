import type { InvoiceDraft, LineItem, Party, TemplateLayout } from "@/lib/invoice";

/** What the user has clicked on in the editable invoice. */
export type Selection =
  | { kind: "page" }
  | { kind: "header" }
  | { kind: "table" }
  | { kind: "totals" }
  | { kind: "image" }
  | { kind: "text"; id: string };

export type BindingKind = "text" | "number" | "date" | "currency";

/** A named, editable value on the invoice. The canvas and the inspector both
 *  read and write through the same binding, so they can never disagree. */
export type Binding = {
  id: string;
  label: string;
  value: string;
  set: (v: string) => void;
  kind: BindingKind;
  multiline?: boolean;
  maxLength?: number;
  /** "invoice" values belong to this invoice; "design" values belong to the template. */
  scope: "invoice" | "design";
  remove?: { label: string; run: () => void };
};

export type BindCtx = {
  draft: InvoiceDraft;
  layout: TemplateLayout;
  patchDraft: (fn: (d: InvoiceDraft) => InvoiceDraft) => void;
  patchLayout: (fn: (l: TemplateLayout) => TemplateLayout) => void;
};

const PARTY: Record<keyof Party, { label: string; multiline?: boolean; max: number }> = {
  name: { label: "Name", max: 200 },
  email: { label: "Email", max: 254 },
  phone: { label: "Phone", max: 50 },
  address: { label: "Address", multiline: true, max: 500 },
  taxId: { label: "Tax / VAT ID", max: 64 },
};

const ITEM: Record<keyof LineItem, { label: string; kind: BindingKind; multiline?: boolean; max: number }> = {
  description: { label: "Description", kind: "text", multiline: true, max: 500 },
  quantity: { label: "Quantity", kind: "number", max: 12 },
  unitPrice: { label: "Unit price", kind: "number", max: 14 },
  taxRate: { label: "Tax %", kind: "number", max: 8 },
  discountRate: { label: "Discount %", kind: "number", max: 8 },
};

/** Resolve an element id (e.g. `client.name`, `item.2.quantity`) to its binding. */
export function makeBinding(id: string, ctx: BindCtx): Binding | null {
  const { draft, layout, patchDraft, patchLayout } = ctx;
  const parts = id.split(".");

  if (parts[0] === "business" || parts[0] === "client") {
    const side = parts[0];
    const field = parts[1] as keyof Party;
    const meta = PARTY[field];
    if (!meta) return null;
    return {
      id,
      label: `${side === "business" ? "Your business" : "Client"} · ${meta.label.toLowerCase()}`,
      value: draft[side][field],
      set: (v) => patchDraft((d) => ({ ...d, [side]: { ...d[side], [field]: v } })),
      kind: "text",
      multiline: meta.multiline,
      maxLength: meta.max,
      scope: "invoice",
    };
  }

  if (parts[0] === "item") {
    const i = Number(parts[1]);
    const field = parts[2] as keyof LineItem;
    const meta = ITEM[field];
    if (!meta || !draft.lineItems[i]) return null;
    return {
      id,
      label: `Item ${i + 1} · ${meta.label.toLowerCase()}`,
      value: draft.lineItems[i][field],
      set: (v) => patchDraft((d) => ({ ...d, lineItems: d.lineItems.map((l, j) => (j === i ? { ...l, [field]: v } : l)) })),
      kind: meta.kind,
      multiline: meta.multiline,
      maxLength: meta.max,
      scope: "invoice",
      remove:
        draft.lineItems.length > 1
          ? { label: `Remove item ${i + 1}`, run: () => patchDraft((d) => ({ ...d, lineItems: d.lineItems.filter((_, j) => j !== i) })) }
          : undefined,
    };
  }

  if (parts[0] === "custom") {
    const i = Number(parts[1]);
    const field = parts[2] as "label" | "value";
    const f = layout.customFields[i];
    if (!f || (field !== "label" && field !== "value")) return null;
    return {
      id,
      label: `Custom field ${i + 1} · ${field}`,
      value: f[field],
      set: (v) => patchLayout((l) => ({ ...l, customFields: l.customFields.map((x, j) => (j === i ? { ...x, [field]: v } : x)) })),
      kind: "text",
      maxLength: field === "label" ? 40 : 120,
      scope: "design",
      remove: { label: "Remove this field", run: () => patchLayout((l) => ({ ...l, customFields: l.customFields.filter((_, j) => j !== i) })) },
    };
  }

  const simple: Record<string, Binding | undefined> = {
    title: { id, label: "Invoice title", value: layout.titleText, set: (v) => patchLayout((l) => ({ ...l, titleText: v })), kind: "text", maxLength: 30, scope: "design" },
    footer: { id, label: "Footer message", value: layout.footerText, set: (v) => patchLayout((l) => ({ ...l, footerText: v })), kind: "text", multiline: true, maxLength: 300, scope: "design" },
    invoiceNumber: { id, label: "Invoice number", value: draft.invoiceNumber, set: (v) => patchDraft((d) => ({ ...d, invoiceNumber: v })), kind: "text", maxLength: 40, scope: "invoice" },
    issueDate: { id, label: "Issue date", value: draft.issueDate, set: (v) => patchDraft((d) => ({ ...d, issueDate: v })), kind: "date", scope: "invoice" },
    dueDate: { id, label: "Due date", value: draft.dueDate, set: (v) => patchDraft((d) => ({ ...d, dueDate: v })), kind: "date", scope: "invoice" },
    currency: { id, label: "Currency", value: draft.currency, set: (v) => patchDraft((d) => ({ ...d, currency: v })), kind: "currency", scope: "invoice" },
    paymentTerms: { id, label: "Payment terms", value: draft.paymentTerms, set: (v) => patchDraft((d) => ({ ...d, paymentTerms: v })), kind: "text", multiline: true, maxLength: 1000, scope: "invoice" },
    notes: { id, label: "Notes", value: draft.notes, set: (v) => patchDraft((d) => ({ ...d, notes: v })), kind: "text", multiline: true, maxLength: 2000, scope: "invoice" },
  };
  return simple[id] ?? null;
}
