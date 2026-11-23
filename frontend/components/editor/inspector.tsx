"use client";

import { ImageIcon, LayoutTemplate, Palette, RotateCcw, Rows3, Table2, Trash2, Type, X } from "lucide-react";
import { useState } from "react";

import type { Confirmation } from "@/components/confirm-dialog";
import { ACCENT_SWATCHES, ColorField, Group, PRIMARY_SWATCHES, Segmented, TEXT_SWATCHES, Toggle } from "@/components/editor/controls";
import FileUpload from "@/components/kokonutui/file-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { makeBinding, type BindCtx, type Selection } from "@/lib/bindings";
import { CURRENCIES, REMOVABLE_FIELDS, type TemplateLayout } from "@/lib/invoice";
import { cn } from "@/lib/utils";

export type InspectorProps = {
  selection: Selection | null;
  ctx: BindCtx;
  isPro: boolean;
  logoUrl: string | null;
  designName: string;
  onUploadLogo: (file: File) => Promise<void>;
  onRemoveLogo: () => void;
  onResetDesign: () => void;
  /** Removing anything asks first: the editor shows the "are you sure?" popup and runs `run` if confirmed. */
  onAskRemove: (c: Confirmation) => void;
  /** Taking fields and columns off the invoice is Pro only: called instead when someone else tries. */
  onProOnly: (what: string) => void;
  /** Close button for the mobile bottom sheet. */
  onClose?: () => void;
  className?: string;
};

const FONT_OPTIONS: { value: TemplateLayout["font"]; label: string; style: React.CSSProperties }[] = [
  { value: "helvetica", label: "Sans", style: { fontFamily: "Helvetica, Arial, sans-serif" } },
  { value: "times", label: "Serif", style: { fontFamily: "'Times New Roman', Times, serif" } },
  { value: "courier", label: "Mono", style: { fontFamily: "'Courier New', Courier, monospace" } },
];

