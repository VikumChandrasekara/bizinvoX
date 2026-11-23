"use client";

import { Check, Loader2 } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { PasswordStrength } from "@/components/auth/password-strength";
import { LogoMark } from "@/components/brand/logo";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { closeDialog, openDialog, useDialogParam } from "@/lib/dialog-url";

export type AuthMode = "login" | "signup" | "forgot" | "reset";
type AuthUi = { open: (mode: Exclude<AuthMode, "reset">) => void; openReset: (token: string) => void };

const AuthUiContext = createContext<AuthUi>({ open: () => undefined, openReset: () => undefined });
export const useAuthUi = () => useContext(AuthUiContext);

/** Login, sign-up, forgot-password and reset-password, all as one dialog so the
 *  site stays a single page. Other components open it through `useAuthUi()`. */
export function AuthDialogProvider({ children }: { children: React.ReactNode }) {
  // The address bar decides which form is showing: ?dialog=login | signup | forgot.
  // Reset needs its one-time token, which is kept out of the URL once read.
  const param = useDialogParam();
  const [token, setToken] = useState("");
  const mode: AuthMode | null = token ? "reset" : param === "login" || param === "signup" || param === "forgot" ? param : null;
  const open = useCallback((m: Exclude<AuthMode, "reset">) => {
    setToken("");
    openDialog(m);
  }, []);
  const openReset = useCallback((t: string) => setToken(t), []);
  const close = useCallback(() => {
    setToken("");
    closeDialog();
  }, []);
  const switchMode = useCallback((m: AuthMode) => {
    setToken("");
    if (m !== "reset") openDialog(m, { replace: true });
  }, []);
  const value = useMemo(() => ({ open, openReset }), [open, openReset]);

  return (
    <AuthUiContext.Provider value={value}>
      {children}
      <Dialog open={mode !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-md">{mode && <AuthForm mode={mode} token={token} onMode={switchMode} onDone={close} />}</DialogContent>
      </Dialog>
    </AuthUiContext.Provider>
  );
}

const COPY: Record<AuthMode, { title: string; sub: string }> = {
  login: { title: "Welcome back", sub: "Log in to save invoices and manage your plan." },
  signup: { title: "Create your free account", sub: "Save invoices, reuse your details and upgrade any time." },
  forgot: { title: "Reset your password", sub: "Enter your email and we'll send you a reset link." },
  reset: { title: "Choose a new password", sub: "Use at least 10 characters." },
};

function AuthForm({ mode, token, onMode, onDone }: { mode: AuthMode; token: string; onMode: (m: AuthMode) => void; onDone: () => void }) {
  const { login, signup } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if ((mode === "signup" || mode === "reset") && password.length < 10) return setError("Password must be at least 10 characters.");
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
        toast("You're logged in.", "success");
        onDone();
      } else if (mode === "signup") {
        await signup(email, password);
        toast("Account created. Your draft is saved to it.", "success");
        onDone();
      } else if (mode === "forgot") {
        await api("/api/v1/auth/password-reset/request", { method: "POST", json: { email } });
        setSent(true);
      } else {
        await api("/api/v1/auth/password-reset/confirm", { method: "POST", json: { token, password } });
        toast("Password updated. Log in with your new password.", "success");
        setPassword("");
        onMode("login");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const copy = COPY[mode];
  return (
    <>
      <DialogHeader className="items-center text-center">
        <LogoMark className="size-11" />
        <DialogTitle className="mt-2 font-display text-xl">{copy.title}</DialogTitle>
        <DialogDescription>{copy.sub}</DialogDescription>
      </DialogHeader>

      {mode === "forgot" && sent ? (
        <p role="status" className="rounded-lg border bg-accent/60 px-4 py-3 text-sm">
          If an account exists for <strong>{email}</strong>, a reset link is on its way. It expires in 30 minutes.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {mode !== "reset" && (
            <div className="space-y-1.5">
              <Label htmlFor="auth-email">Email</Label>
              <Input id="auth-email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          )}
          {mode !== "forgot" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="auth-password">{mode === "reset" ? "New password" : "Password"}</Label>
                {mode === "login" && (
                  <button type="button" onClick={() => onMode("forgot")} className="text-xs text-muted-foreground hover:text-foreground">
                    Forgot password?
                  </button>
                )}
              </div>
              <Input
                id="auth-password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode !== "login" && <PasswordStrength password={password} />}
            </div>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={busy || (mode !== "reset" && !email) || (mode !== "forgot" && !password)}>
            {busy && <Loader2 className="animate-spin" />} {mode === "login" ? "Log in" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Update password"}
          </Button>
          {mode === "signup" && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {["The invoice you're building is saved to your account", "No credit card required"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check className="size-3.5 text-brand-accent" /> {t}
                </li>
              ))}
            </ul>
          )}
        </form>
      )}

      <p className="text-center text-sm text-muted-foreground">
        {mode === "login" ? (
          <>
            New here?{" "}
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => onMode("signup")}>
              Create a free account
            </button>
          </>
        ) : mode === "signup" ? (
          <>
            Already have an account?{" "}
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => onMode("login")}>
              Log in
            </button>
          </>
        ) : (
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => onMode("login")}>
            Back to log in
          </button>
        )}
      </p>
    </>
  );
}
