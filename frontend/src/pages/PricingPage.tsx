import { useState } from "react";
import type { AuthState } from "../hooks/useAuth";
import { getAccessToken } from "../lib/supabase";

interface Props {
  auth: AuthState;
}

export default function PricingPage({ auth }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startTrial() {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Not authenticated");

      const res = await fetch(
        `${import.meta.env.VITE_API_BASE_URL ?? ""}/billing/create-checkout`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) throw new Error("Failed to create checkout session");
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
        <div style={styles.badge}>7-day free trial</div>
        <h1 style={styles.title}>CADtomie Pro</h1>
        <p style={styles.desc}>
          Full access to orthopedic deformity analysis — mechanical axis,
          osteotomy planning, DICOM export, and more.
        </p>
        <div style={styles.price}>
          <span style={styles.amount}>€29</span>
          <span style={styles.period}> / month</span>
        </div>
        <ul style={styles.features}>
          {[
            "Unlimited DICOM uploads",
            "HKA, mLDFA, mMPTA, JLCA measurements",
            "Osteotomy simulation & planning",
            "PDF / PNG export",
            "Multilingual (DE / EN / ES)",
          ].map((f) => (
            <li key={f} style={styles.feature}>
              <span style={styles.check}>✓</span> {f}
            </li>
          ))}
        </ul>
        {error && <p style={styles.error}>{error}</p>}
        <button style={styles.btn} onClick={startTrial} disabled={busy}>
          {busy ? "Redirecting…" : "Start free trial"}
        </button>
        <p style={styles.fine}>
          Card required. No charge for 7 days. Cancel anytime.
        </p>
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
    width: 420,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    alignItems: "center",
    textAlign: "center",
  },
  badge: {
    background: "#1f6feb22",
    color: "#58a6ff",
    border: "1px solid #1f6feb55",
    borderRadius: 20,
    padding: "4px 14px",
    fontSize: 12,
    fontWeight: 600,
  },
  title: { margin: 0, color: "#e6edf3", fontSize: 28, fontWeight: 700 },
  desc: { margin: 0, color: "#8b949e", fontSize: 14, lineHeight: 1.6 },
  price: { marginTop: 4 },
  amount: { color: "#e6edf3", fontSize: 40, fontWeight: 700 },
  period: { color: "#8b949e", fontSize: 18 },
  features: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    textAlign: "left",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: "100%",
  },
  feature: { color: "#c9d1d9", fontSize: 14, display: "flex", gap: 8 },
  check: { color: "#3fb950", fontWeight: 700 },
  btn: {
    width: "100%",
    background: "#1f6feb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "13px 0",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
  },
  fine: { color: "#8b949e", fontSize: 12, margin: 0 },
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
