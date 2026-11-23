"use client";

import { useSyncExternalStore } from "react";

/** Every popup has its own address: `?dialog=<name>`. The URL is the source of
 *  truth, so a popup survives a refresh, can be linked to, and the browser's
 *  Back button closes it. */
export const DIALOGS = ["templates", "login", "signup", "forgot", "preview", "download"] as const;
export type DialogName = (typeof DIALOGS)[number];

const PARAM = "dialog";
const EVENT = "big:url";

function isDialog(v: string | null): v is DialogName {
  return v !== null && (DIALOGS as readonly string[]).includes(v);
}

function read(): DialogName | null {
  const v = new URLSearchParams(window.location.search).get(PARAM);
  return isDialog(v) ? v : null;
}

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(EVENT, cb);
  };
}

/** The popup named in the address bar, or null. Always null during server render. */
export function useDialogParam(): DialogName | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

function hrefWith(name: DialogName | null) {
  const q = new URLSearchParams(window.location.search);
  if (name) q.set(PARAM, name);
  else q.delete(PARAM);
  const qs = q.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
}

/** Address of a popup on a given page, for links that should work in a new tab. */
export const dialogHref = (name: DialogName, path = "/") => `${path}?${PARAM}=${name}`;

/** Open a popup. Opening adds a history entry so Back closes it; switching from
 *  one popup to another (or `replace`) rewrites the current entry instead. */
export function openDialog(name: DialogName, opts: { replace?: boolean } = {}) {
  if (read() === name) return;
  if (opts.replace || read() !== null) window.history.replaceState(window.history.state, "", hrefWith(name));
  else window.history.pushState({ bigDialog: true }, "", hrefWith(name));
  window.dispatchEvent(new Event(EVENT));
}

/** Close whatever popup is open. If we added its history entry, go back over it so
 *  the history stays clean; if it was opened by a direct link, just drop the param. */
export function closeDialog() {
  if (read() === null) return;
  if (window.history.state?.bigDialog) {
    window.history.back();
  } else {
    window.history.replaceState(window.history.state, "", hrefWith(null));
    window.dispatchEvent(new Event(EVENT));
  }
}
