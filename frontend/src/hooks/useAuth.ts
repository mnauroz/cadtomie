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
  trialDaysLeft: number;
  login: (email: string, password: string) => Promise<string | null>;
  signup: (email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
}

const TRIAL_DAYS = 14;

function computeTrialStatus(user: User | null): { status: SubscriptionStatus; daysLeft: number } {
  if (!user) return { status: "none", daysLeft: 0 };
  const created = new Date(user.created_at);
  const now = new Date();
  const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
  const daysLeft = Math.max(0, Math.ceil(TRIAL_DAYS - diffDays));
  if (diffDays <= TRIAL_DAYS) return { status: "trialing", daysLeft };
  return { status: "canceled", daysLeft: 0 };
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscriptionStatus, setSubscriptionStatus] =
    useState<SubscriptionStatus>("loading");
  const [trialDaysLeft, setTrialDaysLeft] = useState(0);

  function applyUser(u: User | null) {
    setUser(u);
    const { status, daysLeft } = computeTrialStatus(u);
    setSubscriptionStatus(status);
    setTrialDaysLeft(daysLeft);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      applyUser(data.session?.user ?? null);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        applyUser(session?.user ?? null);
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
    applyUser(data.session?.user ?? null);
  }

  return { user, loading, subscriptionStatus, trialDaysLeft, login, signup, logout, refreshSubscription };
}
