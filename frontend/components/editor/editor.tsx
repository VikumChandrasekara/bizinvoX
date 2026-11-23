"use client";

import { AlertCircle, BookmarkPlus, CheckCircle2, Copy, Crown, Download, FilePlus2, LayoutTemplate, Loader2, Lock, Redo2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { InvoiceCanvas } from "@/components/editor/canvas";
import { Inspector } from "@/components/editor/inspector";
import { TemplatesDialog } from "@/components/editor/templates-dialog";
import { PaywallDialog, type Pricing } from "@/components/invoice/paywall-dialog";
import { InvoicePreviewDialog } from "@/components/invoice/invoice-preview-dialog";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiFetch, ApiError, errorMessage, toApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { BindCtx, Selection } from "@/lib/bindings";
import { designByKey, designForTemplateName, layoutsEqual, type DesignKey } from "@/lib/designs";
import { DEFAULT_LAYOUT, draftFromInvoice, emptyLine, emptyParty, formatMoney, newDraft, REMOVABLE_FIELDS, toApiPayload, totals, type Invoice, type InvoiceDraft, type Template, type TemplateContent, type TemplateLayout } from "@/lib/invoice";
import { closeDialog, openDialog, useDialogParam, type DialogName } from "@/lib/dialog-url";
import { findLocalIdByServerId, getLocalInvoice, hasContent, INVOICE_IMPORTED_EVENT, LOCAL_DRAFT_KEY as LOCAL_KEY, markLocalDownloaded, newLocalId, upsertLocalInvoice, waitForLocalImport } from "@/lib/local-invoices";
import { cn, filenameFromResponse, formatCents, saveBlob } from "@/lib/utils";
const invoiceLogoSrc = (id: string, version: string) => `/api/v1/invoices/${id}/logo?v=${encodeURIComponent(version)}`;
type SaveState = "idle" | "saving" | "saved" | "error";
type Logo = { src: string; /** Present until the file has been uploaded to a Pro template. */ file?: File };

const logoSrc = (t: Template) => `/api/v1/templates/${t.id}/logo?v=${encodeURIComponent(t.updatedAt)}`;

/** Only one editing panel is mounted at a time: the side panel on desktop, the bottom sheet below `lg`. */
function useIsDesktop() {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}

export function Editor() {
  const { user, isPro, loading } = useAuth();
  const toast = useToast();
  const isDesktop = useIsDesktop();

  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<InvoiceDraft>(newDraft);
  const [layout, setLayout] = useState<TemplateLayout>(DEFAULT_LAYOUT);
  const [designKey, setDesignKey] = useState<DesignKey>("classic");
  const [logo, setLogo] = useState<Logo | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Which account/plan the `templates` list was fetched for. */
  const [templatesKey, setTemplatesKey] = useState<string | null>(null);
  const templatesLoaded = templatesKey === `${user?.id ?? ""}:${isPro}`;
  const [busy, setBusy] = useState<null | "download" | "duplicate">(null);
  const [price, setPrice] = useState<Pricing | null>(null);
  /** The "start a new invoice?" confirmation is open. */
  const [confirmNew, setConfirmNew] = useState(false);
  /** A removal waiting for "are you sure?" (a field, a line item, the logo). */
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  /** A Pro-only action somebody on a free plan tried (e.g. "Removing fields"): shows the upgrade popup. */
  const [proPrompt, setProPrompt] = useState<string | null>(null);
  /** The "Save this template" name box (the save icon in the header) is open, with the name being typed. */
  const [saveName, setSaveName] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Every popup is addressed by ?dialog=<name>, so the address bar is the source of truth for what is open.
  const dialog = useDialogParam();
  const templatesOpen = dialog === "templates";
  const paywallOpen = ready && !loading && !isPro && dialog === "download";
  const setDialogOpen = (name: DialogName) => (open: boolean) => (open ? openDialog(name) : closeDialog());

  // Refs let the serialized queues read the latest values without re-creating callbacks.
  const draftRef = useRef(draft);
  const layoutRef = useRef(layout);
  const designKeyRef = useRef(designKey);
  const logoRef = useRef(logo);
  const templatesRef = useRef(templates);
  const isProRef = useRef(isPro);
  const userRef = useRef(user);
  draftRef.current = draft;
  layoutRef.current = layout;
  designKeyRef.current = designKey;
  logoRef.current = logo;
  templatesRef.current = templates;
  isProRef.current = isPro;
  userRef.current = user;

  const idRef = useRef<string | null>(null);
  /** Which entry of "My Invoices" in this browser (guests) the open invoice is. Set when the editor loads. */
  const localIdRef = useRef("");
  /** The user has started editing this invoice. Saving (to this browser or the account) begins with the first edit,
   *  so merely opening the editor or pressing "New invoice" never creates an empty entry. */
  const touchedRef = useRef(false);
  /** The invoice named in the address is still being fetched; the address must not be rewritten meanwhile. */
  const paramPending = useRef(false);
  /** The open invoice, when it is stored in a signed-in account (so it is never copied into the guest list). */
  const accountInvoiceRef = useRef<string | null>(null);
  const savedSnapshot = useRef("");
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const syncQueue = useRef<Promise<unknown>>(Promise.resolve());
  const dirtyDesign = useRef(false);
  const hydratedFor = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  /** Guest/Free: a logo lives on the invoice. This is the invoice id it was last uploaded to. */
  const logoOnServer = useRef<string | null>(null);
  /** Guest/Free: their own Classic customizations, kept while they preview a Pro template. */
  const classicBackup = useRef<TemplateLayout | null>(null);
  const lockedRef = useRef(false);
  lockedRef.current = locked;

  // Only Classic is usable without Pro. Other designs can be selected to look at, nothing more.
  // (Wait for the sign-in check so a Pro user's saved design isn't flashed as "preview only".)
  const previewOnly = !loading && !isPro && designKey !== "classic";
  const frozen = locked || previewOnly;

  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  // ---- undo / redo ---------------------------------------------------------
  // Every edit made on the invoice or in the editing panel is remembered, so it can be stepped back and forward.
  // Typing in quick succession counts as one step. Changing the template starts a fresh history, because
  // the old looks no longer apply to the new design.
  const past = useRef<{ draft: InvoiceDraft; layout: TemplateLayout }[]>([]);
  const future = useRef<{ draft: InvoiceDraft; layout: TemplateLayout }[]>([]);
  const lastRecorded = useRef(0);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const syncHistory = useCallback(() => setHistory({ undo: past.current.length > 0, redo: future.current.length > 0 }), []);
  const clearHistory = useCallback(() => {
    past.current = [];
    future.current = [];
    lastRecorded.current = 0;
    syncHistory();
  }, [syncHistory]);
  const recordHistory = useCallback(() => {
    const now = Date.now();
    const burst = now - lastRecorded.current < 700 && past.current.length > 0;
    lastRecorded.current = now;
    future.current = [];
    if (!burst) {
      past.current.push({ draft: draftRef.current, layout: layoutRef.current });
      if (past.current.length > 100) past.current.shift();
    }
    syncHistory();
  }, [syncHistory]);
  const stepHistory = useCallback(
    (dir: "undo" | "redo") => {
      if (frozenRef.current) return;
      const snap = (dir === "undo" ? past.current : future.current).pop();
      if (!snap) return;
      (dir === "undo" ? future.current : past.current).push({ draft: draftRef.current, layout: layoutRef.current });
      lastRecorded.current = 0;
      touchedRef.current = true;
      if (!layoutsEqual(snap.layout, layoutRef.current)) dirtyDesign.current = true;
      setDraft({ ...snap.draft, templateId: draftRef.current.templateId });
      setLayout(snap.layout);
      setSelection({ kind: "page" });
      syncHistory();
    },
    [syncHistory],
  );
  useEffect(() => clearHistory(), [designKey, draft.templateId, clearHistory]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const dir = k === "z" ? (e.shiftKey ? "redo" : "undo") : k === "y" && !e.shiftKey ? "redo" : null;
      if (!dir || document.querySelector('[role="dialog"]')) return;
      if (frozenRef.current || !(dir === "undo" ? past.current : future.current).length) return;
      e.preventDefault();
      stepHistory(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepHistory]);

  // Taking fields and columns off the invoice is Pro only. An invoice made before that rule (or after a Pro plan lapsed) gets them back.
  useEffect(() => {
    if (!ready || loading || isPro || designKey !== "classic") return;
    if (layout.hiddenFields.length === 0 && layout.showTaxColumn && layout.showDiscountColumn) return;
    setLayout({ ...layout, hiddenFields: [], showTaxColumn: true, showDiscountColumn: true });
  }, [ready, loading, isPro, designKey, layout]);

  // ---- edit helpers --------------------------------------------------------
  const patchDraft = useCallback((fn: (d: InvoiceDraft) => InvoiceDraft) => {
    if (frozen) return;
    if (fn(draftRef.current) === draftRef.current) return;
    recordHistory();
    touchedRef.current = true;
    setDraft(fn);
  }, [frozen, recordHistory]);
  const patchLayout = useCallback((fn: (l: TemplateLayout) => TemplateLayout) => {
    if (frozen) return;
    if (fn(layoutRef.current) === layoutRef.current) return;
    recordHistory();
    touchedRef.current = true;
    dirtyDesign.current = true;
    setLayout(fn);
  }, [frozen, recordHistory]);

  const applyInvoice = useCallback((inv: Invoice) => {
    const d = draftFromInvoice(inv);
    // A different invoice than the one open (a duplicate, or one opened from a link) is its own entry in My Invoices.
    if (idRef.current !== inv.id) {
      localIdRef.current = findLocalIdByServerId(inv.id) ?? newLocalId();
      clearHistory();
      // Another invoice is not the one a saved template was last updated from (same key as LINKED_KEY below).
      try {
        localStorage.removeItem("big:linked-template:v1");
      } catch {
        /* storage disabled */
      }
    }
    setDraft(d);
    setInvoiceId(inv.id);
    idRef.current = inv.id;
    touchedRef.current = true;
    if (userRef.current) accountInvoiceRef.current = inv.id;
    setLocked(inv.locked);
    savedSnapshot.current = JSON.stringify(toApiPayload(d));
    setSaveState("saved");
    if (!d.templateId) {
      // Classic: the customizations (and logo) live on the invoice itself.
      hydratedFor.current = null;
      setLayout(inv.layout ? { ...DEFAULT_LAYOUT, ...inv.layout } : DEFAULT_LAYOUT);
      setDesignKey("classic");
      classicBackup.current = null;
      if (inv.hasLogo) {
        setLogo({ src: invoiceLogoSrc(inv.id, inv.updatedAt) });
        logoOnServer.current = inv.id;
      } else {
        setLogo(null);
        logoOnServer.current = null;
      }
    } else {
      hydratedFor.current = null; // the hydration effect adopts the template's design
    }
  }, [clearHistory]);

  // The nav's (and footer's) "Templates" link is `#templates`: open the popup instead of scrolling.
  useEffect(() => {
    const check = () => {
      if (window.location.hash !== "#templates") return;
      // Older links used `#templates`; the popup's address is now ?dialog=templates.
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#create`);
      openDialog("templates", { replace: true });
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);

  // ---- initial load --------------------------------------------------------
  // The editor shows straight away from the draft saved in this browser. Nothing here waits for the
  // network or for the sign-in check: the server's copy of the invoice is merged in when it arrives.
  useEffect(() => {
    if (ready) return;
    const invoiceParam = new URLSearchParams(window.location.search).get("invoice");
    // `?invoice=<id>` is either a guest's invoice kept in this browser (opened from My Invoices) or one on the server.
    const local = invoiceParam ? getLocalInvoice(invoiceParam) : null;
    try {
      type Saved = { draft: InvoiceDraft; invoiceId: string | null; layout?: TemplateLayout; designKey?: DesignKey; classicLayout?: TemplateLayout | null; localId?: string };
      const raw = local ? null : localStorage.getItem(LOCAL_KEY);
      const saved: Saved | null = local ? { draft: local.draft, invoiceId: local.serverId, layout: local.layout, designKey: "classic", classicLayout: null, localId: local.localId } : raw ? (JSON.parse(raw) as Saved) : null;
      if (saved) {
        setDraft({ ...newDraft(), ...saved.draft });
        setInvoiceId(saved.invoiceId);
        idRef.current = saved.invoiceId;
        // A draft the user already worked on keeps saving; a blank one waits for the first edit.
        touchedRef.current = Boolean(saved.invoiceId) || hasContent({ ...newDraft(), ...saved.draft });
        localIdRef.current = saved.localId || newLocalId();
        if (saved.layout) setLayout({ ...DEFAULT_LAYOUT, ...saved.layout });
        if (saved.designKey) setDesignKey(saved.designKey);
        if (saved.classicLayout) classicBackup.current = { ...DEFAULT_LAYOUT, ...saved.classicLayout };
        // The server is the source of truth for a saved invoice's paid/locked state and its logo.
        if (saved.invoiceId && (!invoiceParam || local)) {
          api<Invoice>(`/api/v1/invoices/${saved.invoiceId}`)
            .then((inv) => {
              setLocked(inv.locked);
              if (inv.hasLogo && !logoRef.current) {
                setLogo({ src: invoiceLogoSrc(inv.id, inv.updatedAt) });
                logoOnServer.current = inv.id;
              }
            })
            .catch(() => undefined);
        }
      }
    } catch {
      /* ignore corrupt local drafts */
    }
    if (!localIdRef.current) localIdRef.current = newLocalId();
    setReady(true);
    // An invoice named in the address (a Stripe or email link) replaces the local draft once it loads.
    if (invoiceParam && !local) {
      paramPending.current = true;
      api<Invoice>(`/api/v1/invoices/${invoiceParam}`)
        .then(applyInvoice)
        .catch(() => toast("That invoice couldn't be found. It may have expired or belong to another account.", "error"))
        .finally(() => {
          paramPending.current = false;
        });
    }
  }, [ready, applyInvoice, toast]);

  useEffect(() => {
    if (loading) return;
    const key = `${user?.id ?? ""}:${isPro}`;
    api<Template[]>("/api/v1/templates")
      .then((t) => {
        setTemplates(t);
        setTemplatesKey(key);
      })
      .catch(() => setTemplates([]));
  }, [loading, user?.id, isPro]);

  // Re-read the invoice after a Stripe checkout completes (it becomes locked).
  useEffect(() => {
    const onReload = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) api<Invoice>(`/api/v1/invoices/${id}`).then(applyInvoice).catch(() => undefined);
    };
    window.addEventListener("big:reload-invoice", onReload);
    return () => window.removeEventListener("big:reload-invoice", onReload);
  }, [applyInvoice]);

  // Signing in moves a guest's invoices into the account. If that included the one open here, carry on with the account's copy
  // (otherwise the next autosave would create it a second time).
  useEffect(() => {
    const onImported = (e: Event) => {
      const { localId, id } = (e as CustomEvent<{ localId: string; id: string }>).detail ?? {};
      if (!id || localId !== localIdRef.current) return;
      idRef.current = id;
      accountInvoiceRef.current = id;
      setInvoiceId(id);
      // The account's copy has the same content, but force the next save to confirm that.
      savedSnapshot.current = "";
    };
    window.addEventListener(INVOICE_IMPORTED_EVENT, onImported);
    return () => window.removeEventListener(INVOICE_IMPORTED_EVENT, onImported);
  }, []);

  // Pro: adopt the design (layout + logo) of the template the invoice uses.
  useEffect(() => {
    if (!ready || !isPro) return;
    const id = draft.templateId;
    if (!id || hydratedFor.current === id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) {
      // A draft restored from this browser can point at another account's template. Drop it, keep the design.
      if (templatesLoaded) {
        dirtyDesign.current = true;
        draftRef.current = { ...draftRef.current, templateId: null };
        setDraft((x) => ({ ...x, templateId: null }));
      }
      return;
    }
    hydratedFor.current = id;
    dirtyDesign.current = false;
    setLayout(t.layout);
    setDesignKey(designForTemplateName(t.name));
    setLogo(t.hasLogo ? { src: logoSrc(t) } : null);
  }, [ready, isPro, draft.templateId, templates, templatesLoaded]);

  // ---- saving the invoice (serialized so autosave + manual saves never duplicate) ----
  /** What the server stores as this invoice's look (Guest/Free). While previewing a Pro template, keep their own Classic. */
  const serverLayout = useCallback((): TemplateLayout => (designKeyRef.current === "classic" ? layoutRef.current : classicBackup.current ?? DEFAULT_LAYOUT), []);
  const payloadFor = useCallback(
    (d: InvoiceDraft, invoiceNumber?: string) => toApiPayload({ ...d, templateId: isProRef.current ? d.templateId : null, invoiceNumber: invoiceNumber ?? d.invoiceNumber }, isProRef.current ? undefined : serverLayout()),
    [serverLayout],
  );

  // The open invoice survives a refresh. Guests also get it listed in "My Invoices", kept in this browser; signed-in users'
  // invoices are saved to their account instead (autosave below), so nothing is listed locally for them.
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({ draft, invoiceId, layout, designKey, classicLayout: classicBackup.current, localId: localIdRef.current }));
    } catch {
      /* storage full or disabled */
    }
    if (user && invoiceId) accountInvoiceRef.current = invoiceId;
    // `loading` matters: before the sign-in check finishes a signed-in user would look like a guest.
    // And an invoice that already lives in an account stays out of the guest list after logging out.
    if (!loading && !user && touchedRef.current && !(invoiceId && invoiceId === accountInvoiceRef.current)) {
      upsertLocalInvoice({ localId: localIdRef.current, serverId: invoiceId, draft, layout: serverLayout(), locked });
    }
  }, [ready, draft, invoiceId, layout, designKey, locked, loading, user, serverLayout]);

  // The address names the open invoice (?invoice=<id>), so a refresh or a copied link comes back to it. Signed-in users get the
  // invoice's id in their account; guests get its id in this browser's My Invoices. No invoice yet (or a blank new one): no parameter.
  useEffect(() => {
    if (!ready || loading || paramPending.current) return;
    const id = user ? invoiceId : touchedRef.current ? localIdRef.current : null;
    const url = new URL(window.location.href);
    if (url.searchParams.get("invoice") === id) return;
    if (id) url.searchParams.set("invoice", id);
    else url.searchParams.delete("invoice");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [ready, loading, user, invoiceId, draft]);

  const doSave = useCallback(async (): Promise<string> => {
    // A guest's invoices are being moved into the account they just signed in to: wait, so this one isn't created twice.
    await waitForLocalImport();
    const current = draftRef.current;
    // A paid (locked) invoice can't change, so there is nothing to save.
    if (idRef.current && lockedRef.current) return idRef.current;
    const payload = payloadFor(current);
    const snap = JSON.stringify(payload);
    if (idRef.current && snap === savedSnapshot.current) return idRef.current;
    setSaveState("saving");
    try {
      let inv: Invoice;
      if (idRef.current) {
        try {
          inv = await api<Invoice>(`/api/v1/invoices/${idRef.current}`, { method: "PUT", json: payload });
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
          inv = await api<Invoice>("/api/v1/invoices", { method: "POST", json: payload });
        }
      } else {
        inv = await api<Invoice>("/api/v1/invoices", { method: "POST", json: payload });
      }
      idRef.current = inv.id;
      if (userRef.current) accountInvoiceRef.current = inv.id;
      setInvoiceId(inv.id);
      setLocked(inv.locked);
      if (!current.invoiceNumber) setDraft((d) => (d.invoiceNumber ? d : { ...d, invoiceNumber: inv.invoiceNumber }));
      savedSnapshot.current = JSON.stringify(payloadFor(current, current.invoiceNumber || inv.invoiceNumber));
      setSaveState("saved");
      return inv.id;
    } catch (err) {
      setSaveState("error");
      throw err;
    }
  }, [payloadFor]);

  /** Guest/Free: put the logo on (or take it off) the saved invoice so the PDF can use it. */
  const syncLogo = useCallback(async (id: string) => {
    if (isProRef.current || lockedRef.current) return;
    const l = logoRef.current;
    if (l?.file && logoOnServer.current !== id) {
      const body = new FormData();
      body.append("file", l.file);
      const res = await apiFetch(`/api/v1/invoices/${id}/logo`, { method: "PUT", body });
      if (!res.ok) throw await toApiError(res);
      logoOnServer.current = id;
    } else if (!l && logoOnServer.current === id) {
      const res = await apiFetch(`/api/v1/invoices/${id}/logo`, { method: "DELETE" });
      if (!res.ok) throw await toApiError(res);
      logoOnServer.current = null;
    }
  }, []);

  const save = useCallback(() => {
    const next = saveQueue.current
      .then(doSave, doSave)
      .then(async (id) => {
        await syncLogo(id);
        return id;
      });
    saveQueue.current = next.catch(() => undefined);
    return next;
  }, [doSave, syncLogo]);

  // Signed-in users: autosave as a draft shortly after they stop typing (and when they restyle it).
  useEffect(() => {
    if (!ready || !user || locked || previewOnly) return;
    const t = setTimeout(() => {
      const d = draftRef.current;
      const logoPending = !isProRef.current && Boolean(logoRef.current?.file) && logoOnServer.current !== idRef.current;
      if (idRef.current && !logoPending && JSON.stringify(payloadFor(d)) === savedSnapshot.current) return;
      // Nothing is created until the first edit (no empty invoices); after that every change is saved.
      if (!touchedRef.current && !idRef.current) return;
      save().catch((err) => setError(errorMessage(err)));
    }, 400);
    return () => clearTimeout(t);
  }, [draft, layout, logo, ready, user, locked, previewOnly, isPro, save, payloadFor]);

  // ---- design: Pro designs live in the user's own templates ------------------
  const uploadLogoTo = useCallback(async (templateId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    const res = await apiFetch(`/api/v1/templates/${templateId}/logo`, { method: "PUT", body });
    if (!res.ok) throw await toApiError(res);
    const t = (await res.json()) as Template;
    setTemplates((prev) => prev.map((x) => (x.id === t.id ? t : x)));
    setLogo({ src: logoSrc(t) });
    if (layoutRef.current.logoPosition === "none") {
      dirtyDesign.current = true;
      setLayout((l) => ({ ...l, logoPosition: "right" }));
    }
  }, []);

  /** The user's own template for the current design, created on first use. */
  const ensureOwnTemplate = useCallback(async (): Promise<Template> => {
    const id = draftRef.current.templateId;
    // Saved templates ("My templates") are never edited through an invoice: they only supply a look when applied.
    const current = id ? templatesRef.current.find((t) => t.id === id && !t.isDefault && !t.saved) : undefined;
    if (current) return current;
    const key = designKeyRef.current;
    const name = key === "classic" ? "Classic (custom)" : designByKey(key).name;
    const found = templatesRef.current.find((t) => !t.isDefault && !t.saved && t.name === name);
    const t = found ?? (await api<Template>("/api/v1/templates", { method: "POST", json: { name, layout: layoutRef.current } }));
    if (!found) {
      templatesRef.current = [...templatesRef.current, t];
      setTemplates((prev) => [...prev, t]);
    }
    hydratedFor.current = t.id;
    draftRef.current = { ...draftRef.current, templateId: t.id };
    setDraft((d) => ({ ...d, templateId: t.id }));
    return t;
  }, []);

  const runSync = useCallback(async () => {
    if (!isProRef.current) return;
    const cur = layoutRef.current;
    const pendingLogo = logoRef.current?.file;
    const needs = dirtyDesign.current || (!draftRef.current.templateId && !layoutsEqual(cur, DEFAULT_LAYOUT)) || Boolean(pendingLogo);
    if (!needs) return;
    dirtyDesign.current = false;
    const t = await ensureOwnTemplate();
    if (!layoutsEqual(t.layout, cur)) {
      const updated = await api<Template>(`/api/v1/templates/${t.id}`, { method: "PUT", json: { name: t.name, layout: cur } });
      templatesRef.current = templatesRef.current.map((x) => (x.id === updated.id ? updated : x));
      setTemplates((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    }
    if (pendingLogo) await uploadLogoTo(t.id, pendingLogo);
  }, [ensureOwnTemplate, uploadLogoTo]);

  const syncDesign = useCallback(() => {
    const next = syncQueue.current.then(runSync, runSync);
    syncQueue.current = next.catch(() => undefined);
    return next;
  }, [runSync]);

  useEffect(() => {
    if (!ready || !isPro || locked) return;
    const needs = dirtyDesign.current || (!draft.templateId && !layoutsEqual(layout, DEFAULT_LAYOUT)) || Boolean(logo?.file);
    if (!needs) return;
    const t = setTimeout(() => void syncDesign().catch((err) => toast(errorMessage(err), "error")), 700);
    return () => clearTimeout(t);
  }, [ready, isPro, locked, layout, logo, draft.templateId, syncDesign, toast]);

  async function applyDesign(key: DesignKey) {
    if (locked) return;
    const d = designByKey(key);
    const prevKey = designKeyRef.current;
    const prevLogo = logoRef.current;
    const prevPos = layoutRef.current.logoPosition;
    // Keep the user's logo visible when they flip between looks.
    // Fields the user removed stay removed when they switch looks.
    const keepHidden = layoutRef.current.hiddenFields;
    const next: TemplateLayout = { ...d.layout, logoPosition: prevLogo && prevPos !== "none" ? prevPos : d.layout.logoPosition, hiddenFields: keepHidden };
    setDesignKey(key);
    designKeyRef.current = key;
    setSelection({ kind: "page" });

    if (!isPro) {
      // Guest/Free: only Classic is theirs to edit. Other designs are previews, so remember
      // their own Classic look and bring it back when they return.
      dirtyDesign.current = false;
      if (prevKey === "classic" && key !== "classic") classicBackup.current = layoutRef.current;
      if (key === "classic") {
        setLayout(classicBackup.current ?? DEFAULT_LAYOUT);
        classicBackup.current = null;
      } else {
        setLayout(next);
      }
      return;
    }
    const name = key === "classic" ? "Classic (custom)" : d.name;
    const existing = templatesRef.current.find((t) => !t.isDefault && !t.saved && t.name === name);
    if (existing) {
      hydratedFor.current = existing.id;
      const merged = keepHidden.length ? { ...existing.layout, hiddenFields: keepHidden } : existing.layout;
      dirtyDesign.current = !layoutsEqual(merged, existing.layout);
      setDraft((x) => ({ ...x, templateId: existing.id }));
      setLayout(merged);
      setLogo(existing.hasLogo ? { src: logoSrc(existing) } : null);
      return;
    }
    if (key === "classic") {
      hydratedFor.current = null;
      dirtyDesign.current = keepHidden.length > 0;
      setDraft((x) => ({ ...x, templateId: null }));
      setLayout(keepHidden.length ? { ...DEFAULT_LAYOUT, hiddenFields: keepHidden } : DEFAULT_LAYOUT);
      setLogo(null);
      return;
    }
    setLayout(next);
    dirtyDesign.current = false;
    try {
      const t = await api<Template>("/api/v1/templates", { method: "POST", json: { name, layout: next } });
      templatesRef.current = [...templatesRef.current, t];
      setTemplates((prev) => [...prev, t]);
      hydratedFor.current = t.id;
      setDraft((x) => ({ ...x, templateId: t.id }));
      if (prevLogo) {
        const blob = prevLogo.file ?? (await (await fetch(prevLogo.src)).blob());
        await uploadLogoTo(t.id, new File([blob], "logo", { type: blob.type }));
      }
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  function resetDesign() {
    if (locked) return;
    const d = designByKey(designKey);
    const keepPos = logo && layout.logoPosition !== "none" ? layout.logoPosition : d.layout.logoPosition;
    dirtyDesign.current = true;
    setLayout({ ...d.layout, logoPosition: keepPos });
  }

  // ---- My templates (Pro): named looks the user chose to keep ----------------------
  const savedTemplates = templates.filter((t) => t.saved);

  const logoFileFrom = async (src: string) => {
    const blob = await (await fetch(src)).blob();
    return new File([blob], "logo", { type: blob.type });
  };

  /** The saved template the open invoice belongs to (the one it was started from or last saved as). Saving again updates it
   *  instead of making another. Kept in this browser so it survives a refresh; it only counts while that template still exists. */
  const LINKED_KEY = "big:linked-template:v1";
  const linkedTemplate = (): Template | undefined => {
    try {
      const id = localStorage.getItem(LINKED_KEY);
      return id ? templatesRef.current.find((t) => t.id === id && t.saved) : undefined;
    } catch {
      return undefined;
    }
  };
  const linkTemplate = (id: string | null) => {
    try {
      if (id) localStorage.setItem(LINKED_KEY, id);
      else localStorage.removeItem(LINKED_KEY);
    } catch {
      /* storage disabled: saving simply asks for a name next time */
    }
  };

  /** Saves the look on screen (colors, fonts, layout, logo) into My templates. A template with the same name (or the one this
   *  invoice belongs to, when `target` is given) is updated in place; otherwise a new one is created. */
  async function saveAsTemplate(name: string, target?: Template) {
    if (!isPro) return;
    const existing = target ?? templatesRef.current.find((t) => t.saved && t.name.trim().toLowerCase() === name.trim().toLowerCase());
    try {
      // The template keeps the look (footer included) and the details that are the same on every invoice: the header's
      // business details, currency, payment terms and notes. Nothing that changes per invoice goes in (client, items,
      // number, dates, custom field values), and the invoice itself is not saved or changed.
      const cur = layoutRef.current;
      const look: TemplateLayout = { ...cur, customFields: cur.customFields.map((f) => ({ ...f, value: "" })) };
      const d = draftRef.current;
      const content: TemplateContent = { business: d.business, currency: d.currency, paymentTerms: d.paymentTerms, notes: d.notes };
      let t = existing
        ? await api<Template>(`/api/v1/templates/${existing.id}`, { method: "PUT", json: { name: existing.name, layout: look, content } })
        : await api<Template>("/api/v1/templates", { method: "POST", json: { name, layout: look, saved: true, content } });
      const current = logoRef.current;
      try {
        if (current) {
          const body = new FormData();
          body.append("file", current.file ?? (await logoFileFrom(current.src)));
          const res = await apiFetch(`/api/v1/templates/${t.id}/logo`, { method: "PUT", body });
          if (!res.ok) throw await toApiError(res);
          t = (await res.json()) as Template;
        } else if (t.hasLogo) {
          // The logo was taken off the invoice, so the template drops it too.
          t = await api<Template>(`/api/v1/templates/${t.id}/logo`, { method: "DELETE" });
        }
      } catch {
        toast("The template was saved, but its logo could not be updated. Upload the logo again to add it.", "error");
      }
      const saved = t;
      templatesRef.current = existing ? templatesRef.current.map((x) => (x.id === saved.id ? saved : x)) : [...templatesRef.current, saved];
      setTemplates((prev) => (existing ? prev.map((x) => (x.id === saved.id ? saved : x)) : [...prev, saved]));
      linkTemplate(saved.id);
      toast(existing ? `Updated “${saved.name}”.` : `Saved “${saved.name}” to My templates.`);
    } catch (err) {
      toast(errorMessage(err), "error");
      throw err;
    }
  }

  /** Saves into the template this invoice already belongs to, with no questions, and says whether it did. Without a remembered
   *  one, a saved template with the same look as the one on screen counts as it. A look that matches none is a new template:
   *  nothing is saved here (false) and the caller asks for a name. Used by the header's save icon and the Templates popup. */
  async function updateExistingTemplate(): Promise<boolean> {
    const cur = layoutRef.current;
    const linked =
      linkedTemplate() ??
      savedTemplates.find((t) => t.layout.font === cur.font && t.layout.primaryColor === cur.primaryColor && t.layout.accentColor === cur.accentColor && t.layout.headerStyle === cur.headerStyle);
    if (!linked) return false;
    if (savingTemplate) return true;
    setSavingTemplate(true);
    try {
      await saveAsTemplate(linked.name, linked);
    } catch {
      /* the reason is already shown */
    } finally {
      setSavingTemplate(false);
    }
    return true;
  }

  /** The save icon in the header. Pro: updates the template the invoice belongs to, or asks for a name for a new one.
   *  Everyone else sees what Pro adds. */
  async function openSaveTemplate() {
    if (previewOnly) return;
    if (!isPro) {
      setProPrompt("Saving templates");
      return;
    }
    if (await updateExistingTemplate()) return;
    setSaveName(`My template ${savedTemplates.length + 1}`);
  }

  async function submitSaveTemplate() {
    const name = (saveName ?? "").trim();
    if (!name || savingTemplate) return;
    setSavingTemplate(true);
    try {
      await saveAsTemplate(name);
      setSaveName(null);
    } catch {
      /* the reason is already shown; the name stays so they can try again */
    } finally {
      setSavingTemplate(false);
    }
  }

  /** Starts a new invoice from a saved template: its look, logo, header (business details) and footer, currency, payment
   *  terms and notes. The client, line items, invoice number and dates start empty. The invoice that was open is saved
   *  first and stays in My Invoices, untouched. The template itself is never changed by editing the invoice. */
  async function applySaved(t: Template) {
    if (!isPro) return;
    const leaving = idRef.current !== null || touchedRef.current;
    if (leaving && !lockedRef.current) {
      try {
        await save();
      } catch (err) {
        toast(errorMessage(err), "error");
        return;
      }
    }
    const prev = draftRef.current;
    const base = newDraft();
    const c = t.content;
    const d: InvoiceDraft = {
      ...base,
      templateId: prev.templateId,
      // Templates saved before details were kept: carry over the header of the invoice that was open.
      business: { ...emptyParty(), ...(c ? c.business : prev.business) },
      currency: (c ? c.currency : prev.currency) || base.currency,
      paymentTerms: c ? c.paymentTerms : prev.paymentTerms,
      notes: c ? c.notes : "",
    };
    draftRef.current = d;
    setDraft(d);
    idRef.current = null;
    localIdRef.current = newLocalId();
    // Saved once they change something, like any new invoice.
    touchedRef.current = false;
    setInvoiceId(null);
    setLocked(false);
    savedSnapshot.current = "";
    setSaveState("idle");
    setSelection({ kind: "page" });
    const next: TemplateLayout = { ...DEFAULT_LAYOUT, ...t.layout };
    layoutRef.current = next;
    dirtyDesign.current = true;
    setLayout(next);
    clearHistory();
    linkTemplate(t.id);
    toast(leaving ? `New invoice started from “${t.name}”. The invoice you were on is saved in My Invoices.` : `Started from “${t.name}”.`);
    if (!t.hasLogo) return;
    try {
      const own = await ensureOwnTemplate();
      await uploadLogoTo(own.id, await logoFileFrom(logoSrc(t)));
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  async function renameSaved(t: Template, name: string) {
    try {
      const updated = await api<Template>(`/api/v1/templates/${t.id}`, { method: "PUT", json: { name, layout: t.layout } });
      templatesRef.current = templatesRef.current.map((x) => (x.id === updated.id ? updated : x));
      setTemplates((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      toast(errorMessage(err), "error");
      throw err;
    }
  }

  async function deleteSaved(t: Template) {
    try {
      const res = await apiFetch(`/api/v1/templates/${t.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw await toApiError(res);
      templatesRef.current = templatesRef.current.filter((x) => x.id !== t.id);
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
      if (linkedTemplate()?.id === t.id) linkTemplate(null);
      toast(`Moved “${t.name}” to the Recycle bin. You can restore it for 30 days.`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  /** Not Pro: close the popup and scroll to the plans. */
  function seePro() {
    closeDialog();
    window.setTimeout(() => document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }), 250);
  }

  async function onUploadLogo(file: File) {
    if (locked) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 1024 * 1024) throw new Error("The logo must be a PNG, JPEG or WebP image under 1 MB.");
    if (!isPro) {
      // Guest/Free: the logo is stored on the invoice and uploaded with the next save.
      if (logo?.src.startsWith("blob:")) URL.revokeObjectURL(logo.src);
      logoOnServer.current = null;
      setLogo({ src: URL.createObjectURL(file), file });
      setLayout((l) => (l.logoPosition === "none" ? { ...l, logoPosition: "right" } : l));
      return;
    }
    const t = await ensureOwnTemplate();
    await uploadLogoTo(t.id, file);
  }

  async function onRemoveLogo() {
    if (locked) return;
    if (!isPro) {
      const id = idRef.current;
      if (logo?.src.startsWith("blob:")) URL.revokeObjectURL(logo.src);
      setLogo(null);
      if (id && logoOnServer.current === id) {
        logoOnServer.current = null;
        await apiFetch(`/api/v1/invoices/${id}/logo`, { method: "DELETE" }).catch(() => undefined);
      }
      return;
    }
    if (!draft.templateId || logo?.file) {
      if (logo?.src.startsWith("blob:")) URL.revokeObjectURL(logo.src);
      setLogo(null);
      return;
    }
    try {
      const t = await api<Template>(`/api/v1/templates/${draft.templateId}/logo`, { method: "DELETE" });
      setTemplates((prev) => prev.map((x) => (x.id === t.id ? t : x)));
      setLogo(null);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  // ---- actions -------------------------------------------------------------
  async function download() {
    setError(null);
    if (previewOnly) return;
    setBusy("download");
    const notice = toast("Downloading 📥", "loading");
    try {
      await syncDesign();
      const id = await save();
      // Everyone can download. Without Pro or a paid-off invoice the server adds a watermark.
      const res = await apiFetch(`/api/v1/invoices/${id}/download`, { method: "POST", json: {} });
      if (!res.ok) throw await toApiError(res);
      saveBlob(await res.blob(), filenameFromResponse(res, "invoice.pdf"));
      // Signed-in users' downloads are recorded by the server; a guest's invoice lives here, so note it here.
      if (!userRef.current) markLocalDownloaded(localIdRef.current);
      // Nothing else is announced: the same "Downloading" toast just stays up briefly, then fades.
      toast("Downloading 📥", "info", notice);
    } catch (err) {
      setError(errorMessage(err));
      toast(errorMessage(err), "error", notice);
    } finally {
      setBusy(null);
    }
  }

  // Download PDF: Guest/Free first see the preview and choose between paying to remove the watermark or
  // downloading free with it. Pro and paid-off invoices have no watermark, so they download straight away.
  function onDownloadClick() {
    if (previewOnly) return;
    if (!isPro && !locked) openDialog("preview");
    else void download();
  }

  /** Same checkout as the payment popup: save the invoice, then hand over to Stripe. */
  async function removeWatermarkAndPay() {
    setError(null);
    setBusy("download");
    try {
      await syncDesign();
      const id = await save();
      const { url } = await api<{ url: string }>(`/api/v1/invoices/${id}/checkout`, { method: "POST" });
      window.location.assign(url);
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(null);
    }
  }

  // The preview popup (?dialog=preview) renders the invoice from the editor's own state, so it opens instantly and
  // works without the server. It also reopens after a refresh or from a shared link.

  // Other designs are look-only for Guest/Free, so their popup link just closes.
  useEffect(() => {
    if (ready && previewOnly && dialog === "preview") closeDialog();
  }, [ready, previewOnly, dialog]);

  // Pro accounts never have a watermark to remove, so a stale link just closes that popup.
  useEffect(() => {
    if (ready && isPro && dialog === "download") closeDialog();
  }, [ready, isPro, dialog]);

  useEffect(() => {
    api<Pricing>("/api/v1/pricing").then(setPrice).catch(() => undefined);
  }, []);

  async function duplicate() {
    if (!idRef.current || previewOnly) return;
    setBusy("duplicate");
    try {
      applyInvoice(await api<Invoice>(`/api/v1/invoices/${idRef.current}/duplicate`, { method: "POST" }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  /** A fresh, completely empty sheet. The invoice being left is already saved (this browser's My Invoices, or the account),
   *  so nothing is lost. Only the design (template, colours, logo) carries over. */
  function startNew() {
    if (previewOnly) return;
    const d = newDraft();
    d.templateId = draft.templateId;
    setDraft(d);
    clearHistory();
    idRef.current = null;
    localIdRef.current = newLocalId();
    touchedRef.current = false;
    setInvoiceId(null);
    setLocked(false);
    savedSnapshot.current = "";
    setSaveState("idle");
    setSelection(null);
  }

  function addItem() {
    pendingFocus.current = `Item ${draft.lineItems.length + 1} · description`;
    patchDraft((d) => ({ ...d, lineItems: [...d.lineItems, emptyLine()] }));
  }
  function addCustomField() {
    patchLayout((l) => ({ ...l, customFields: [...l.customFields, { label: "Field", value: "" }] }));
  }
  /** The X on a field. Taking fields and columns off the invoice is a Pro feature. */
  function removeField(id: string) {
    if (frozen || !isPro) return;
    if (id === "column.tax") patchLayout((l) => ({ ...l, showTaxColumn: false }));
    else if (id === "column.discount") patchLayout((l) => ({ ...l, showDiscountColumn: false }));
    else patchLayout((l) => (l.hiddenFields.includes(id) ? l : { ...l, hiddenFields: [...l.hiddenFields, id] }));
    setSelection({ kind: "page" });
  }
  /** The × on the invoice itself. Removing is permanent, so it asks first. */
  function askRemoveField(id: string) {
    if (frozen) return;
    if (!isPro) {
      setProPrompt("Removing fields");
      return;
    }
    const label = REMOVABLE_FIELDS[id] ?? (id === "column.tax" ? "Tax column" : id === "column.discount" ? "Discount column" : "this field");
    setConfirmation({ title: `Remove "${label}"?`, description: "It will be taken off this invoice.", confirmLabel: "Remove", run: () => removeField(id) });
  }
  useEffect(() => {
    if (!pendingFocus.current) return;
    const el = document.querySelector<HTMLElement>(`[aria-label="${pendingFocus.current}"]`);
    pendingFocus.current = null;
    el?.focus();
  }, [draft.lineItems.length]);

  // ---- render --------------------------------------------------------------
  const ctx: BindCtx = { draft, layout, patchDraft, patchLayout };
  const t = totals(draft.lineItems);
  const priceLabel = price ? formatCents(price.downloadPriceCents, price.currency) : "$0.99";
  // Non-Pro invoices carry a watermark until the invoice is paid for (which also locks it).
  const showRemoveWatermark = !loading && !isPro && !locked && !previewOnly;
  const edited = !layoutsEqual(layout, designByKey(designKey).layout);
  const sheetOpen = !previewOnly && Boolean(selection && selection.kind !== "page");
  const inspectorProps = {
    selection,
    ctx,
    isPro,
    logoUrl: logo?.src ?? null,
    designName: designByKey(designKey).name,
    onUploadLogo,
    onRemoveLogo: () =>
      setConfirmation({ title: "Remove the logo?", description: "The logo will be taken off this invoice. You can upload it again any time.", confirmLabel: "Remove logo", run: () => void onRemoveLogo() }),
    onResetDesign: resetDesign,
    onAskRemove: setConfirmation,
    onProOnly: setProPrompt,
  };

  const historyButtons = (
    <>
      <Button variant="ghost" size="icon" aria-label="Undo" title="Undo (Ctrl+Z)" onClick={() => stepHistory("undo")} disabled={!history.undo || frozen}>
        <Undo2 />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Redo" title="Redo (Ctrl+Y)" onClick={() => stepHistory("redo")} disabled={!history.redo || frozen}>
        <Redo2 />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Save this template" title="Save this template" onClick={() => void openSaveTemplate()} disabled={previewOnly || savingTemplate}>
        <BookmarkPlus />
      </Button>
    </>
  );

  if (!ready) return <EditorSkeleton />;

  return (
    <section id="create" aria-labelledby="create-title" className="scroll-mt-24 px-3 pb-16 pt-24 sm:px-5 sm:pt-28">
      <div className="mx-auto max-w-[1680px]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="create-title" className="text-2xl font-bold sm:text-3xl">
              Create an invoice
            </h1>
            <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              {previewOnly ? "Preview only. Choose Classic to edit and download." : "Click anything on the invoice to edit it."} <SaveIndicator state={saveState} signedIn={Boolean(user)} />
            </p>
          </div>
          <div className="flex items-center gap-1 lg:hidden">{historyButtons}</div>
          <div className="hidden flex-wrap items-center gap-2 lg:flex">
            <div className="mr-1 flex items-center gap-1">{historyButtons}</div>
            <Button variant="outline" onClick={() => openDialog("templates")}>
              <LayoutTemplate /> Templates
            </Button>
            <Button variant="ghost" onClick={() => setConfirmNew(true)} disabled={previewOnly}>
              <FilePlus2 /> New invoice
            </Button>
            <Button variant="accent" onClick={onDownloadClick} disabled={busy !== null || previewOnly}>
              {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />} Download PDF
            </Button>
          </div>
        </div>

        {error && <Notice tone="error">{error}</Notice>}
        {locked && (
          <Notice tone="info">
            <span className="flex flex-wrap items-center gap-3">
              <Lock className="size-4" /> This invoice has been paid for and is locked, so the payment can&apos;t be reused for a different invoice.
              <Button size="sm" variant="outline" onClick={duplicate} disabled={busy !== null}>
                <Copy /> Duplicate to edit
              </Button>
            </span>
          </Notice>
        )}
        {previewOnly && !locked && (
          <Notice tone="info">
            <span className="flex flex-wrap items-center gap-3">
              <Crown className="size-4 text-amber-500" />
              <span>
                <strong>{designByKey(designKey).name}</strong> is a Pro template. You can look at it here, but editing, previewing and downloading need Pro.
              </span>
              <Button size="sm" variant="outline" onClick={() => void applyDesign("classic")}>
                Use Classic
              </Button>
              <a href="#pricing" className="font-medium text-primary underline-offset-4 hover:underline">
                See Pro
              </a>
            </span>
          </Notice>
        )}

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_344px]">
          <div className="min-w-0">
            <InvoiceCanvas ctx={ctx} logoUrl={logo?.src ?? null} branding={!isPro} selection={previewOnly ? null : selection} onSelect={previewOnly ? undefined : setSelection} actions={{ addItem, addCustomField }} onRemoveField={askRemoveField} readOnly={frozen} />
          </div>

          {isDesktop &&
            (previewOnly ? (
              <aside aria-label="Pro template" className="lg:sticky lg:top-24">
                <PreviewOnlyCard name={designByKey(designKey).name} onUseClassic={() => void applyDesign("classic")} />
              </aside>
            ) : (
              <aside aria-label="Editing panel" className="lg:sticky lg:top-24">
                <Inspector {...inspectorProps} className="max-h-[calc(100vh-7rem)]" />
              </aside>
            ))}
        </div>
      </div>

      {/* Mobile: the editing panel slides up as a sheet when something is selected */}
      {!isDesktop && sheetOpen && (
        <div className="fixed inset-x-2 bottom-2 z-40 lg:hidden">
          <Inspector {...inspectorProps} onClose={() => setSelection(null)} className="max-h-[48vh] shadow-2xl" />
        </div>
      )}

      {/* Mobile: sticky download bar */}
      {!isDesktop && !sheetOpen && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur">
          <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Total due</div>
              <div className="font-display text-lg font-bold tabular-nums">{formatMoney(t.total, draft.currency)}</div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" aria-label="Templates" onClick={() => openDialog("templates")}>
                <LayoutTemplate />
              </Button>
              <Button variant="outline" size="icon" aria-label="New invoice" onClick={() => setConfirmNew(true)} disabled={previewOnly}>
                <FilePlus2 />
              </Button>
              <Button variant="accent" size="lg" onClick={onDownloadClick} disabled={busy !== null || previewOnly}>
                {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />} Download
              </Button>
            </div>
          </div>
        </div>
      )}

      <PaywallDialog
        open={paywallOpen}
        onOpenChange={setDialogOpen("download")}
        ensureSaved={save}
        onDownloadFree={() => {
          closeDialog();
          void download();
        }}
      />
      <InvoicePreviewDialog
        open={ready && !previewOnly && dialog === "preview"}
        ctx={ctx}
        logoUrl={logo?.src ?? null}
        branding={!isPro}
        watermark={showRemoveWatermark}
        priceLabel={priceLabel}
        busy={busy !== null}
        onRemoveAndDownload={() => void removeWatermarkAndPay()}
        onDownload={() => {
          closeDialog();
          void download();
        }}
        onClose={closeDialog}
      />
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
      <Dialog open={proPrompt !== null} onOpenChange={(open) => !open && setProPrompt(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Crown className="size-5 text-amber-500" aria-hidden /> {proPrompt} is a Pro feature
            </DialogTitle>
            <DialogDescription>
              {proPrompt === "Saving templates"
                ? "Pro lets you save the look of an invoice, with your logo, business details and footer, as a template and start any new invoice from it."
                : "Pro lets you take any field or column off your invoice and its PDF, such as addresses, phone numbers, dates, notes or the tax and discount columns."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setProPrompt(null)}>
              Not now
            </Button>
            <Button
              variant="accent"
              autoFocus
              onClick={() => {
                setProPrompt(null);
                window.setTimeout(() => document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }), 250);
              }}
            >
              <Crown /> See Pro
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={saveName !== null} onOpenChange={(open) => !open && !savingTemplate && setSaveName(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save this template</DialogTitle>
            <DialogDescription>
              Keeps the look, logo, your business details, footer, payment terms and notes. The client, items, number and dates are not saved.
              {(saveName ?? "").trim() && savedTemplates.some((t) => t.name.trim().toLowerCase() === (saveName ?? "").trim().toLowerCase()) && (
                <strong className="mt-2 block font-medium text-foreground">A template with this name already exists. Saving updates it.</strong>
              )}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitSaveTemplate();
            }}
          >
            <input
              autoFocus
              value={saveName ?? ""}
              maxLength={40}
              disabled={savingTemplate}
              placeholder="Template name"
              aria-label="Template name"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setSaveName(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={savingTemplate} onClick={() => setSaveName(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" disabled={savingTemplate || !(saveName ?? "").trim()}>
                {savingTemplate ? <Loader2 className="animate-spin" /> : <BookmarkPlus />} Save template
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmNew} onOpenChange={setConfirmNew}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Start a new invoice?</DialogTitle>
            <DialogDescription>
              This clears every field and opens a blank invoice. The invoice you&apos;re on now stays saved in{" "}
              <Link href="/invoices" className="font-medium text-primary underline-offset-4 hover:underline">
                My Invoices
              </Link>
              {user ? ", in your account." : ", in this browser."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmNew(false)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              autoFocus
              onClick={() => {
                setConfirmNew(false);
                startNew();
              }}
            >
              <FilePlus2 /> Start new invoice
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <TemplatesDialog
        open={templatesOpen}
        onOpenChange={setDialogOpen("templates")}
        active={designKey}
        edited={edited}
        isPro={isPro}
        onPick={(k) => void applyDesign(k)}
        disabled={locked}
        saved={savedTemplates}
        logoSrc={logoSrc}
        onSave={saveAsTemplate}
        onQuickSave={updateExistingTemplate}
        onApplySaved={(t) => void applySaved(t)}
        onRename={renameSaved}
        onDelete={deleteSaved}
        onUpgrade={seePro}
      />
      {invoiceId && <span className="sr-only">Invoice id {invoiceId}</span>}
    </section>
  );
}

/** Stands in for the editing panel while a Pro template is shown to a Guest or Free user. */
function PreviewOnlyCard({ name, onUseClassic }: { name: string; onUseClassic: () => void }) {
  return (
    <div className="space-y-4 rounded-2xl border bg-card p-5 shadow-sm">
      <span className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
        <Crown className="size-5" />
      </span>
      <div>
        <h2 className="font-sans text-sm font-semibold">{name} is a Pro template</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Free accounts and guests can use the Classic template. You can preview the others, but they can&apos;t be edited, previewed or downloaded without Pro.</p>
      </div>
      <div className="grid gap-2">
        <Button onClick={onUseClassic}>Use Classic</Button>
        <Button asChild variant="outline">
          <a href="#pricing">See Pro plans</a>
        </Button>
      </div>
    </div>
  );
}

function SaveIndicator({ state, signedIn }: { state: SaveState; signedIn: boolean }) {
  if (!signedIn && state !== "saving")
    return (
      <span className="hidden sm:inline">
        · Saved in this browser.{" "}
        <Link href="/invoices" className="font-medium text-primary underline-offset-4 hover:underline">
          My Invoices
        </Link>
      </span>
    );
  switch (state) {
    case "saving":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin" /> Saving...
        </span>
      );
    case "saved":
      return (
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="size-3.5 text-brand-accent" /> Saved to your account
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5">
          <AlertCircle className="size-3.5 text-destructive" /> Not saved, check the highlighted fields
        </span>
      );
    default:
      return <span className="hidden sm:inline">· Changes save automatically.</span>;
  }
}

function Notice({ tone, children }: { tone: "info" | "error"; children: React.ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("mb-4 rounded-xl border px-4 py-3 text-sm", tone === "error" ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-accent/60")}>
      {children}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <section id="create" className="px-3 pb-16 pt-24 sm:px-5 sm:pt-28" aria-busy="true">
      <div className="mx-auto grid max-w-[1680px] gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Skeleton className="aspect-[794/1123] w-full" />
        <Skeleton className="hidden h-96 lg:block" />
      </div>
    </section>
  );
}
