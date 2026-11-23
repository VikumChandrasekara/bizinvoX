"use client";

import { usePathname } from "next/navigation";

import { dialogHref, openDialog, type DialogName } from "@/lib/dialog-url";

/** A link to a popup. It has a real address (`/?dialog=templates`), so it works in a new tab,
 *  and on the page that owns the popup it opens in place without a reload. */
export function DialogLink({ name, onNavigate, children, ...rest }: { name: DialogName; onNavigate?: () => void } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const pathname = usePathname();
  return (
    <a
      {...rest}
      href={dialogHref(name)}
      onClick={(e) => {
        onNavigate?.();
        // Modified clicks (new tab/window) and other pages follow the real link.
        if (pathname !== "/" || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        openDialog(name);
      }}
    >
      {children}
    </a>
  );
}
