"use client";

/** "My Invoices" for guests: every invoice a guest works on is kept in this browser (localStorage).
 *  Signed-in users never use this: their invoices live in the database under their login, and any invoices
 *  left over from before they signed in are moved there once (see `importLocalInvoices`). */

import { api, ApiError } from "@/lib/api";
import { RECYCLE_BIN_DAYS, toApiPayload, type InvoiceDraft, type TemplateLayout } from "@/lib/invoice";

/** The invoice currently open in the editor (the editor restores itself from this on load). */
export const LOCAL_DRAFT_KEY = "big:draft:v2";
const LIBRARY_KEY = "big:invoices:v1";
/** Keep the library small enough for localStorage and in step with the server's guest limit. */
const MAX_LOCAL_INVOICES = 50;

export const LOCAL_INVOICES_EVENT = "big:local-invoices";
export const INVOICE_IMPORTED_EVENT = "big:invoice-imported";

export type LocalInvoice = {
  localId: string;
  /** Set once the invoice has also been saved on the server (a download or a payment does that). */
  serverId: string | null;
  draft: InvoiceDraft;
  /** The invoice's own (Classic) look. */
  layout: TemplateLayout;
  /** Paid for, so it can't be edited any more. */
  locked: boolean;
  /** When its PDF was last downloaded here, if ever. */
  downloadedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export function newLocalId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** True once anything has been typed into the invoice. Used to tell a restored draft the user already worked on
 *  from a brand-new blank one. (A new invoice keeps your business details, so those alone don't count here: the editor
 *  tracks first edits itself.) */
export function hasContent(d: InvoiceDraft): boolean {
  const filled = (p: InvoiceDraft["business"]) => Object.values(p).some((v) => v.trim());
  return Boolean(
    filled(d.client) ||
      filled(d.business) ||
      d.invoiceNumber.trim() ||
      d.notes.trim() ||
      d.lineItems.some((l) => l.description.trim() || (l.unitPrice.trim() && l.unitPrice.trim() !== "0") || l.quantity.trim() !== "1" || (l.taxRate.trim() && l.taxRate.trim() !== "0") || (l.discountRate.trim() && l.discountRate.trim() !== "0")),
  );
}

function read(): LocalInvoice[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const list = raw ? (JSON.parse(raw) as LocalInvoice[]) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.localId === "string" && e.draft) : [];
  } catch {
    return [];
  }
}

function write(list: LocalInvoice[]) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
  } catch {
    /* storage full or disabled: the current draft is still kept separately */
  }
  window.dispatchEvent(new Event(LOCAL_INVOICES_EVENT));
}

/** Newest first. */
export function listLocalInvoices(): LocalInvoice[] {
  return read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function findLocalIdByServerId(serverId: string): string | null {
  return read().find((e) => e.serverId === serverId)?.localId ?? null;
}

/** Adds or updates an invoice. Nothing is written (and `updatedAt` doesn't move) when it hasn't actually changed. */
export function upsertLocalInvoice(entry: Omit<LocalInvoice, "createdAt" | "updatedAt" | "downloadedAt">) {
  const list = read();
  const i = list.findIndex((e) => e.localId === entry.localId);
  const same = (a: LocalInvoice) => a.serverId === entry.serverId && a.locked === entry.locked && JSON.stringify(a.draft) === JSON.stringify(entry.draft) && JSON.stringify(a.layout) === JSON.stringify(entry.layout);
  if (i >= 0 && same(list[i])) return;
  const now = new Date().toISOString();
  if (i >= 0) list[i] = { ...entry, createdAt: list[i].createdAt, updatedAt: now, downloadedAt: list[i].downloadedAt };
  else list.push({ ...entry, createdAt: now, updatedAt: now });
  write(list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_LOCAL_INVOICES));
}

/** One saved invoice by its id in the address bar (`?invoice=<localId>`). */
export function getLocalInvoice(localId: string): LocalInvoice | null {
  return read().find((e) => e.localId === localId) ?? null;
}

/** The PDF was downloaded: the invoice stops being shown as a plain draft. */
export function markLocalDownloaded(localId: string) {
  const list = read();
  const i = list.findIndex((e) => e.localId === localId);
  if (i < 0) return;
  list[i] = { ...list[i], downloadedAt: new Date().toISOString() };
  write(list);
}

/** Takes an invoice out of the library for good. Deleting something the user can see goes to the recycle bin instead
 *  (`trashLocalInvoice`); this is for housekeeping such as an invoice that has just moved into the account. */
