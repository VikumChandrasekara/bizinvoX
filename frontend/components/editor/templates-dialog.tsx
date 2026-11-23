"use client";

import { Bookmark, BookmarkPlus, Check, Crown, Loader2, Lock, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { InvoiceCanvas } from "@/components/editor/canvas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DESIGNS, SAMPLE_DRAFT, type DesignKey } from "@/lib/designs";
import type { Template } from "@/lib/invoice";
import { cn } from "@/lib/utils";

const noop = () => undefined;
const NAME_MAX = 40;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  active: DesignKey;
  edited: boolean;
  isPro: boolean;
  onPick: (key: DesignKey) => void;
  disabled?: boolean;
  /** The Pro user's saved templates ("My templates"). */
  saved: Template[];
  logoSrc: (t: Template) => string;
  /** Saves the look currently on the invoice as a new named template. Rejects (after showing why) when it fails. */
  onSave: (name: string) => Promise<void>;
  /** Updates the saved template the invoice belongs to, straight away. Resolves false when there is none (a new template: ask for a name). */
  onQuickSave: () => Promise<boolean>;
  onApplySaved: (t: Template) => void;
  onRename: (t: Template, name: string) => Promise<void>;
  onDelete: (t: Template) => Promise<void>;
  /** Not Pro: take them to the plans. */
  onUpgrade: () => void;
};

