import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/** Native select styled to match inputs: accessible and mobile-friendly by default. */
export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        className={cn(
          "h-10 w-full appearance-none rounded-lg border border-input bg-background pl-3 pr-9 text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20 disabled:opacity-60",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