export function removeLocalInvoice(localId: string) {
  const list = read();
  if (list.some((e) => e.localId === localId)) write(list.filter((e) => e.localId !== localId));
}

// ---------------------------------------------------------------------------
// Recycle bin: deleted invoices wait here for 30 days, then disappear
// ---------------------------------------------------------------------------

const TRASH_KEY = "big:invoices-trash:v1";

export type TrashedLocalInvoice = LocalInvoice & { deletedAt: string };

const expired = (deletedAt: string) => Date.now() - new Date(deletedAt).getTime() > RECYCLE_BIN_DAYS * 86_400_000;

function readTrash(): TrashedLocalInvoice[] {
  try {
    const raw = localStorage.getItem(TRASH_KEY);
    const list = raw ? (JSON.parse(raw) as TrashedLocalInvoice[]) : [];
    const valid = Array.isArray(list) ? list.filter((e) => e && typeof e.localId === "string" && e.draft && typeof e.deletedAt === "string") : [];
    const kept = valid.filter((e) => !expired(e.deletedAt));
    // Anything past its 30 days is dropped the next time the bin is read.
    if (kept.length !== valid.length) writeTrash(kept);
    return kept;
  } catch {
    return [];
  }
}

function writeTrash(list: TrashedLocalInvoice[]) {
  try {
    localStorage.setItem(TRASH_KEY, JSON.stringify(list));
  } catch {
    /* storage full or disabled */
  }
  window.dispatchEvent(new Event(LOCAL_INVOICES_EVENT));
}

/** Most recently deleted first. */
export function listTrashedLocalInvoices(): TrashedLocalInvoice[] {
  return readTrash().sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Moves an invoice from the library to the recycle bin. */
export function trashLocalInvoice(localId: string) {
  const entry = read().find((e) => e.localId === localId);
  if (!entry) return;
  writeTrash([{ ...entry, deletedAt: new Date().toISOString() }, ...readTrash().filter((e) => e.localId !== localId)]);
  removeLocalInvoice(localId);
}

/** Puts a trashed invoice back in the library (as it was, including when it was last edited). */
export function restoreLocalInvoice(localId: string) {
  const entry = readTrash().find((e) => e.localId === localId);
  if (!entry) return;
  const { deletedAt: _deletedAt, ...invoice } = entry;
  void _deletedAt;
  const list = read().filter((e) => e.localId !== localId);
  list.push(invoice);
  write(list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_LOCAL_INVOICES));
  writeTrash(readTrash().filter((e) => e.localId !== localId));
}

/** Deletes one invoice from the recycle bin for good. */
export function purgeLocalInvoice(localId: string) {
  writeTrash(readTrash().filter((e) => e.localId !== localId));
}

export function emptyLocalTrash() {
  writeTrash([]);
}

type StoredDraft = { draft: InvoiceDraft; invoiceId: string | null; layout?: TemplateLayout; designKey?: string; classicLayout?: TemplateLayout | null; localId?: string };

function readCurrent(): StoredDraft | null {
  try {
    const raw = localStorage.getItem(LOCAL_DRAFT_KEY);
    return raw ? (JSON.parse(raw) as StoredDraft) : null;
  } catch {
    return null;
  }
}