export function Inspector({ selection, ctx, isPro, logoUrl, designName, onUploadLogo, onRemoveLogo, onResetDesign, onAskRemove, onProOnly, onClose, className }: InspectorProps) {
  const { layout, patchLayout } = ctx;
  const set = <K extends keyof TemplateLayout>(k: K, v: TemplateLayout[K]) => patchLayout((l) => ({ ...l, [k]: v }));
  const binding = selection?.kind === "text" ? makeBinding(selection.id, ctx) : null;
  const kind = binding ? "text" : selection && selection.kind !== "text" ? selection.kind : "page";

  const meta = {
    text: { icon: Type, title: "Text", sub: binding?.label ?? "" },
    image: { icon: ImageIcon, title: "Logo", sub: "Image" },
    header: { icon: LayoutTemplate, title: "Header", sub: "Title area" },
    table: { icon: Table2, title: "Line items", sub: "Table" },
    totals: { icon: Rows3, title: "Totals", sub: "Summary box" },
    page: { icon: Palette, title: "Design", sub: `${designName} template` },
  }[kind];
  const Icon = meta.icon;

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm", className)}>
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-sans text-sm font-semibold leading-tight">{meta.title}</h2>
          <p className="truncate text-xs text-muted-foreground">{meta.sub}</p>
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" aria-label="Close editor panel" onClick={onClose} className="lg:hidden">
            <X />
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {kind === "text" && binding && (
          <>
            <Group title="Content" hint={binding.scope === "design" ? "Part of the template, so it appears on every invoice that uses it." : undefined}>
              {binding.kind === "currency" ? (
                <Select aria-label={binding.label} value={binding.value} onChange={(e) => binding.set(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              ) : binding.kind === "date" ? (
                <Input aria-label={binding.label} type="date" value={binding.value} onChange={(e) => binding.set(e.target.value)} />
              ) : binding.multiline ? (
                <Textarea aria-label={binding.label} rows={4} maxLength={binding.maxLength} value={binding.value} onChange={(e) => binding.set(e.target.value)} />
              ) : (
                <Input aria-label={binding.label} inputMode={binding.kind === "number" ? "decimal" : undefined} maxLength={binding.maxLength} value={binding.value} onChange={(e) => binding.set(e.target.value)} />
              )}
              {binding.remove && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const remove = binding.remove;
                    if (remove) onAskRemove({ title: `${remove.label}?`, description: "It will be taken off this invoice.", confirmLabel: "Remove", run: remove.run });
                  }}
                  className="w-full text-destructive hover:text-destructive"
                >
                  <Trash2 /> {binding.remove.label}
                </Button>
              )}
            </Group>
            <Group title="Font" pro hint="Applies to the whole invoice.">
              <Segmented label="Font" value={layout.font} options={FONT_OPTIONS} onChange={(v) => set("font", v)} />
            </Group>
            {selection?.kind === "text" && selection.id === "title" ? (
              <Group title="Color" pro hint="Colors the title, header band and table header.">
                <ColorField label="Title color" value={layout.primaryColor} onChange={(v) => set("primaryColor", v)} swatches={PRIMARY_SWATCHES} />
              </Group>
            ) : selection?.kind === "text" && selection.id === "footer" ? null : (
              <Group title="Color" pro hint="Applies to all body text.">
                <ColorField label="Text color" value={layout.textColor} onChange={(v) => set("textColor", v)} swatches={TEXT_SWATCHES} />
              </Group>
            )}
          </>
        )}

        {kind === "image" && (
          <LogoPalette layout={layout} logoUrl={logoUrl} set={set} onUploadLogo={onUploadLogo} onRemoveLogo={onRemoveLogo} />
        )}

        {kind === "header" && (
          <>
            <Group title="Header style" pro>
              <Segmented
                label="Header style"
                value={layout.headerStyle}
                options={[
                  { value: "band", label: "Band" },
                  { value: "tinted", label: "Tinted" },
                  { value: "minimal", label: "Minimal" },
                ]}
                onChange={(v) => set("headerStyle", v)}
              />
            </Group>
            <Group title="Colors" pro>
              <ColorField label="Primary" value={layout.primaryColor} onChange={(v) => set("primaryColor", v)} swatches={PRIMARY_SWATCHES} />
              <ColorField label="Accent" value={layout.accentColor} onChange={(v) => set("accentColor", v)} swatches={ACCENT_SWATCHES} />
            </Group>
            <Group title="Logo position" pro hint="Click the logo (or “Add logo”) in the header to upload an image.">
              <LogoPosition layout={layout} set={set} />
            </Group>
          </>
        )}

        {kind === "table" && (
          <>
            <Group title="Columns" hint={isPro ? undefined : "Removing columns is a Pro feature."}>
              <Toggle label="Tax column" checked={layout.showTaxColumn} onChange={(v) => (isPro ? set("showTaxColumn", v) : onProOnly("Removing columns"))} />
              <Toggle label="Discount column" checked={layout.showDiscountColumn} onChange={(v) => (isPro ? set("showDiscountColumn", v) : onProOnly("Removing columns"))} />
            </Group>
            <Group title="Row spacing" pro>
              <Segmented
                label="Row spacing"
                value={layout.density}
                options={[
                  { value: "comfortable", label: "Comfortable" },
                  { value: "compact", label: "Compact" },
                ]}
                onChange={(v) => set("density", v)}
              />
            </Group>
            <Group title="Header color" pro>
              <ColorField label="Table header" value={layout.primaryColor} onChange={(v) => set("primaryColor", v)} swatches={PRIMARY_SWATCHES} />
            </Group>
          </>
        )}

        {kind === "totals" && (
          <Group title="Colors" pro hint="The total box uses a light tint of your primary color with an accent edge.">
            <ColorField label="Primary" value={layout.primaryColor} onChange={(v) => set("primaryColor", v)} swatches={PRIMARY_SWATCHES} />
            <ColorField label="Accent" value={layout.accentColor} onChange={(v) => set("accentColor", v)} swatches={ACCENT_SWATCHES} />
          </Group>
        )}

        {kind === "page" && (
          <>
            <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">Click any text, the logo, the header, the table or the totals on the invoice to edit it here.{isPro ? " Hover a field and click × to remove it from the invoice." : ""}</p>
            <Group title="Font" pro>
              <Segmented label="Font" value={layout.font} options={FONT_OPTIONS} onChange={(v) => set("font", v)} />
            </Group>
            <Group title="Colors" pro>
              <ColorField label="Primary" value={layout.primaryColor} onChange={(v) => set("primaryColor", v)} swatches={PRIMARY_SWATCHES} />
              <ColorField label="Accent" value={layout.accentColor} onChange={(v) => set("accentColor", v)} swatches={ACCENT_SWATCHES} />
              <ColorField label="Text" value={layout.textColor} onChange={(v) => set("textColor", v)} swatches={TEXT_SWATCHES} />
            </Group>
            {layout.hiddenFields.length > 0 && (
              <Group title="Removed fields" hint="Fields you removed from the invoice and the PDF. Restore any of them here.">
                <ul className="space-y-1.5">
                  {layout.hiddenFields.map((id) => (
                    <li key={id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">{REMOVABLE_FIELDS[id] ?? id}</span>
                      <Button variant="outline" size="sm" onClick={() => set("hiddenFields", layout.hiddenFields.filter((h) => h !== id))}>
                        Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              </Group>
            )}
            <Group title="Reset">
              <Button variant="outline" size="sm" className="w-full" onClick={onResetDesign}>
                <RotateCcw /> Reset to {designName}
              </Button>
            </Group>
          </>
        )}
      </div>
    </div>
  );
}

function LogoPosition({ layout, set }: { layout: TemplateLayout; set: <K extends keyof TemplateLayout>(k: K, v: TemplateLayout[K]) => void }) {
  return (
    <Segmented
      label="Logo position"
      value={layout.logoPosition}
      options={[
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
        { value: "none", label: "Hidden" },
      ]}
      onChange={(v) => set("logoPosition", v)}
    />
  );
}

function LogoPalette({ layout, logoUrl, set, onUploadLogo, onRemoveLogo }: { layout: TemplateLayout; logoUrl: string | null; set: <K extends keyof TemplateLayout>(k: K, v: TemplateLayout[K]) => void; onUploadLogo: (file: File) => Promise<void>; onRemoveLogo: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  return (
    <>
      <Group title="Image">
        {logoUrl ? (
          <div className="space-y-2">
            <div className="flex h-20 items-center justify-center rounded-lg border bg-white p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl} alt="Current logo" className="max-h-full max-w-full object-contain" />
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={onRemoveLogo}>
              <Trash2 /> Remove logo
            </Button>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">No logo yet. Upload one below.</p>
        )}
        <FileUpload
          key={resetKey}
          multiple={false}
          maxFiles={1}
          maxFileSize={1024 * 1024}
          acceptedFileTypes={["image/png", "image/jpeg", "image/webp"]}
          onUpload={async (file) => {
            setError(null);
            await onUploadLogo(file);
          }}
          onUploadSuccess={() => setTimeout(() => setResetKey((k) => k + 1), 900)}
          onUploadError={(err) => setError(err.message)}
        />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <p className="text-xs text-muted-foreground">The logo is fitted into a 48 × 22 mm box in the header.</p>
      </Group>
      <Group title="Position" pro>
        <LogoPosition layout={layout} set={set} />
      </Group>
    </>
  );
}
