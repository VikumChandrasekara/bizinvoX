"use client";

import { ArrowLeft, Bookmark, FileText, Loader2, Lock, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { InvoiceCanvas } from "@/components/editor/canvas";
import { accountRow, GRID, localRow, STATUS_LABEL, type Row } from "@/components/invoice/my-invoices";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { SAMPLE_DRAFT } from "@/lib/designs";
import { RECYCLE_BIN_DAYS, type Invoice, type Template } from "@/lib/invoice";
import { emptyLocalTrash, listTrashedLocalInvoices, LOCAL_INVOICES_EVENT, purgeLocalInvoice, restoreLocalInvoice, type TrashedLocalInvoice } from "@/lib/local-invoices";

const noop = () => undefined;
const DAY = 86_400_000;

/** Whole days until the 30 days are up (never negative). */
function daysLeft(deletedAt: string) {
  const left = new Date(deletedAt).getTime() + RECYCLE_BIN_DAYS * DAY - Date.now();
  return Math.max(0, Math.ceil(left / DAY));
}

function deletedLabel(deletedAt: string) {
  const d = new Date(deletedAt);
  const when = Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const left = daysLeft(deletedAt);
  return { when: when && `Deleted ${when}`, left: left === 0 ? "Deleted for good today" : `Deleted for good in ${left} ${left === 1 ? "day" : "days"}` };
}

/** The "Recycle bin" page: deleted invoices (and, for Pro, saved templates) wait here for 30 days and can be restored. */
export function RecycleBin() {
  const { user, loading } = useAuth();
  return (
    <main className="px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
      <div className="mx-auto max-w-6xl">{loading ? <BinSkeleton /> : user ? <AccountBin /> : <BrowserBin />}</div>
    </main>
  );
}

function Header({ subtitle, canEmpty, onEmpty }: { subtitle: string; canEmpty: boolean; onEmpty: () => void }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <Link href="/invoices" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> My Invoices
        </Link>
        <h1 className="text-3xl font-bold sm:text-4xl">Recycle bin</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <Button variant="outline" onClick={onEmpty} disabled={!canEmpty} className="text-destructive hover:text-destructive">
        <Trash2 /> Empty recycle bin
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signed in: the account's recycle bin
// ---------------------------------------------------------------------------

function AccountBin() {
  const toast = useToast();
  const { isPro } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [lookup, setLookup] = useState<Map<string, Template>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setInvoices(await api<Invoice[]>("/api/v1/invoices/trash"));
      if (isPro) {
        const [trashed, live] = await Promise.all([api<Template[]>("/api/v1/templates/trash"), api<Template[]>("/api/v1/templates")]);
        setTemplates(trashed);
        setLookup(new Map(live.map((t) => [t.id, t])));
      }
    } catch (err) {
      setError(errorMessage(err));
      setInvoices((prev) => prev ?? []);
    }
  }, [isPro]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(id: string, job: () => Promise<void>) {
    setWorking(id);
    try {
      await job();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setWorking(null);
    }
  }

  const restoreInvoice = (inv: Invoice) =>
    run(inv.id, async () => {
      await api(`/api/v1/invoices/${inv.id}/restore`, { method: "POST" });
      setInvoices((prev) => (prev ?? []).filter((i) => i.id !== inv.id));
      toast(`Restored ${inv.invoiceNumber}. It is back in My Invoices.`, "success");
    });

  const purgeInvoice = (inv: Invoice) =>
    run(inv.id, async () => {
      await api(`/api/v1/invoices/${inv.id}/permanent`, { method: "DELETE" });
      setInvoices((prev) => (prev ?? []).filter((i) => i.id !== inv.id));
      toast("Deleted for good.", "info");
    });

  const restoreTemplate = (t: Template) =>
    run(t.id, async () => {
      await api(`/api/v1/templates/${t.id}/restore`, { method: "POST" });
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
      toast(`Restored “${t.name}”. It is back in My templates.`, "success");
    });

  const purgeTemplate = (t: Template) =>
    run(t.id, async () => {
      await api(`/api/v1/templates/${t.id}/permanent`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
      toast("Deleted for good.", "info");
    });

  const emptyAll = () =>
    run("all", async () => {
      await api("/api/v1/invoices/trash", { method: "DELETE" });
      if (isPro) await api("/api/v1/templates/trash", { method: "DELETE" });
      setInvoices([]);
      setTemplates([]);
      toast("Recycle bin emptied.", "info");
    });

  const count = (invoices?.length ?? 0) + templates.length;

  return (
    <>
      <Header
        subtitle={`Deleted invoices${isPro ? " and templates" : ""} stay here for ${RECYCLE_BIN_DAYS} days. Restore them, or they are deleted for good.`}
        canEmpty={count > 0 && working === null}
        onEmpty={() =>
          setConfirmation({
            title: "Empty the Recycle bin?",
            description: `Everything in it (${count} ${count === 1 ? "item" : "items"}) is deleted for good. This can't be undone.`,
            confirmLabel: "Empty recycle bin",
            run: emptyAll,
          })
        }
      />
      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}{" "}
          <button type="button" className="font-medium underline underline-offset-4" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {invoices === null ? (
        <BinSkeleton bare />
      ) : count === 0 && !error ? (
        <EmptyBin />
      ) : (
        <div className="space-y-10">
          {invoices.length > 0 && (
            <Section icon={FileText} title="Invoices" count={invoices.length}>
              {invoices.map((inv) => (
                <InvoiceBinCard
                  key={inv.id}
                  row={accountRow(inv, isPro, lookup)}
                  deletedAt={inv.deletedAt ?? inv.updatedAt}
                  busy={working === inv.id || working === "all"}
                  onRestore={() => void restoreInvoice(inv)}
                  onAskPurge={() =>
                    setConfirmation({
                      title: `Delete ${inv.invoiceNumber} for good?`,
                      description: "It is removed from the Recycle bin and can't be restored.",
                      confirmLabel: "Delete for good",
                      run: () => purgeInvoice(inv),
                    })
                  }
                />
              ))}
            </Section>
          )}
          {templates.length > 0 && (
            <Section icon={Bookmark} title="Templates" count={templates.length}>
              {templates.map((t) => (
                <TemplateBinCard
                  key={t.id}
                  template={t}
                  deletedAt={t.deletedAt ?? t.updatedAt}
                  busy={working === t.id || working === "all"}
                  onRestore={() => void restoreTemplate(t)}
                  onAskPurge={() =>
                    setConfirmation({
                      title: `Delete “${t.name}” for good?`,
                      description: "It is removed from the Recycle bin and can't be restored.",
                      confirmLabel: "Delete for good",
                      run: () => purgeTemplate(t),
                    })
                  }
                />
              ))}
            </Section>
          )}
        </div>
      )}
      <ConfirmDialog confirmation={confirmation} busy={working !== null} onClose={() => setConfirmation(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Guest: this browser's recycle bin
// ---------------------------------------------------------------------------

function BrowserBin() {
  const toast = useToast();
  const [items, setItems] = useState<TrashedLocalInvoice[] | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  useEffect(() => {
    const refresh = () => setItems(listTrashedLocalInvoices());
    refresh();
    window.addEventListener(LOCAL_INVOICES_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(LOCAL_INVOICES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // A guest's invoice may also have been saved on the server (by downloading or paying): its copy follows what happens here.
  function restore(e: TrashedLocalInvoice) {
    restoreLocalInvoice(e.localId);
    if (e.serverId) void api(`/api/v1/invoices/${e.serverId}/restore`, { method: "POST" }).catch(() => undefined);
    toast(`Restored ${e.draft.invoiceNumber || "the invoice"}. It is back in My Invoices.`, "success");
  }

  function purge(e: TrashedLocalInvoice) {
    purgeLocalInvoice(e.localId);
    if (e.serverId) void api(`/api/v1/invoices/${e.serverId}/permanent`, { method: "DELETE" }).catch(() => undefined);
    toast("Deleted for good.", "info");
  }

  function emptyAll() {
    for (const e of items ?? []) if (e.serverId) void api(`/api/v1/invoices/${e.serverId}/permanent`, { method: "DELETE" }).catch(() => undefined);
    emptyLocalTrash();
    toast("Recycle bin emptied.", "info");
  }

  return (
    <>
      <Header
        subtitle={`Deleted invoices stay in this browser for ${RECYCLE_BIN_DAYS} days. Restore them, or they are deleted for good.`}
        canEmpty={(items?.length ?? 0) > 0}
        onEmpty={() =>
          setConfirmation({
            title: "Empty the Recycle bin?",
            description: `Everything in it (${items?.length ?? 0} ${items?.length === 1 ? "invoice" : "invoices"}) is deleted for good. This can't be undone.`,
            confirmLabel: "Empty recycle bin",
            run: emptyAll,
          })
        }
      />
      {items === null ? (
        <BinSkeleton bare />
      ) : items.length === 0 ? (
        <EmptyBin />
      ) : (
        <Section icon={FileText} title="Invoices" count={items.length}>
          {items.map((e) => (
            <InvoiceBinCard
              key={e.localId}
              row={localRow(e)}
              deletedAt={e.deletedAt}
              busy={false}
              onRestore={() => restore(e)}
              onAskPurge={() =>
                setConfirmation({
                  title: `Delete ${e.draft.invoiceNumber || "this invoice"} for good?`,
                  description: "It is removed from the Recycle bin and can't be restored.",
                  confirmLabel: "Delete for good",
                  run: () => purge(e),
                })
              }
            />
          ))}
        </Section>
      )}
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Section({ icon: Icon, title, count, children }: { icon: typeof FileText; title: string; count: number; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-3 flex items-center gap-2 font-sans text-base font-semibold">
        <Icon className="size-4 text-primary" aria-hidden /> {title}
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{count}</span>
      </h2>
      <ul className={GRID}>{children}</ul>
    </section>
  );
}

function BinActions({ name, busy, onRestore, onAskPurge }: { name: string; busy: boolean; onRestore: () => void; onAskPurge: () => void }) {
  return (
    <div className="mt-2 flex items-center justify-end gap-2 px-1 pb-1">
      <div className="flex shrink-0 items-center gap-0.5">
        <Button size="sm" variant="outline" onClick={onRestore} disabled={busy} className="mr-1" aria-label={`Restore ${name}`}>
          {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Restore
        </Button>
        <Button size="icon" variant="ghost" className="size-8 text-destructive hover:text-destructive" aria-label={`Delete ${name} for good`} title="Delete for good" onClick={onAskPurge} disabled={busy}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

function InvoiceBinCard({ row, deletedAt, busy, onRestore, onAskPurge }: { row: Row; deletedAt: string; busy: boolean; onRestore: () => void; onAskPurge: () => void }) {
  const label = deletedLabel(deletedAt);
  return (
    <li className="rounded-xl border bg-card p-2 shadow-sm">
      {/* Greyed out: it is in the bin, so it can't be opened until it is restored. */}
      <div className="aspect-[794/1123] overflow-hidden rounded-md border bg-white opacity-70 grayscale-[40%]">
        <InvoiceCanvas thumbnail branding={row.branding} logoUrl={row.logoUrl} ctx={{ draft: row.draft, layout: row.layout, patchDraft: noop, patchLayout: noop }} />
      </div>
      <div className="mt-2.5 space-y-1 px-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">{row.number}</span>
          <Badge variant={row.status} className="shrink-0">
            {row.locked && <Lock className="size-3" />} {STATUS_LABEL[row.status]}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">{row.client || "No client yet"}</p>
        <p className="truncate text-[11px] text-muted-foreground">{label.when}</p>
        <p className="truncate text-[11px] font-medium text-amber-600 dark:text-amber-400">{label.left}</p>
      </div>
      <BinActions name={row.number} busy={busy} onRestore={onRestore} onAskPurge={onAskPurge} />
    </li>
  );
}

function TemplateBinCard({ template, deletedAt, busy, onRestore, onAskPurge }: { template: Template; deletedAt: string; busy: boolean; onRestore: () => void; onAskPurge: () => void }) {
  const label = deletedLabel(deletedAt);
  return (
    <li className="rounded-xl border bg-card p-2 shadow-sm">
      <div className="overflow-hidden rounded-md border bg-white opacity-70 grayscale-[40%]">
        <InvoiceCanvas
          thumbnail
          branding={false}
          logoUrl={template.hasLogo ? `/api/v1/templates/${template.id}/logo?v=${encodeURIComponent(template.updatedAt)}` : null}
          ctx={{ draft: SAMPLE_DRAFT, layout: template.layout, patchDraft: noop, patchLayout: noop }}
        />
      </div>
      <div className="mt-2.5 space-y-1 px-1">
        <span className="block truncate text-sm font-semibold">{template.name}</span>
        <p className="truncate text-[11px] text-muted-foreground">{label.when}</p>
        <p className="truncate text-[11px] font-medium text-amber-600 dark:text-amber-400">{label.left}</p>
      </div>
      <BinActions name={template.name} busy={busy} onRestore={onRestore} onAskPurge={onAskPurge} />
    </li>
  );
}

function EmptyBin() {
  return (
    <div className="rounded-2xl border border-dashed p-10 text-center">
      <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Trash2 className="size-5" />
      </span>
      <h2 className="mt-4 font-sans text-base font-semibold">The Recycle bin is empty</h2>
      <p className="mt-1 text-sm text-muted-foreground">Invoices and templates you delete wait here for {RECYCLE_BIN_DAYS} days before they are gone for good.</p>
      <Button asChild className="mt-5">
        <Link href="/invoices">Back to My Invoices</Link>
      </Button>
    </div>
  );
}

function BinSkeleton({ bare = false }: { bare?: boolean }) {
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