function writeCurrent(v: StoredDraft | null) {
  try {
    if (v) localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(v));
    else localStorage.removeItem(LOCAL_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/** Makes `entry` the invoice the editor opens with. */
export function openLocalInvoice(entry: LocalInvoice) {
  writeCurrent({ draft: entry.draft, invoiceId: entry.serverId, layout: entry.layout, designKey: "classic", classicLayout: null, localId: entry.localId });
}

/** The editor opens with a completely empty invoice, like "New invoice" in the editor. Only the design (template, colours) carries over. */
export function startBlankInvoice(blank: InvoiceDraft) {
  const prev = readCurrent();
  writeCurrent({
    draft: { ...blank, templateId: prev?.draft?.templateId ?? null },
    invoiceId: null,
    layout: prev?.layout,
    designKey: prev?.designKey,
    classicLayout: prev?.classicLayout,
    localId: newLocalId(),
  });
}

/** If the renamed invoice is the one the editor would reopen, give its saved draft the new name too.
 *  Otherwise the editor's next autosave would put the old name back. */
export function renameOpenDraft(match: { localId?: string; serverId?: string | null }, name: string) {
  const cur = readCurrent();
  if (!cur) return;
  if ((match.localId && cur.localId === match.localId) || (match.serverId && cur.invoiceId === match.serverId)) writeCurrent({ ...cur, draft: { ...cur.draft, invoiceNumber: name } });
}

/** Renames an invoice kept in this browser (its invoice number, which is also the title printed on the invoice). */
export function renameLocalInvoice(localId: string, name: string) {
  const list = read();
  const i = list.findIndex((e) => e.localId === localId);
  if (i < 0) return;
  list[i] = { ...list[i], draft: { ...list[i].draft, invoiceNumber: name }, updatedAt: new Date().toISOString() };
  write(list);
  renameOpenDraft({ localId }, name);
}

/** After an invoice is deleted: if it is the one the editor would reopen, start a blank one instead.
 *  Otherwise the editor's next autosave would quietly bring the deleted invoice back. */
export function forgetOpenInvoice(match: { localId?: string; serverId?: string | null }, blank: InvoiceDraft) {
  const cur = readCurrent();
  if (!cur) return;
  if ((match.localId && cur.localId === match.localId) || (match.serverId && cur.invoiceId === match.serverId)) startBlankInvoice(blank);
}

/** A copy of a saved invoice, ready to edit: new number, today's dates, never paid for. */
export function duplicateLocalInvoice(entry: LocalInvoice, fresh: InvoiceDraft) {
  const copy: InvoiceDraft = { ...entry.draft, invoiceNumber: "", issueDate: fresh.issueDate, dueDate: fresh.dueDate };
  upsertLocalInvoice({ localId: newLocalId(), serverId: null, draft: copy, layout: entry.layout, locked: false });
}

// ---------------------------------------------------------------------------
// Moving a guest's invoices into their account when they sign in
// ---------------------------------------------------------------------------

let importing: Promise<number> | null = null;

/** Resolves once any move into the account has finished. The editor waits for this before it saves,
 *  so the invoice it has open isn't created twice. */
export function waitForLocalImport(): Promise<unknown> {
  return importing ?? Promise.resolve();
}

async function importAll(isPro: boolean): Promise<number> {
  let moved = 0;
  // Oldest first, so the account's invoice numbers and "newest first" order come out the way they were made.
  for (const entry of read().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    try {
      // An invoice that was also saved on the server (downloaded or paid for as a guest) is claimed by the account when
      // they sign in, together with its logo and payment. It only needs to stop being listed here, not be copied.
      let created: { id: string } | null = null;
      if (entry.serverId) {
        try {
          created = await api<{ id: string }>(`/api/v1/invoices/${entry.serverId}`);
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
        }
      }
      // Pro looks come from templates (the account's), so a guest's Classic look only travels with Free accounts.
      created ??= await api<{ id: string }>("/api/v1/invoices", { method: "POST", json: toApiPayload({ ...entry.draft, templateId: null }, isPro ? undefined : entry.layout) });
      moved++;
      removeLocalInvoice(entry.localId);
      // The editor may have this very invoice open: point it (and its saved copy) at the new one.
      const cur = readCurrent();
      if (cur && cur.localId === entry.localId) writeCurrent({ ...cur, invoiceId: created.id });
      window.dispatchEvent(new CustomEvent(INVOICE_IMPORTED_EVENT, { detail: { localId: entry.localId, id: created.id } }));
    } catch (err) {
      // Signed out again, rate limited or the server is down: keep what's left and try again next time.
      if (!(err instanceof ApiError) || err.status === 401 || err.status === 429 || err.status >= 500) break;
      // The server refused this one invoice: keep it here (never delete someone's work) and carry on with the rest.
    }
  }
  // Invoices the guest had already deleted stay in a recycle bin: now the account's. (One the server already has was claimed
  // together with the account, and was moved to its recycle bin when it was deleted here.)
  for (const entry of readTrash().sort((a, b) => a.deletedAt.localeCompare(b.deletedAt))) {
    try {
      if (!entry.serverId) {
        const created = await api<{ id: string }>("/api/v1/invoices", { method: "POST", json: toApiPayload({ ...entry.draft, templateId: null }, isPro ? undefined : entry.layout) });
        await api(`/api/v1/invoices/${created.id}`, { method: "DELETE" });
      }
      purgeLocalInvoice(entry.localId);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status === 401 || err.status === 429 || err.status >= 500) break;
    }
  }
  return moved;
}

/** Saves every invoice kept in this browser to the signed-in account, then forgets the local copies. Returns how many moved. */
export function importLocalInvoices(isPro: boolean): Promise<number> {
  if (importing) return importing;
  if (read().length === 0 && readTrash().length === 0) return Promise.resolve(0);
  importing = importAll(isPro).finally(() => {
    importing = null;
  });
  return importing;
}
