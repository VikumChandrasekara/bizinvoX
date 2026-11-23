"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { api, ApiError } from "@/lib/api";

export type Plan = "free" | "pro";

export type User = {
  id: string;
  email: string;
  plan: Plan;
  planRenewsAt: string | null;
  emailVerified: boolean;
  hasBillingAccount: boolean;
  isAdmin: boolean;
  createdAt: string;
};

type AuthState = {
  user: User | null;
  loading: boolean;
  isPro: boolean;
  refresh: () => Promise<User | null>;
  login: (email: string, password: string) => Promise<User>;
  signup: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      // Short timeout: the page never waits on this, but the plan badge shouldn't hang either.
      const me = await api<User>("/api/v1/auth/me", { signal: AbortSignal.timeout(6_000) });
      setUser(me);
      return me;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) console.warn(err);
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const u = await api<User>("/api/v1/auth/login", { method: "POST", json: { email, password } });
    setUser(u);
    return u;
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const u = await api<User>("/api/v1/auth/signup", { method: "POST", json: { email, password } });
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    await api("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, isPro: user?.plan === "pro", refresh, login, signup, logout }),
    [user, loading, refresh, login, signup, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
