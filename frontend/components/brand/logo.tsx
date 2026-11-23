import { cn } from "@/lib/utils";

/** bizinvoX.com mark: an invoice sheet with a folded corner and an emerald
 *  "paid" checkmark. Text uses currentColor so it follows the surrounding text color. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("size-8", className)} aria-hidden="true">
      <path d="M14 4h26l14 14v38a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="#2E3A8C" />
      <path d="M40 4v10a4 4 0 0 0 4 4h10z" fill="#6E7BE0" />
      <rect x="18" y="22" width="18" height="3.5" rx="1.75" fill="#fff" opacity=".55" />
      <rect x="18" y="30" width="26" height="3.5" rx="1.75" fill="#fff" opacity=".35" />
      <path d="M20 44.5l6.5 6.5L42 35.5" fill="none" stroke="#10B981" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="flex flex-col leading-none">
        <span className="font-display text-lg font-bold tracking-tight">bizinvoX.com</span>
        {!compact && (
          <span className="hidden text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground sm:block">
            Online invoice generator
          </span>
        )}
      </span>
    </span>
  );
}
