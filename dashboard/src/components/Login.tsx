import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

const heError = (msg: string) =>
  /invalid login credentials/i.test(msg) ? "מייל או סיסמה שגויים."
  : /email not confirmed/i.test(msg) ? "המייל עוד לא אומת. לחץ על הקישור שנשלח אליך במייל ונסה שוב."
  : /already registered|already exists/i.test(msg) ? "המשתמש כבר קיים. עבור ל'כניסה'."
  : /password should be/i.test(msg) ? "הסיסמה קצרה מדי (לפחות 6 תווים)."
  : /rate limit/i.test(msg) ? "יותר מדי ניסיונות. חכה כמה דקות ונסה שוב."
  : msg;

export function Login() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setError(heError(error.message));
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (error) setError(heError(error.message));
        else if (!data.session) {
          setInfo("נשלח אליך מייל אימות. לחץ על הקישור שבו, ואז חזור לכאן והיכנס עם אותה סיסמה.");
          setMode("in");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card login" onSubmit={submit}>
        <h1>Snap Loans · דשבורד</h1>
        <p className="muted">{mode === "in" ? "כניסה למערכת" : "יצירת משתמש (פעם אחת)"}</p>
        <label>מייל<input type="email" dir="ltr" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>סיסמה<input type="password" dir="ltr" autoComplete={mode === "in" ? "current-password" : "new-password"} minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="alert alert-error" role="alert">⚠ {error}</div>}
        {info && <div className="alert alert-info" role="status">✉ {info}</div>}
        <button className="primary" disabled={busy}>{busy ? "רגע…" : mode === "in" ? "כניסה" : "יצירת משתמש"}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); }}>
          {mode === "in" ? "פעם ראשונה? יצירת משתמש" : "כבר יש לי משתמש"}
        </button>
      </form>
    </div>
  );
}
