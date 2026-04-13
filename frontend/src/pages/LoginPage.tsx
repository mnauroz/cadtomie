import { useState } from "react";
import type { AuthState } from "../hooks/useAuth";
import { supabase } from "../lib/supabase";

interface Props {
  auth: AuthState;
  onSwitchToSignup: () => void;
}

export default function LoginPage({ auth, onSwitchToSignup }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetView, setResetView] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await auth.login(email, password);
    if (err) setError(err);
    setBusy(false);
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setResetBusy(true);
    setResetError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}`,
    });
    if (error) {
      setResetError(error.message);
    } else {
      setResetDone(true);
    }
    setResetBusy(false);
  }

  if (resetView) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>CADtomie</h1>
          {resetDone ? (
            <>
              <p style={styles.subtitle}>Check your email</p>
              <p style={{ color: "#8b949e", fontSize: 14, margin: 0 }}>
                We sent a password reset link to <strong style={{ color: "#e6edf3" }}>{email}</strong>.
              </p>
              <button style={styles.link} onClick={() => { setResetView(false); setResetDone(false); }}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <p style={styles.subtitle}>Reset your password</p>
              <form onSubmit={handleReset} style={styles.form}>
                <input
                  style={styles.input}
                  type="email"
                  placeholder="Your email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
                {resetError && <p style={styles.error}>{resetError}</p>}
                <button style={styles.btn} type="submit" disabled={resetBusy}>
                  {resetBusy ? "Sending…" : "Send reset link"}
                </button>
              </form>
              <p style={styles.switchText}>
                <button style={styles.link} onClick={() => setResetView(false)}>
                  Back to sign in
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>CADtomie</h1>
        <p style={styles.subtitle}>Sign in to your account</p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            style={styles.input}
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
          {error && <p style={styles.error}>{error}</p>}
          <button style={styles.btn} type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p style={styles.switchText}>
          <button style={styles.link} onClick={() => setResetView(true)}>
            Forgot password?
          </button>
        </p>
        <p style={styles.switchText}>
          No account?{" "}
          <button style={styles.link} onClick={onSwitchToSignup}>
            Create one — 14-day free trial
          </button>
        </p>
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
    gap: 12,
  },
  title: { margin: 0, color: "#e6edf3", fontSize: 24, fontWeight: 700 },
  subtitle: { margin: 0, color: "#8b949e", fontSize: 14 },
  form: { display: "flex", flexDirection: "column", gap: 10, marginTop: 8 },
  input: {
    background: "#0d1117",
    border: "1px solid #30363d",
    borderRadius: 6,
    color: "#e6edf3",
    padding: "10px 12px",
    fontSize: 14,
    outline: "none",
  },
  btn: {
    marginTop: 4,
    background: "#1f6feb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "11px 0",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  error: { color: "#f85149", fontSize: 13, margin: 0 },
  switchText: { color: "#8b949e", fontSize: 13, textAlign: "center", margin: 0 },
  link: {
    background: "none",
    border: "none",
    color: "#58a6ff",
    cursor: "pointer",
    fontSize: 13,
    padding: 0,
  },
};
