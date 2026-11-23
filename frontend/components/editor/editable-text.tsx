"use client";

import { useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";

export type EditableTextProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Accessible name, e.g. "Client name". */
  label: string;
  selected: boolean;
  onSelect: () => void;
  multiline?: boolean;
  align?: "left" | "right" | "center";
  maxLength?: number;
  numeric?: boolean;
  readOnly?: boolean;
  /** Changing this re-measures the height (e.g. when the font changes). */
  measure?: string;
  style?: React.CSSProperties;
  className?: string;
};

/** Text that is edited in place, directly on the invoice. It is a borderless,
 *  transparent textarea that inherits the surrounding typography, so it looks
 *  like printed text but behaves like a real editable field (caret, selection,
 *  IME, undo). The height follows the content. */
export function EditableText({ value, onChange, placeholder, label, selected, onSelect, multiline, align, maxLength, numeric, readOnly, measure, style, className }: EditableTextProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, placeholder, measure]);

  return (
    <textarea
      ref={ref}
      data-editable
      rows={1}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      readOnly={readOnly}
      maxLength={maxLength}
      inputMode={numeric ? "decimal" : undefined}
      autoComplete="off"
      onFocus={onSelect}
      onChange={(e) => onChange(multiline ? e.target.value : e.target.value.replace(/[\r\n]+/g, " "))}
      onKeyDown={(e) => {
        if (!multiline && e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className={cn(
        "ed-text m-0 block w-full resize-none overflow-hidden rounded-[2px] border-0 bg-transparent p-0 outline-none transition-shadow",
        !readOnly && "cursor-text hover:shadow-[0_0_0_1.5px_rgba(99,102,241,0.5)]",
        selected && "!shadow-[0_0_0_2px_#6366f1]",
        className,
      )}
      style={{ textAlign: align, font: "inherit", color: "inherit", letterSpacing: "inherit", lineHeight: "inherit", ...style }}
    />
  );
}
