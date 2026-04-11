import { useState } from "react";
import type { AuthState } from "../hooks/useAuth";
import { getAccessToken } from "../lib/supabase";

interface Props {
  auth: AuthState;
}

const STATUS_COPY: Record<string, { title: string; body: string }> = {
  past_due: {
    title: "Payment failed",
    body: "We couldn't charge your card. Update your payment method to continue.",
  },
  canceled: {
    title: "Subscription canceled",
    body: "Your subscription has ended. Resubscribe to regain access.",
  },
  default: {
    title: "Subscription required",
    body: "Your trial has ended. Subscribe to continue using CADtomie.",
  },
};

export default function PaywallPage({ auth }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy =
    STATUS_COPY[auth.subscriptionStatus] ?? STATUS_COPY.default;

  async function openPortalOrCheckout() {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Not authenticated");

      const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

      // past_due → Customer Portal to update payment method
      // else → new Checkout session
      const endpoint =
        auth.subscriptionStatus === "past_due"
          ? `${apiBase}/billing/portal`
          : `${apiBase}/billing/create-checkout`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Request failed");
      const json = await res.json();
      window.location.href = json.url;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.icon}>🔒</div>
        <h2 style={styles.title}>{copy.title}</h2>
        <p style={styles.body}>{copy.body}</p>
        {error && <p style={styles.error}>{error}</p>}
        <button style={styles.btn} onClick={openPortalOrCheckout} disabled={busy}>
          {busy
            ? "Redirecting…"
            : auth.subscriptionStatus === "past_due"
            ? "Update payment method"
            : "Subscribe now"}
        </button>
        <button style={styles.logoutLink} onClick={auth.logout}>
          Sign out
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0d1117",
  },
  card: {
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 12,
    padding: "40px 48px",
    width: 380,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    alignItems: "center",
    textAlign: "center",
  },
  icon: { fontSize: 40 },
  title: { margin: 0, color: "#e6edf3", fontSize: 22, fontWeight: 700 },
  body: { margin: 0, color: "#8b949e", fontSize: 14, lineHeight: 1.6 },
  btn: {
    width: "100%",
    background: "#1f6feb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "12px 0",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
  },
  error: { color: "#f85149", fontSize: 13, margin: 0 },
  logoutLink: {
    background: "none",
    border: "none",
    color: "#8b949e",
    cursor: "pointer",
    fontSize: 12,
    padding: 0,
    textDecoration: "underline",
  },
};
