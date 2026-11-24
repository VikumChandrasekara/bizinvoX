"use client";

import { ImagePlus, Plus, X } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";

import { EditableText } from "@/components/editor/editable-text";
import { makeBinding, type Binding, type BindCtx, type Selection } from "@/lib/bindings";
import { breakdown, CURRENCIES, formatAmount, formatDate, formatMoney, REMOVABLE_FIELDS, totals, type TemplateLayout } from "@/lib/invoice";
import { cn } from "@/lib/utils";

/** A4 at 96 dpi. The page renders at this fixed size and is scaled to fit its
 *  column, so proportions match the server-rendered PDF (backend/src/pdf.rs). */
const PAGE_W = 794;
const PAGE_H = 1123;
const MM = PAGE_W / 210;
const PT = 96 / 72;

// Watermark tile: staggered "bizinvoX.com" marks, same size/tilt/spacing/colour as the PDF's
// (11pt bold, 30° tilt, 52mm x 24mm pitch, rgb 184/191/214), drawn over the page with a multiply blend.
const WM_TILE_W = Math.round(52 * MM);
const WM_TILE_H = Math.round(48 * MM);
const WATERMARK_TILE = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${WM_TILE_W}' height='${WM_TILE_H}'>` +
    `<g font-family='Helvetica,Arial,sans-serif' font-weight='700' font-size='${(11 * PT).toFixed(2)}' fill='rgb(184,191,214)'>` +
    `<text transform='translate(12 ${Math.round(WM_TILE_H * 0.38)}) rotate(-30)'>bizinvoX.com</text>` +
    // The second row sits half a pitch over, so its tail wraps into the next tile: draw it twice.
    `<text transform='translate(${Math.round(WM_TILE_W / 2) + 12} ${Math.round(WM_TILE_H * 0.88)}) rotate(-30)'>bizinvoX.com</text>` +
    `<text transform='translate(${Math.round(WM_TILE_W / 2) + 12 - WM_TILE_W} ${Math.round(WM_TILE_H * 0.88)}) rotate(-30)'>bizinvoX.com</text>` +
    `</g></svg>`,
)}")`;

const FONTS: Record<TemplateLayout["font"], string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
};

