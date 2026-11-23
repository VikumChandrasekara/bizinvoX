"use client";

import { useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** A titled block in the inspector. Styling is available to everyone, so there is no Pro marker. */
export function Group({ title, hint, children }: { title: string; /** @deprecated styling is no longer a Pro-only feature; kept so existing call sites compile. */ pro?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b px-4 py-4 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-sans text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      </div>
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; label: React.ReactNode; style?: React.CSSProperties }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-1 rounded-lg bg-muted p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          style={o.style}
          className={cn("rounded-md px-1 py-1.5 text-xs transition disabled:opacity-50", value === o.value ? "bg-background font-semibold shadow-sm" : "text-muted-foreground hover:text-foreground")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50", checked ? "bg-primary" : "bg-input")}
      >
        <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", checked ? "left-[22px]" : "left-0.5")} />
      </button>
    </div>
  );
}

export function ColorField({ label, value, onChange, swatches }: { label: string; value: string; onChange: (v: string) => void; swatches: string[] }) {
  const id = useId();
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  // Keep the hex box in step when the color changes elsewhere (swatch, template switch).
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} color picker`}
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="size-9 shrink-0 cursor-pointer rounded-lg border bg-transparent p-1"
        />
        <Input
          id={id}
          value={text}
          maxLength={7}
          className="h-9 w-24 px-2 font-mono text-xs uppercase"
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toUpperCase());
          }}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {swatches.map((s) => (
          <button
            key={s}
            type="button"
            aria-label={`Use ${s}`}
            onClick={() => onChange(s)}
            className={cn("size-6 rounded-full ring-offset-2 ring-offset-background transition hover:scale-110", value.toUpperCase() === s && "ring-2 ring-ring")}
            style={{ background: s }}
          />
        ))}
      </div>
    </div>
  );
}

export const PRIMARY_SWATCHES = ["#2E3A8C", "#0F766E", "#7C3AED", "#BE123C", "#B45309", "#111827", "#0369A1", "#15803D"];
export const ACCENT_SWATCHES = ["#10B981", "#F59E0B", "#06B6D4", "#EC4899", "#84CC16", "#6366F1"];
export const TEXT_SWATCHES = ["#111827", "#1F2937", "#374151", "#0F172A", "#3B0764"];
