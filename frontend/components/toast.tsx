"use client";

import { AlertCircle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** "loading" shows a spinner and stays until it is replaced (pass its id as the third argument) or dismissed. */
type Tone = "success" | "error" | "info" | "loading";
type Item = { id: number; text: string; tone: Tone };
/** Returns the toast's id. Passing an existing id replaces that toast in place. */
type Toast = (text: string, tone?: Tone, replaceId?: number) => number;

const ToastContext = createContext<Toast>(() => 0);

/** Minimal, accessible toasts: one live region, auto-dismiss, dismissible. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((i) => i.id !== id)), []);
  const toast = useCallback<Toast>(
    (text, tone = "info", replaceId) => {
      const id = replaceId ?? next.current++;
      setItems((all) => (all.some((i) => i.id === id) ? all.map((i) => (i.id === id ? { id, text, tone } : i)) : [...all.slice(-2), { id, text, tone }]));
      if (tone !== "loading") setTimeout(() => dismiss(id), tone === "error" ? 8000 : 5000);
      return id;
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {items.map((i) => {
          const Icon = i.tone === "success" ? CheckCircle2 : i.tone === "error" ? AlertCircle : i.tone === "loading" ? Loader2 : Info;
          return (
            <div
              key={i.id}
              role={i.tone === "error" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-xl",
                i.tone === "error" && "border-destructive/40",
              )}
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", i.tone === "success" && "text-brand-accent", i.tone === "error" && "text-destructive", (i.tone === "info" || i.tone === "loading") && "text-primary", i.tone === "loading" && "animate-spin")} />
              <p className="flex-1">{i.text}</p>
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(i.id)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
