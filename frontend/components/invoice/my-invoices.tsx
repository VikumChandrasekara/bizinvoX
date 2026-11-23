"use client";

import { Copy, FilePlus2, FileText, Loader2, Lock, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAuthUi } from "@/components/auth/auth-dialog";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { InvoiceCanvas } from "@/components/editor/canvas";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DEFAULT_LAYOUT, draftFromInvoice, formatDate, formatMoney, newDraft, toApiPayload, totals, type Invoice, type InvoiceDraft, type Template, type TemplateLayout } from "@/lib/invoice";
import {
  duplicateLocalInvoice,
  forgetOpenInvoice,
  INVOICE_IMPORTED_EVENT,
  listLocalInvoices,
  LOCAL_INVOICES_EVENT,
  openLocalInvoice,
  renameLocalInvoice,
  renameOpenDraft,
  startBlankInvoice,
  trashLocalInvoice,
  waitForLocalImport,
  type LocalInvoice,
} from "@/lib/local-invoices";
import { cn } from "@/lib/utils";

type Page = { items: Invoice[]; nextCursor: string | null };

/** What one card shows, whether the invoice lives in the account or in this browser. */
export type Row = {
  /** The title shown on the card. */
  number: string;
  /** What the title field starts with when renamed (empty when the invoice has no number yet). */
  name: string;
  client: string;
  issueDate: string;
  edited: string;
  total: string;
  status: "draft" | "paid" | "downloaded";
  locked: boolean;
  /** What the thumbnail draws: the real invoice renderer, exactly as in the template picker. */
  draft: InvoiceDraft;
  layout: TemplateLayout;
  logoUrl: string | null;
  /** Free/guest invoices carry the "Created with bizinvoX.com" footer. */
  branding: boolean;
};

type Open = { href: string } | { onClick: () => void };

export const STATUS_LABEL = { draft: "Draft", paid: "Paid", downloaded: "Downloaded" } as const;
const noop = () => undefined;

