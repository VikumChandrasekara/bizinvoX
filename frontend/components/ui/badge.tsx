import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        draft: "border-transparent bg-zinc-500/10 text-zinc-700",
        paid: "border-transparent bg-amber-500/15 text-amber-800",
        downloaded: "border-transparent bg-emerald-500/15 text-emerald-800",
        pro: "border-transparent bg-gradient-to-r from-indigo-600 to-emerald-500 text-white",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