/** The built-in designs plus, for Pro, the user's own saved templates. Every card is a live miniature of the real invoice renderer. */
export function TemplatesDialog({ open, onOpenChange, active, edited, isPro, onPick, disabled, saved, logoSrc, onSave, onQuickSave, onApplySaved, onRename, onDelete, onUpgrade }: Props) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Choose a template</DialogTitle>
            <DialogDescription>
              {isPro ? "Pick a look. Your invoice content stays exactly as it is, and you can keep editing afterwards." : "Classic is included for everyone. The other templates are Pro: you can preview them, but editing and downloading need Pro."}
            </DialogDescription>
          </DialogHeader>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5" aria-label="Invoice templates">
            {DESIGNS.map((d) => {
              const selected = d.key === active;
              return (
                <li key={d.key}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    aria-label={`${d.name} template${d.key === "classic" ? "" : isPro ? " (Pro design)" : " (Pro design, preview only)"}: ${d.tagline}`}
                    onClick={() => {
                      onPick(d.key);
                      onOpenChange(false);
                    }}
                    className={cn(
                      "group block w-full rounded-xl border bg-card p-2 text-left transition hover:-translate-y-0.5 hover:shadow-md disabled:pointer-events-none disabled:opacity-60",
                      selected ? "border-primary ring-2 ring-primary/40" : "hover:border-primary/40",
                    )}
                  >
                    <div className="overflow-hidden rounded-md border bg-white">
                      <InvoiceCanvas thumbnail branding={false} logoUrl={null} ctx={{ draft: SAMPLE_DRAFT, layout: d.layout, patchDraft: noop, patchLayout: noop }} />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 px-0.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-semibold">
                          {d.name}
                          {d.key !== "classic" && <Crown className="size-3 text-amber-500" aria-hidden />}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">{selected && edited ? "Customized" : !isPro && d.key !== "classic" ? "Preview only · Pro" : d.tagline}</div>
                      </div>
                      {selected && (
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="size-3" />
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          <section aria-labelledby="my-templates-title" className="mt-2 border-t pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="my-templates-title" className="flex items-center gap-1.5 font-sans text-base font-semibold">
                  <Bookmark className="size-4 text-primary" aria-hidden /> My templates
                  {!isPro && <Crown className="size-3.5 text-amber-500" aria-label="Pro" />}
                </h3>
                <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
                  Save the invoice you are editing as a starting point: its look, logo, your business details, footer, payment terms and notes. Choosing it starts a new invoice with an empty client, items, number and dates.
                </p>
              </div>
              {isPro && <SaveForm count={saved.length} onSave={onSave} onQuickSave={onQuickSave} />}
            </div>
            {isPro && (
              <p className="mt-2 text-xs text-muted-foreground">
                Deleted templates wait 30 days in the{" "}
                <Link href="/recycle-bin" className="font-medium text-primary underline-offset-4 hover:underline">
                  Recycle bin
                </Link>
                , so you can restore them.
              </p>
            )}

            {!isPro ? (
              <div className="mt-4 flex flex-col items-start gap-3 rounded-xl border border-dashed bg-muted/30 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
                    <Lock className="size-4" aria-hidden />
                  </span>
                  <div>
                    <div className="text-sm font-semibold">Creating and saving your own templates is a Pro feature</div>
                    <div className="text-sm text-muted-foreground">Upgrade to keep your branding as templates, with your logo, ready for every invoice.</div>
                  </div>
                </div>
                <Button size="sm" onClick={onUpgrade}>
                  <Crown /> See Pro
                </Button>
              </div>
            ) : saved.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed p-5 text-center text-sm text-muted-foreground">No saved templates yet. Style an invoice, then choose “Save as template”.</p>
            ) : (
              <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5" aria-label="My templates">
                {saved.map((t) => (
                  <SavedCard
                    key={t.id}
                    template={t}
                    logoUrl={t.hasLogo ? logoSrc(t) : null}
                    onApply={() => {
                      onApplySaved(t);
                      onOpenChange(false);
                    }}
                    onRename={(name) => onRename(t, name)}
                    onAskDelete={() =>
                      setConfirmation({
                        title: `Delete “${t.name}”?`,
                        description: "It moves to the Recycle bin, where you can restore it for 30 days. After that it is deleted for good. Invoices you already made with it keep their look.",
                        confirmLabel: "Move to Recycle bin",
                        run: () => onDelete(t),
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </DialogContent>
      </Dialog>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
    </>
  );
}

/** "Save as template": a button that turns into a name field. */
function SaveForm({ count, onSave, onQuickSave }: { count: number; onSave: (name: string) => Promise<void>; onQuickSave: () => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  /** An invoice that belongs to a saved template just updates it; only a new look asks for a name. */
  async function start() {
    if (checking) return;
    setChecking(true);
    try {
      if (await onQuickSave()) return;
    } finally {
      setChecking(false);
    }
    setName(`My template ${count + 1}`);
    setOpen(true);
  }

  async function submit() {
    const n = name.trim();
    if (!n || saving) return;
    setSaving(true);
    try {
      await onSave(n);
      setOpen(false);
    } catch {
      /* the reason is already shown; keep the name so they can try again */
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" disabled={checking} onClick={() => void start()}>
        {checking ? <Loader2 className="animate-spin" /> : <BookmarkPlus />} Save as template
      </Button>
    );
  }
  return (
    <form
      className="flex w-full items-center gap-2 sm:w-auto"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={NAME_MAX}
        disabled={saving}
        placeholder="Template name"
        aria-label="Template name"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:w-52"
      />
      <Button type="submit" variant="accent" disabled={saving || !name.trim()}>
        {saving && <Loader2 className="animate-spin" />} Save
      </Button>
      <Button type="button" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

function SavedCard({ template, logoUrl, disabled, onApply, onRename, onAskDelete }: { template: Template; logoUrl: string | null; disabled?: boolean; onApply: () => void; onRename: (name: string) => Promise<void>; onAskDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(template.name);
  const [saving, setSaving] = useState(false);
  // Enter and the blur it triggers must not save twice, and Escape must not save on blur.
  const done = useRef(false);

  async function commit() {
    if (done.current) return;
    done.current = true;
    const name = text.trim();
    if (!name || name === template.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onRename(name);
    } catch {
      /* the reason is already shown; the old name stays */
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  return (
    <li className="group/card relative rounded-xl border bg-card p-2 transition hover:border-primary/40 hover:shadow-md">
      <button type="button" disabled={disabled} onClick={onApply} aria-label={`Start a new invoice from my template ${template.name}`} className="block w-full text-left disabled:pointer-events-none disabled:opacity-60">
        <div className="overflow-hidden rounded-md border bg-white">
          <InvoiceCanvas thumbnail branding={false} logoUrl={logoUrl} ctx={{ draft: SAMPLE_DRAFT, layout: template.layout, patchDraft: noop, patchLayout: noop }} />
        </div>
      </button>
      <div className="mt-2 flex items-center justify-between gap-1 px-0.5">
        {editing ? (
          <input
            autoFocus
            value={text}
            maxLength={NAME_MAX}
            disabled={saving}
            aria-label="Template name"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") {
                e.stopPropagation();
                done.current = true;
                setEditing(false);
              }
            }}
            className="h-7 w-full min-w-0 rounded-md border border-primary bg-background px-2 text-sm font-semibold outline-none ring-2 ring-primary/30 disabled:opacity-60"
          />
        ) : (
          <>
            <button
              type="button"
              title="Rename"
              aria-label={`Rename ${template.name}`}
              onClick={() => {
                done.current = false;
                setText(template.name);
                setEditing(true);
              }}
              className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-sm font-semibold hover:bg-accent"
            >
              <span className="truncate">{template.name}</span>
              <Pencil className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            </button>
            <button type="button" title="Delete template" aria-label={`Delete ${template.name}`} onClick={onAskDelete} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="size-4" aria-hidden />
            </button>
          </>
        )}
      </div>
    </li>
  );
}