function editedLabel(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `Edited ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

export function accountRow(inv: Invoice, isPro: boolean, templates: Map<string, Template>): Row {
  // Pro invoices take their look (and logo) from the template they use; Free ones carry both on the invoice itself.
  const t = isPro ? templates.get(inv.templateId) : undefined;
  const layout = t?.layout ?? inv.layout ?? DEFAULT_LAYOUT;
  const logoUrl = t ? (t.hasLogo ? `/api/v1/templates/${t.id}/logo?v=${encodeURIComponent(t.updatedAt)}` : null) : inv.hasLogo ? `/api/v1/invoices/${inv.id}/logo?v=${encodeURIComponent(inv.updatedAt)}` : null;
  return {
    number: inv.invoiceNumber,
    name: inv.invoiceNumber,
    client: inv.client.name,
    issueDate: inv.issueDate,
    edited: editedLabel(inv.updatedAt),
    total: formatMoney(BigInt(Math.round(Number(inv.grandTotal) * 100)), inv.currency),
    // A free (watermarked) download leaves `status` as draft on the server, since it must stay editable; it still counts as downloaded.
    status: inv.status === "draft" && inv.downloadedAt ? "downloaded" : inv.status,
    locked: inv.locked,
    draft: draftFromInvoice(inv),
    layout: { ...DEFAULT_LAYOUT, ...layout },
    logoUrl,
    branding: !isPro,
  };
}

export const localRow = (e: LocalInvoice): Row => ({
  number: e.draft.invoiceNumber || "Untitled invoice",
  name: e.draft.invoiceNumber,
  client: e.draft.client.name,
  issueDate: e.draft.issueDate,
  edited: editedLabel(e.updatedAt),
  total: formatMoney(totals(e.draft.lineItems).total, e.draft.currency),
  status: e.locked ? "paid" : e.downloadedAt ? "downloaded" : "draft",
  locked: e.locked,
  draft: e.draft,
  layout: { ...DEFAULT_LAYOUT, ...e.layout },
  logoUrl: null,
  branding: true,
});

export const GRID = "grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

/** The "My Invoices" page. Guests see the invoices kept in this browser; signed-in users see the ones saved in their account. */
export function MyInvoices() {
  const { user, loading } = useAuth();

  return (
    <main className="px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
      <div className="mx-auto max-w-6xl">{loading ? <ListSkeleton /> : user ? <AccountInvoices /> : <BrowserInvoices />}</div>
    </main>
  );
}

function Header({ subtitle, onNew }: { subtitle: string; onNew: () => void }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-bold sm:text-4xl">My Invoices</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost">
          <Link href="/recycle-bin">
            <Trash2 /> Recycle bin
          </Link>
        </Button>
        <Button variant="accent" onClick={onNew}>
          <FilePlus2 /> New invoice
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signed in: the database
// ---------------------------------------------------------------------------

function AccountInvoices() {
  const router = useRouter();
  const toast = useToast();
  const { isPro } = useAuth();
  const [items, setItems] = useState<Invoice[] | null>(null);
  const [templates, setTemplates] = useState<Map<string, Template>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const load = useCallback(async (after: string | null) => {
    setError(null);
    try {
      const page = await api<Page>(`/api/v1/invoices?limit=20${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
      setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
      setItems((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    // If the visitor has just signed in, their browser's invoices are still being moved into the account: wait for that.
    void waitForLocalImport().then(() => load(null));
    // ...and refresh whenever one more arrives, so nothing is missing from the list.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onImported = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(null), 300);
    };
    window.addEventListener(INVOICE_IMPORTED_EVENT, onImported);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(INVOICE_IMPORTED_EVENT, onImported);
    };
  }, [load]);

  // Pro invoices are drawn with their template's look and logo.
  useEffect(() => {
    if (!isPro) return;
    api<Template[]>("/api/v1/templates")
      .then((list) => setTemplates(new Map(list.map((t) => [t.id, t]))))
      .catch(() => undefined);
  }, [isPro]);

  async function loadMore() {
    setMore(true);
    await load(cursor);
    setMore(false);
  }

  async function duplicate(id: string) {
    setWorking(id);
    try {
      const copy = await api<Invoice>(`/api/v1/invoices/${id}/duplicate`, { method: "POST" });
      setItems((prev) => [copy, ...(prev ?? [])]);
      toast("Invoice duplicated.", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setWorking(null);
    }
  }

  /** Renames the invoice (its number, which is also printed on it). Throws on failure so the title field can go back. */
  async function rename(inv: Invoice, name: string) {
    try {
      // Pro looks come from the invoice's template; Free/guest looks live on the invoice and are kept as they are.
      const updated = await api<Invoice>(`/api/v1/invoices/${inv.id}`, { method: "PUT", json: toApiPayload({ ...draftFromInvoice(inv), invoiceNumber: name }, isPro ? undefined : (inv.layout ?? undefined)) });
      setItems((prev) => (prev ?? []).map((i) => (i.id === inv.id ? updated : i)));
      renameOpenDraft({ serverId: inv.id }, updated.invoiceNumber);
    } catch (err) {
      toast(errorMessage(err), "error");
      throw err;
    }
  }

  async function remove(id: string) {
    setWorking(id);
    try {
      await api(`/api/v1/invoices/${id}`, { method: "DELETE" });
      setItems((prev) => (prev ?? []).filter((i) => i.id !== id));
      forgetOpenInvoice({ serverId: id }, newDraft());
      toast("Moved to the Recycle bin. You can restore it for 30 days.", "info");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setWorking(null);
    }
  }

  function startNew() {
    startBlankInvoice(newDraft());
    router.push("/#create");
  }

  return (
    <>
      <Header subtitle="Saved to your account, so you can open them from any device." onNew={startNew} />
      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}{" "}
          <button type="button" className="font-medium underline underline-offset-4" onClick={() => void load(null)}>
            Try again
          </button>
        </p>
      )}
      {items === null ? (
        <ListSkeleton bare />
      ) : items.length === 0 && !error ? (
        <Empty />
      ) : (
        <>
          <ul className={GRID}>
            {items.map((inv) => (
              <InvoiceCard
                key={inv.id}
                row={accountRow(inv, isPro, templates)}
                open={{ href: `/?invoice=${inv.id}#create` }}
                onRename={inv.locked ? undefined : (name) => rename(inv, name)}
                busy={working === inv.id}
                onDuplicate={() => void duplicate(inv.id)}
                onAskDelete={() =>
                  setConfirmation({
                    title: `Delete ${inv.invoiceNumber}?`,
                    description: "It moves to the Recycle bin, where you can restore it for 30 days. After that it is deleted for good.",
                    confirmLabel: "Delete invoice",
                    run: () => remove(inv.id),
                  })
                }
              />
            ))}
          </ul>
          {cursor && (
            <div className="mt-6 text-center">
              <Button variant="outline" onClick={() => void loadMore()} disabled={more}>
                {more && <Loader2 className="animate-spin" />} Load more
              </Button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog confirmation={confirmation} busy={working !== null} onClose={() => setConfirmation(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Guest: this browser
// ---------------------------------------------------------------------------

function BrowserInvoices() {
  const router = useRouter();
  const toast = useToast();
  const authUi = useAuthUi();
  const [items, setItems] = useState<LocalInvoice[] | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  useEffect(() => {
    const refresh = () => setItems(listLocalInvoices());
    refresh();
    window.addEventListener(LOCAL_INVOICES_EVENT, refresh);
    window.addEventListener("storage", refresh); // another tab
    return () => {
      window.removeEventListener(LOCAL_INVOICES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  function open(e: LocalInvoice) {
    openLocalInvoice(e);
    // The address names the invoice, like an account invoice's link does.
    router.push(`/?invoice=${e.localId}#create`);
  }

  function remove(e: LocalInvoice) {
    trashLocalInvoice(e.localId);
    forgetOpenInvoice({ localId: e.localId, serverId: e.serverId }, newDraft());
    // A guest's invoice may also have been saved on the server (by downloading or paying). That copy goes to the Recycle bin too.
    if (e.serverId) void api(`/api/v1/invoices/${e.serverId}`, { method: "DELETE" }).catch(() => undefined);
    toast("Moved to the Recycle bin. You can restore it for 30 days.", "info");
  }

  function startNew() {
    startBlankInvoice(newDraft());
    router.push("/#create");
  }

  return (
    <>
      <Header subtitle="Saved in this browser." onNew={startNew} />
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border bg-accent/50 p-4 text-sm">
        <p className="min-w-0 flex-1 text-muted-foreground">
          <strong className="text-foreground">These invoices live only in this browser.</strong> Clearing your browsing data deletes them. Sign up or log in to keep them in your account, on any device.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => authUi.open("login")}>
            Log in
          </Button>
          <Button size="sm" onClick={() => authUi.open("signup")}>
            Sign up
          </Button>
        </div>
      </div>
      {items === null ? (
        <ListSkeleton bare />
      ) : items.length === 0 ? (
        <Empty />
      ) : (
        <ul className={GRID}>
          {items.map((e) => (
            <InvoiceCard
              key={e.localId}
              row={localRow(e)}
              open={{ onClick: () => open(e) }}
              onRename={e.locked ? undefined : async (name) => renameLocalInvoice(e.localId, name)}
              busy={false}
              onDuplicate={() => {
                duplicateLocalInvoice(e, newDraft());
                toast("Invoice duplicated.", "success");
              }}
              onAskDelete={() =>
                setConfirmation({
                  title: `Delete ${e.draft.invoiceNumber || "this invoice"}?`,
                  description: e.locked ? "This invoice has been paid for. It moves to the Recycle bin, where you can restore it for 30 days. After that it is deleted for good." : "It moves to the Recycle bin, where you can restore it for 30 days. After that it is deleted for good.",
                  confirmLabel: "Delete invoice",
                  run: () => remove(e),
                })
              }
            />
          ))}
        </ul>
      )}
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** A link (account invoices) or a button (browser invoices) that opens the invoice in the editor. */
function OpenTarget({ open, className, label, children }: { open: Open; className?: string; label: string; children: React.ReactNode }) {
  return "href" in open ? (
    <Link href={open.href} aria-label={label} className={className}>
      {children}
    </Link>
  ) : (
    <button type="button" onClick={open.onClick} aria-label={label} className={className}>
      {children}
    </button>
  );
}

/** One saved invoice, drawn as a live miniature of the real invoice (like the cards in the template picker). */
function InvoiceCard({
  row,
  open,
  onRename,
  busy,
  onDuplicate,
  onAskDelete,
}: {
  row: Row;
  open: Open;
  /** Absent when the invoice can't be renamed (paid for, so locked). */
  onRename?: (name: string) => Promise<void>;
  busy: boolean;
  onDuplicate: () => void;
  /** Deleting moves the invoice to the Recycle bin: the page still asks first. */
  onAskDelete: () => void;
}) {
  return (
    <li className="group rounded-xl border bg-card p-2 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
      <OpenTarget open={open} label={`Open ${row.number}`} className="block w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {/* A fixed page-shaped window, so every card lines up however long the invoice is. */}
        <div className="aspect-[794/1123] overflow-hidden rounded-md border bg-white">
          <InvoiceCanvas thumbnail branding={row.branding} logoUrl={row.logoUrl} ctx={{ draft: row.draft, layout: row.layout, patchDraft: noop, patchLayout: noop }} />
        </div>
      </OpenTarget>

      <div className="mt-2.5 space-y-1 px-1">
        <div className="flex items-center justify-between gap-2">
          <EditableTitle title={row.number} value={row.name} onSave={onRename} />
          <Badge variant={row.status} className="shrink-0">
            {row.locked && <Lock className="size-3" />} {STATUS_LABEL[row.status]}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">{row.client || "No client yet"}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {formatDate(row.issueDate)}
          {row.edited && ` · ${row.edited}`}
        </p>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 px-1 pb-1">
        <span className="font-display text-base font-bold tabular-nums">{row.total}</span>
        <div className="flex items-center gap-0.5">
          <OpenTarget open={open} label={`Open ${row.number} in the editor`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mr-1")}>
            Open
          </OpenTarget>
          <Button size="icon" variant="ghost" className="size-8" aria-label={`Duplicate ${row.number}`} title="Duplicate" onClick={onDuplicate} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Copy />}
          </Button>
          <Button size="icon" variant="ghost" className="size-8" aria-label={`Delete ${row.number}`} title="Delete" onClick={onAskDelete} disabled={busy}>
            <Trash2 />
          </Button>
        </div>
      </div>
    </li>
  );
}

/** The invoice's name. Click it to turn it into a field and rename: Enter or clicking away saves, Escape cancels. */
function EditableTitle({ title, value, onSave }: { title: string; value: string; onSave?: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);
  // Enter and the blur it triggers must not save twice, and Escape must not save on blur.
  const done = useRef(false);

  if (!onSave) return <span className="truncate text-sm font-semibold">{title}</span>;

  function begin() {
    done.current = false;
    setText(value);
    setEditing(true);
  }

  async function commit() {
    if (done.current) return;
    done.current = true;
    const name = text.trim();
    if (!name || name === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave?.(name);
      setEditing(false);
    } catch {
      // The error is already shown; put the old name back.
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button type="button" onClick={begin} title="Rename" aria-label={`Rename ${title}`} className="group/title -mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-sm font-semibold hover:bg-accent">
        <span className="truncate">{title}</span>
        <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition group-hover/title:opacity-100 group-focus-visible/title:opacity-100" aria-hidden />
      </button>
    );
  }

  return (
    <span className="relative min-w-0 flex-1">
      <input
        autoFocus
        value={text}
        maxLength={40}
        disabled={saving}
        placeholder="Invoice name"
        aria-label="Invoice name"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            done.current = true;
            setEditing(false);
          }
        }}
        className="h-7 w-full min-w-0 rounded-md border border-primary bg-background px-2 text-sm font-semibold outline-none ring-2 ring-primary/30 disabled:opacity-60"
      />
      {saving && <Loader2 className="absolute right-2 top-1.5 size-4 animate-spin text-muted-foreground" />}
    </span>
  );
}

function Empty() {
  return (
    <div className="rounded-2xl border border-dashed p-10 text-center">
      <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <FileText className="size-5" />
      </span>
      <h2 className="mt-4 font-sans text-base font-semibold">No invoices yet</h2>
      <p className="mt-1 text-sm text-muted-foreground">Invoices you create show up here.</p>
      <Button asChild className="mt-5">
        <Link href="/#create">Create an invoice</Link>
      </Button>
    </div>
  );
}

function ListSkeleton({ bare = false }: { bare?: boolean }) {
  const cards = (
    <div className={GRID} aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="aspect-[794/1300] w-full rounded-xl" />
      ))}
    </div>
  );
  if (bare) return cards;
  return (
    <>
      <Skeleton className="mb-6 h-14 w-64" />
      {cards}
    </>
  );
}