function luminance(hex: string) {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const onColor = (bg: string) => (luminance(bg) > 0.55 ? "#111827" : "#ffffff");
function tint(hex: string, t: number) {
  const n = parseInt(hex.replace("#", ""), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

type CanvasCtx = {
  bind: (id: string) => Binding | null;
  selection: Selection | null;
  select: (s: Selection) => void;
  readOnly: boolean;
  measure: string;
  /** Ids of elements the user removed (layout.hiddenFields). */
  hidden: string[];
  removeField: ((id: string) => void) | null;
};
const Ctx = createContext<CanvasCtx>({ bind: () => null, selection: null, select: () => undefined, readOnly: true, measure: "", hidden: [], removeField: null });

export type CanvasActions = { addItem: () => void; addCustomField: () => void };

export type InvoiceCanvasProps = {
  ctx: BindCtx;
  logoUrl: string | null;
  /** Show the "Created with ..." line (non-Pro). */
  branding: boolean;
  selection?: Selection | null;
  onSelect?: (s: Selection) => void;
  actions?: CanvasActions;
  /** Called when the X on a field is clicked. */
  onRemoveField?: (id: string) => void;
  /** No edits allowed (paid/locked invoice). Clicking still selects. */
  readOnly?: boolean;
  /** Static, non-interactive rendering used for template thumbnails. */
  thumbnail?: boolean;
  /** Small "bizinvoX.com" marks tiled over the page, like the PDF's (Guest/Free until it is paid off). */
  watermark?: boolean;
  className?: string;
};

export function InvoiceCanvas({ ctx, logoUrl, branding, selection = null, onSelect, actions, onRemoveField, readOnly = false, thumbnail = false, watermark = false, className }: InvoiceCanvasProps) {
  const outer = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [height, setHeight] = useState(PAGE_H);

  useLayoutEffect(() => {
    const o = outer.current;
    const p = page.current;
    if (!o || !p) return;
    const roScale = new ResizeObserver(([e]) => setScale(e.contentRect.width / PAGE_W));
    const roHeight = new ResizeObserver(() => setHeight(p.offsetHeight));
    roScale.observe(o);
    roHeight.observe(p);
    setScale(o.clientWidth / PAGE_W);
    setHeight(p.offsetHeight);
    return () => {
      roScale.disconnect();
      roHeight.disconnect();
    };
  }, []);

  const select = onSelect ?? (() => undefined);
  const value: CanvasCtx = {
    bind: (id) => makeBinding(id, ctx),
    selection,
    select,
    readOnly: readOnly || thumbnail,
    measure: `${ctx.layout.font}|${ctx.layout.density}|${ctx.layout.showTaxColumn}|${ctx.layout.showDiscountColumn}`,
    hidden: ctx.layout.hiddenFields ?? [],
    removeField: onRemoveField ?? null,
  };

  function onMouseDown(e: React.MouseEvent) {
    if (thumbnail) return;
    const el = e.target as HTMLElement;
    if (el.closest("[data-editable],[data-ui]")) return;
    const zone = el.closest<HTMLElement>("[data-zone]")?.dataset.zone;
    if (zone === "image" || zone === "header" || zone === "table" || zone === "totals") select({ kind: zone });
    else select({ kind: "page" });
  }

  return (
    <div ref={outer} className={cn("relative w-full", className)} style={{ height: height * scale }} aria-hidden={thumbnail || undefined}>
      <div
        ref={page}
        onMouseDown={onMouseDown}
        inert={thumbnail}
        className="absolute left-0 top-0 origin-top-left overflow-visible bg-white text-left shadow-xl shadow-black/10 ring-1 ring-black/5"
        style={{ width: PAGE_W, minHeight: PAGE_H, transform: `scale(${scale})` }}
      >
        <Ctx.Provider value={value}>
          <Page layout={ctx.layout} draft={ctx.draft} logoUrl={logoUrl} branding={branding} actions={actions} />
        </Ctx.Provider>
        {watermark && <div aria-hidden className="pointer-events-none absolute inset-0 select-none mix-blend-multiply" style={{ backgroundImage: WATERMARK_TILE, backgroundSize: `${WM_TILE_W}px ${WM_TILE_H}px` }} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable primitives
// ---------------------------------------------------------------------------

function F({ id, placeholder, multiline, align, numeric, style, className }: { id: string; placeholder: string; multiline?: boolean; align?: "left" | "right" | "center"; numeric?: boolean; style?: React.CSSProperties; className?: string }) {
  const { bind, selection, select, readOnly, measure } = useContext(Ctx);
  const b = bind(id);
  if (!b) return null;
  return (
    <EditableText
      label={b.label}
      value={b.value}
      onChange={b.set}
      placeholder={placeholder}
      multiline={multiline ?? b.multiline}
      align={align}
      numeric={numeric}
      maxLength={b.maxLength}
      readOnly={readOnly}
      measure={measure}
      selected={selection?.kind === "text" && selection.id === id}
      onSelect={() => select({ kind: "text", id })}
      style={style}
      className={className}
    />
  );
}

/** A date shown as formatted text; a transparent native date input sits on top. */
function DateField({ id, align = "right" }: { id: string; align?: "left" | "right" }) {
  const { bind, selection, select, readOnly } = useContext(Ctx);
  const ref = useRef<HTMLInputElement>(null);
  const b = bind(id);
  if (!b) return null;
  const selected = selection?.kind === "text" && selection.id === id;
  return (
    <span className={cn("relative block rounded-[2px] transition-shadow", !readOnly && "hover:shadow-[0_0_0_1.5px_rgba(99,102,241,0.5)]", selected && "!shadow-[0_0_0_2px_#6366f1]")} style={{ textAlign: align }}>
      <span className="block truncate font-bold">{b.value ? formatDate(b.value) : <span style={{ opacity: 0.45, fontWeight: 400 }}>Pick a date</span>}</span>
      {!readOnly && (
        <input
          ref={ref}
          data-editable
          type="date"
          aria-label={b.label}
          value={b.value}
          onChange={(e) => b.set(e.target.value)}
          onFocus={() => select({ kind: "text", id })}
          onClick={() => {
            try {
              ref.current?.showPicker();
            } catch {
              /* showPicker needs a user gesture; typing still works */
            }
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      )}
    </span>
  );
}

function CurrencyField({ id }: { id: string }) {
  const { bind, selection, select, readOnly } = useContext(Ctx);
  const b = bind(id);
  if (!b) return null;
  const selected = selection?.kind === "text" && selection.id === id;
  return (
    <span className={cn("relative block rounded-[2px] text-right transition-shadow", !readOnly && "hover:shadow-[0_0_0_1.5px_rgba(99,102,241,0.5)]", selected && "!shadow-[0_0_0_2px_#6366f1]")}>
      <span className="block truncate font-bold">{b.value || "USD"}</span>
      {!readOnly && (
        <select data-editable aria-label={b.label} value={b.value} onChange={(e) => b.set(e.target.value)} onFocus={() => select({ kind: "text", id })} className="absolute inset-0 size-full cursor-pointer opacity-0">
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

function zoneRing(selection: Selection | null, kind: Selection["kind"], readOnly: boolean) {
  if (selection?.kind === kind) return "outline outline-2 outline-offset-[-2px] outline-indigo-500";
  return readOnly ? "" : "hover:outline hover:outline-1 hover:outline-dashed hover:outline-offset-[-1px] hover:outline-indigo-400/70";
}

const REMOVE_BTN =
  "absolute z-10 flex size-5 items-center justify-center rounded-full bg-white text-slate-500 opacity-0 shadow ring-1 ring-slate-200 transition hover:text-red-600 focus:opacity-100";

function removeTitle(id: string) {
  const raw = REMOVABLE_FIELDS[id] ?? "Field";
  return `Remove ${raw.charAt(0).toLowerCase() + raw.slice(1)}`;
}

/** Wraps an element the user may remove. Shows an X on hover/focus; renders nothing once removed. */
function Removable({ id, children, className, offset = -26, top = false }: { id: string; children: React.ReactNode; className?: string; offset?: number; top?: boolean }) {
  const { hidden, removeField, readOnly } = useContext(Ctx);
  if (hidden.includes(id)) return null;
  return (
    <div className={cn("group/rm relative", className)}>
      {children}
      {!readOnly && removeField && (
        <button
          type="button"
          data-ui
          aria-label={removeTitle(id)}
          title={removeTitle(id)}
          onClick={() => removeField(id)}
          className={cn(REMOVE_BTN, "group-hover/rm:opacity-100 group-focus-within/rm:opacity-100", top ? "top-0" : "top-1/2 -translate-y-1/2")}
          style={{ right: offset }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** X inside a table header cell that hides a whole column. */
function ColumnRemove({ id, label }: { id: string; label: string }) {
  const { removeField, readOnly } = useContext(Ctx);
  if (readOnly || !removeField) return null;
  const title = `Remove ${label} column`;
  return (
    <button type="button" data-ui aria-label={title} title={title} onClick={() => removeField(id)} className={cn(REMOVE_BTN, "left-1 top-1/2 -translate-y-1/2 group-hover/th:opacity-100")}>
      <X className="size-3.5" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function Page({ layout: l, draft, logoUrl, branding, actions }: { layout: TemplateLayout; draft: BindCtx["draft"]; logoUrl: string | null; branding: boolean; actions?: CanvasActions }) {
  const { selection, select, readOnly } = useContext(Ctx);
  const t = totals(draft.lineItems);
  const cur = draft.currency || "USD";
  const headerH = 42 * MM;
  const headerBg = l.headerStyle === "band" ? l.primaryColor : l.headerStyle === "tinted" ? tint(l.primaryColor, 0.9) : "#ffffff";
  const titleColor = l.headerStyle === "band" ? onColor(l.primaryColor) : l.primaryColor;
  const subColor = l.headerStyle === "band" ? onColor(l.primaryColor) : l.textColor;
  const showLogo = Boolean(logoUrl) && l.logoPosition !== "none";
  const logoLeft = showLogo && l.logoPosition === "left";
  const pad = l.density === "compact" ? 2 * MM : 3.2 * MM;
  const muted = "#6b7280";
  const label = { color: l.primaryColor, fontSize: 7.5 * PT, fontWeight: 700, letterSpacing: "0.04em" } as const;
  const cellX = 3 * MM;

  return (
    <div className="relative flex flex-col" style={{ minHeight: PAGE_H, fontFamily: FONTS[l.font], color: l.textColor }} data-zone="page">
      {/* Header */}
      <div data-zone="header" className={cn("relative", zoneRing(selection, "header", readOnly))} style={{ height: headerH, background: headerBg }}>
        <div className="flex h-full items-center justify-between" style={{ padding: `0 ${16 * MM}px` }}>
          <div className={cn(logoLeft && "order-2")} style={{ width: 95 * MM }}>
            <F id="title" placeholder="INVOICE" align={logoLeft ? "right" : "left"} style={{ fontSize: 24 * PT, fontWeight: 700, color: titleColor, lineHeight: 1.1 }} />
            <Removable id="header.number" className={cn("w-fit", logoLeft && "ml-auto")} offset={-26}>
              <div className="flex items-baseline" style={{ fontSize: 10 * PT, color: subColor, marginTop: 6, opacity: 0.9 }}>
                <span>No.&nbsp;</span>
                {logoLeft ? (
                  // Right-aligned like the title and the PDF: the box is exactly as wide as the number, so "No." sits right next to it.
                  <div className="relative">
                    <span aria-hidden className="invisible block whitespace-pre pr-px">
                      {draft.invoiceNumber || "INV-0001"}
                    </span>
                    <div className="absolute inset-0">
                      <F id="invoiceNumber" placeholder="INV-0001" align="right" />
                    </div>
                  </div>
                ) : (
                  <div style={{ width: 42 * MM }}>
                    <F id="invoiceNumber" placeholder="INV-0001" align="left" />
                  </div>
                )}
              </div>
            </Removable>
          </div>

          {showLogo ? (
            <div data-zone="image" className={cn("cursor-pointer rounded-sm", logoLeft && "order-1", zoneRing(selection, "image", readOnly))}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl!} alt="Business logo" draggable={false} className="block object-contain" style={{ maxWidth: 48 * MM, maxHeight: 22 * MM }} />
            </div>
          ) : (
            <div style={{ width: 80 * MM }}>
              <F id="business.name" placeholder="Your business name" align="right" style={{ fontSize: 13 * PT, fontWeight: 700, color: titleColor }} />
            </div>
          )}
        </div>

        {!readOnly && !showLogo && (
          <button
            type="button"
            data-ui
            onClick={() => select({ kind: "image" })}
            className={cn("absolute flex items-center gap-1.5 rounded-md border border-dashed bg-white/85 px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-sm transition hover:border-indigo-500 hover:text-indigo-600", selection?.kind === "image" && "border-indigo-500 text-indigo-600 ring-2 ring-indigo-500")}
            style={{ right: 5 * MM, top: 3 * MM, borderColor: "#94a3b8" }}
          >
            <ImagePlus className="size-3.5" /> {logoUrl ? "Logo hidden" : "Add logo"}
          </button>
        )}

        {l.headerStyle === "minimal" ? (
          <div style={{ position: "absolute", left: 16 * MM, right: 16 * MM, bottom: 3 * MM, height: 2.6, background: l.accentColor }} />
        ) : (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: -1.4 * MM, height: 1.4 * MM, background: l.accentColor }} />
        )}
      </div>

      <div className="flex flex-1 flex-col" style={{ padding: `${13 * MM}px ${16 * MM}px 0` }}>
        {/* Parties + details */}
        <div className="grid grid-cols-3" style={{ gap: 7 * MM, marginBottom: 9 * MM }}>
          <PartyBlock side="business" title="FROM" labelStyle={label} muted={muted} />
          <PartyBlock side="client" title="BILL TO" labelStyle={label} muted={muted} />
          <div>
            <div style={label}>DETAILS</div>
            <div style={{ marginTop: 8, fontSize: 9 * PT, lineHeight: 1.55 }}>
              <Removable id="detail.invoiceNumber" offset={-30}>
                <DetailRow label="Invoice #" muted={muted}>
                  <F id="invoiceNumber" placeholder="Auto" align="right" style={{ fontWeight: 700 }} />
                </DetailRow>
              </Removable>
              <Removable id="detail.issueDate" offset={-30}>
                <DetailRow label="Issue date" muted={muted}>
                  <DateField id="issueDate" />
                </DetailRow>
              </Removable>
              <Removable id="detail.dueDate" offset={-30}>
                <DetailRow label="Due date" muted={muted}>
                  <DateField id="dueDate" />
                </DetailRow>
              </Removable>
              <Removable id="detail.currency" offset={-30}>
                <DetailRow label="Currency" muted={muted}>
                  <CurrencyField id="currency" />
                </DetailRow>
              </Removable>
              {l.customFields.map((_, i) => (
                <div key={i} className="group/row relative flex gap-2" style={{ lineHeight: 1.55 }}>
                  <div className="w-1/2" style={{ color: muted }}>
                    <F id={`custom.${i}.label`} placeholder="Label" />
                  </div>
                  <div className="w-1/2">
                    <F id={`custom.${i}.value`} placeholder="Value" align="right" style={{ fontWeight: 700 }} />
                  </div>
                  {!readOnly && <RemoveCustom index={i} />}
                </div>
              ))}
              {!readOnly && l.customFields.length < 8 && actions && (
                <button type="button" data-ui onClick={actions.addCustomField} className="mt-1 flex items-center gap-1 text-[11px] font-medium text-slate-400 transition hover:text-indigo-600">
                  <Plus className="size-3" /> Add field
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Line items */}
        <table data-zone="table" className={cn("w-full border-collapse", zoneRing(selection, "table", readOnly))} style={{ fontSize: 9 * PT }}>
          <thead>
            <tr style={{ background: l.primaryColor, color: onColor(l.primaryColor), fontSize: 7.5 * PT, letterSpacing: "0.04em" }}>
              <th className="text-left" style={{ padding: `${2.6 * MM}px ${cellX}px` }}>DESCRIPTION</th>
              <th className="text-right" style={{ padding: `0 ${cellX}px`, width: 16 * MM }}>QTY</th>
              <th className="text-right" style={{ padding: `0 ${cellX}px`, width: 29 * MM }}>UNIT PRICE</th>
              {l.showTaxColumn && (
                <th className="group/th relative text-right" style={{ padding: `0 ${cellX}px`, width: 15 * MM }}>
                  <ColumnRemove id="column.tax" label="tax" />
                  TAX
                </th>
              )}
              {l.showDiscountColumn && (
                <th className="group/th relative text-right" style={{ padding: `0 ${cellX}px`, width: 15 * MM }}>
                  <ColumnRemove id="column.discount" label="discount" />
                  DISC.
                </th>
              )}
              <th className="text-right" style={{ padding: `0 ${cellX}px`, width: 31 * MM }}>AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {draft.lineItems.map((item, i) => {
              const b = breakdown(item);
              const cell = { padding: `${pad}px ${cellX}px`, verticalAlign: "top" } as const;
              return (
                <tr key={i} className="group/row" style={{ background: i % 2 === 1 ? "#f6f7fa" : undefined }}>
                  <td style={{ ...cell, position: "relative" }}>
                    {!readOnly && draft.lineItems.length > 1 && (
                      <RemoveItem index={i} />
                    )}
                    <F id={`item.${i}.description`} placeholder="Item description" multiline />
                  </td>
                  <td style={cell}>
                    <F id={`item.${i}.quantity`} placeholder="0" numeric align="right" />
                  </td>
                  <td style={cell}>
                    <F id={`item.${i}.unitPrice`} placeholder="0.00" numeric align="right" />
                  </td>
                  {l.showTaxColumn && (
                    <td style={{ ...cell, color: muted }}>
                      <div className="flex items-baseline justify-end">
                        <div className="min-w-0 flex-1">
                          <F id={`item.${i}.taxRate`} placeholder="0" numeric align="right" />
                        </div>
                        <span>%</span>
                      </div>
                    </td>
                  )}
                  {l.showDiscountColumn && (
                    <td style={{ ...cell, color: muted }}>
                      <div className="flex items-baseline justify-end">
                        <div className="min-w-0 flex-1">
                          <F id={`item.${i}.discountRate`} placeholder="0" numeric align="right" />
                        </div>
                        <span>%</span>
                      </div>
                    </td>
                  )}
                  <td className="text-right font-bold" style={cell}>
                    {formatAmount(b.amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ height: 1, background: "#dcdfe6" }} />
        {!readOnly && actions && (
          <button type="button" data-ui onClick={actions.addItem} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-slate-300 py-2 text-xs font-medium text-slate-500 transition hover:border-indigo-400 hover:text-indigo-600">
            <Plus className="size-3.5" /> Add line item
          </button>
        )}

        {/* Notes + totals */}
        <div className="flex justify-between" style={{ marginTop: 7 * MM, gap: 10 * MM }}>
          <div className="min-w-0 flex-1" style={{ fontSize: 9 * PT }}>
            <Removable id="paymentTerms" top offset={0} className="mb-[4mm]">
              <div style={label}>PAYMENT TERMS</div>
              <div style={{ marginTop: 6 }}>
                <F id="paymentTerms" placeholder="Payment terms, e.g. Net 30" multiline />
              </div>
            </Removable>
            <Removable id="notes" top offset={0}>
              <div style={label}>NOTES</div>
              <div style={{ marginTop: 6 }}>
                <F id="notes" placeholder="Notes for your client" multiline />
              </div>
            </Removable>
          </div>
          <div data-zone="totals" style={{ width: 80 * MM, fontSize: 9.5 * PT }} className={cn("shrink-0", zoneRing(selection, "totals", readOnly))}>
            <TotalRow label="Subtotal" value={formatMoney(t.subtotal, cur)} muted={muted} />
            {t.discount > 0n && <TotalRow label="Discount" value={`-${formatMoney(t.discount, cur)}`} muted={muted} />}
            {(t.tax > 0n || l.showTaxColumn) && <TotalRow label="Tax" value={formatMoney(t.tax, cur)} muted={muted} />}
            <div className="flex items-center justify-between" style={{ marginTop: 6, height: 12 * MM, background: tint(l.primaryColor, 0.9), borderLeft: `${1.6 * MM}px solid ${l.accentColor}`, padding: `0 ${3 * MM}px 0 ${3.4 * MM}px`, color: l.primaryColor }}>
              <span style={{ fontSize: 10.5 * PT, fontWeight: 700 }}>Total due</span>
              <span style={{ fontSize: 13 * PT, fontWeight: 700 }}>{formatMoney(t.total, cur)}</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto text-center" style={{ borderTop: "1px solid #dcdfe6", padding: `${3 * MM}px 0 ${5 * MM}px`, marginTop: 10 * MM, fontSize: 8.5 * PT, color: muted }}>
          <Removable id="footer" className="w-full" offset={6}>
            <F id="footer" placeholder="Footer message" align="center" />
          </Removable>
          {branding && <div style={{ fontSize: 7 * PT, opacity: 0.75, marginTop: 4 }}>Created with bizinvoX.com</div>}
        </div>
      </div>
    </div>
  );
}

function RemoveItem({ index }: { index: number }) {
  const { bind } = useContext(Ctx);
  return (
    <button
      type="button"
      data-ui
      aria-label={`Remove item ${index + 1}`}
      onClick={() => bind(`item.${index}.description`)?.remove?.run()}
      className="absolute top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full bg-white text-slate-500 opacity-0 shadow ring-1 ring-slate-200 transition hover:text-red-600 focus:opacity-100 group-hover/row:opacity-100"
      style={{ left: -34 }}
    >
      <X className="size-3.5" />
    </button>
  );
}

/** Custom detail fields belong to the user, so removing one is always allowed. */
function RemoveCustom({ index }: { index: number }) {
  const { bind } = useContext(Ctx);
  return (
    <button
      type="button"
      data-ui
      aria-label={`Remove custom field ${index + 1}`}
      onClick={() => bind(`custom.${index}.label`)?.remove?.run()}
      className={cn(REMOVE_BTN, "top-1/2 -translate-y-1/2 group-hover/row:opacity-100")}
      style={{ right: -30 }}
    >
      <X className="size-3.5" />
    </button>
  );
}

function PartyBlock({ side, title, labelStyle, muted }: { side: "business" | "client"; title: string; labelStyle: React.CSSProperties; muted: string }) {
  const who = side === "business" ? "Your" : "Client";
  return (
    <div className="min-w-0" style={{ fontSize: 9 * PT }}>
      <div style={labelStyle}>{title}</div>
      <div style={{ marginTop: 8, fontSize: 11 * PT, fontWeight: 700 }}>
        <F id={`${side}.name`} placeholder={side === "business" ? "Your business name" : "Client name"} />
      </div>
      <div style={{ color: muted, lineHeight: 1.5 }}>
        <Removable id={`${side}.address`} offset={-22}>
          <F id={`${side}.address`} placeholder={`${who} address`} multiline />
        </Removable>
        <Removable id={`${side}.email`} offset={-22}>
          <F id={`${side}.email`} placeholder={`${who} email`} />
        </Removable>
        <Removable id={`${side}.phone`} offset={-22}>
          <F id={`${side}.phone`} placeholder="Phone" />
        </Removable>
        <Removable id={`${side}.taxId`} offset={-22}>
          <F id={`${side}.taxId`} placeholder="Tax / VAT ID" />
        </Removable>
      </div>
    </div>
  );
}

function DetailRow({ label, muted, children }: { label: string; muted: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2" style={{ lineHeight: 1.55 }}>
      <span className="shrink-0" style={{ color: muted }}>
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function TotalRow({ label, value, muted }: { label: string; value: string; muted: string }) {
  return (
    <div className="flex justify-between" style={{ padding: `${1.6 * MM}px ${3 * MM}px ${1.6 * MM}px ${4 * MM}px` }}>
      <span style={{ color: muted }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
