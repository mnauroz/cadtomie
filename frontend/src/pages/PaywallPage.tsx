import React from "react";
import type { AuthState } from "../hooks/useAuth";

interface Props {
  auth: AuthState;
}

export default function PaywallPage({ auth }: Props) {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.icon}>⏰</div>
        <h2 style={styles.title}>Your trial has ended</h2>
        <p style={styles.body}>
          Your 14-day free trial has expired. To continue using CADtomie,
          get in touch with us — we'll set up your subscription manually.
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
        <a href="mailto:cadtomie@gmail.com?subject=CADtomie%20Subscription" style={styles.btn}>
          Contact us to subscribe
        </a>
        <p style={styles.fine}>
          Reply to this email and we'll activate your account within 24 hours.
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
  icon: { fontSize: 40 },
  title: { margin: 0, color: "#e6edf3", fontSize: 22, fontWeight: 700 },
  body: { margin: 0, color: "#8b949e", fontSize: 14, lineHeight: 1.6 },
  price: { marginTop: 4 },
  amount: { color: "#e6edf3", fontSize: 36, fontWeight: 700 },
  period: { color: "#8b949e", fontSize: 16 },
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
    padding: "12px 0",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
    textDecoration: "none",
    display: "block",
    textAlign: "center",
  },
  fine: { color: "#8b949e", fontSize: 12, margin: 0 },
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
