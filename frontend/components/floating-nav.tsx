"use client";

import { ChevronDown, Crown, LogOut, Mail, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAuthUi } from "@/components/auth/auth-dialog";
import { DialogLink } from "@/components/dialog-link";
import { useDialogParam } from "@/lib/dialog-url";
import { Logo } from "@/components/brand/logo";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const NAV = [
  { id: "create", label: "Create" },
  { id: "templates", label: "Templates" },
  { id: "invoices", label: "My Invoices" },
  { id: "pricing", label: "Pricing" },
  { id: "faq", label: "FAQ" },
] as const;

/** Which in-page section is currently under the nav. */
function useActiveSection() {
  const [active, setActive] = useState<string>("create");
  useEffect(() => {
    const ids = ["create", "pricing", "faq"];
    const onScroll = () => {
      const y = window.scrollY + 140;
      let current = "create";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.offsetTop <= y) current = id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return active;
}

export function FloatingNav() {
  const { user, isPro, loading, logout, refresh } = useAuth();
  const authUi = useAuthUi();
  const toast = useToast();
  const pathname = usePathname();
  const dialog = useDialogParam();
  const scrolled = useActiveSection();
  // The scrollspy only means something on the editor page; the legal pages have no sections.
  const active = pathname === "/" ? scrolled : "";
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  async function manageBilling() {
    try {
      const { url } = await api<{ url: string }>("/api/v1/billing/portal", { method: "POST" });
      window.location.assign(url);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  async function resendVerification() {
    try {
      await api("/api/v1/auth/verify-email/resend", { method: "POST" });
      toast("Verification email sent. Check your inbox.", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  async function signOut() {
    await logout();
    await refresh();
    toast("You've been logged out.", "info");
  }

  const link = (id: string, label: string, mobile = false) => {
    const className = cn(
      "rounded-full px-3.5 py-2 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground",
      mobile && "block rounded-xl py-3",
      (active === id || (id === "templates" && dialog === "templates") || (id === "invoices" && pathname === "/invoices")) && "bg-accent text-foreground",
    );
    // My Invoices is its own page (guests: this browser's invoices, signed-in users: their account's).
    if (id === "invoices") {
      return (
        <Link key={id} href="/invoices" onClick={() => setOpen(false)} aria-current={pathname === "/invoices" ? "page" : undefined} className={className}>
          {label}
        </Link>
      );
    }
    // Templates is a popup with its own address (?dialog=templates), not a section.
    if (id === "templates") {
      return (
        <DialogLink key={id} name="templates" onNavigate={() => setOpen(false)} className={className}>
          {label}
        </DialogLink>
      );
    }
    return (
      <a key={id} href={`/#${id}`} onClick={() => setOpen(false)} aria-current={active === id ? "location" : undefined} className={className}>
        {label}
      </a>
    );
  };

  return (
    <header className="pointer-events-none fixed inset-x-0 top-3 z-40 px-3 sm:top-4 sm:px-4">
      <div className="pointer-events-auto mx-auto max-w-5xl">
        <div className="flex items-center justify-between gap-2 rounded-full border border-border/70 bg-background/75 py-2 pl-4 pr-2 shadow-lg shadow-black/5 backdrop-blur-xl">
          <a href="/#create" aria-label="bizinvoX.com, back to the editor" className="shrink-0">
            <Logo compact />
          </a>

          <nav aria-label="Main" className="hidden items-center gap-0.5 md:flex">
            {NAV.map((n) => link(n.id, n.label))}
          </nav>

          <div className="flex items-center gap-1">
            {loading ? (
              <div className="h-9 w-28 animate-pulse rounded-full bg-muted" />
            ) : user ? (
              <div className="relative" ref={menuRef}>
                <Button variant="outline" size="sm" className="h-9 rounded-full pl-3" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                  {isPro && <Badge variant="pro">PRO</Badge>}
                  <span className="hidden max-w-[10rem] truncate sm:inline">{user.email}</span>
                  <span className="sm:hidden">Account</span>
                  <ChevronDown className="size-3.5" />
                </Button>
                {menu && (
                  <div role="menu" className="absolute right-0 mt-2 w-64 rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-xl">
                    <div className="px-3 py-2">
                      <p className="truncate text-sm font-medium">{user.email}</p>
                      <p className="text-xs text-muted-foreground">{isPro ? "Pro plan" : "Free plan"}</p>
                    </div>
                    <div className="my-1 h-px bg-border" />
                    {isPro ? (
                      <MenuItem onClick={() => { setMenu(false); void manageBilling(); }}>
                        <Crown className="size-4" /> Manage subscription
                      </MenuItem>
                    ) : (
                      <MenuItem
                        onClick={() => {
                          setMenu(false);
                          const el = document.getElementById("pricing");
                          if (el) el.scrollIntoView({ behavior: "smooth" });
                          else window.location.assign("/#pricing");
                        }}
                      >
                        <Crown className="size-4 text-amber-500" /> Upgrade to Pro
                      </MenuItem>
                    )}
                    {!user.emailVerified && (
                      <MenuItem onClick={() => { setMenu(false); void resendVerification(); }}>
                        <Mail className="size-4" /> Verify your email
                      </MenuItem>
                    )}
                    <MenuItem onClick={() => { setMenu(false); void signOut(); }}>
                      <LogOut className="size-4" /> Log out
                    </MenuItem>
                  </div>
                )}
              </div>
            ) : (
              <div className="hidden items-center gap-1 sm:flex">
                <Button variant="ghost" size="sm" className="h-9 rounded-full px-4" onClick={() => authUi.open("login")}>
                  Log in
                </Button>
                <Button size="sm" className="h-9 rounded-full px-4" onClick={() => authUi.open("signup")}>
                  Sign up
                </Button>
              </div>
            )}
            <Button variant="ghost" size="icon" className="rounded-full md:hidden" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? <X /> : <Menu />}
            </Button>
          </div>
        </div>

        {open && (
          <nav aria-label="Mobile" className="mt-2 rounded-3xl border bg-background/95 p-2 shadow-xl backdrop-blur-xl md:hidden">
            {NAV.map((n) => link(n.id, n.label, true))}
            {!user && !loading && (
              <div className="mt-1 grid grid-cols-2 gap-2 border-t p-2 pt-3 sm:hidden">
                <Button variant="outline" onClick={() => { setOpen(false); authUi.open("login"); }}>
                  Log in
                </Button>
                <Button onClick={() => { setOpen(false); authUi.open("signup"); }}>Sign up</Button>
              </div>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition hover:bg-accent">
      {children}
    </button>
  );
}
