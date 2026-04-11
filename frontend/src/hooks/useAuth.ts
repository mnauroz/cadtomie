import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "loading";

export interface AuthState {
  user: User | null;
  loading: boolean;
  subscriptionStatus: SubscriptionStatus;
  login: (email: string, password: string) => Promise<string | null>;
  signup: (email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus>("loading");

  async function fetchSubscription(accessToken: string) {
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? ""}/billing/status`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) {
        setSubscriptionStatus("none");
        return;
      }
      const json = await res.json();
      setSubscriptionStatus(json.status ?? "none");
    } catch {
      setSubscriptionStatus("none");
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const session = data.session;
      setUser(session?.user ?? null);
      if (session?.access_token) {
        fetchSubscription(session.access_token).finally(() =>
          setLoading(false)
        );
      } else {
        setSubscriptionStatus("none");
        setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        if (session?.access_token) {
          setSubscriptionStatus("loading");
          fetchSubscription(session.access_token);
        } else {
          setSubscriptionStatus("none");
        }
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  async function login(email: string, password: string): Promise<string | null> {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }

  async function signup(email: string, password: string): Promise<string | null> {
    const { error } = await supabase.auth.signUp({ email, password });
    return error?.message ?? null;
  }

  async function logout(): Promise<void> {
    await supabase.auth.signOut();
  }

  async function refreshSubscription(): Promise<void> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) await fetchSubscription(token);
  }

  return { user, loading, subscriptionStatus, login, signup, logout, refreshSubscription };
}
