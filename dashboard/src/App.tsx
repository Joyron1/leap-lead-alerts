import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { configError, supabase } from "./lib/supabase";
import { buildDaily, leadsCoverageFrom, type Lead, type StatRow, type Withdrawal } from "./lib/data";
import { fetchLeads, fetchStats, fetchWithdrawals } from "./lib/api";
import { longDay, RANGES, relativeHe, resolveRange, todayPT, type RangeKey } from "./lib/time";
import { Login } from "./components/Login";
import { Overview } from "./pages/Overview";
import { Sites } from "./pages/Sites";
import { Leads } from "./pages/Leads";
import { Cash } from "./pages/Cash";

type Tab = "overview" | "sites" | "leads" | "cash";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "סקירה" },
  { key: "sites", label: "אתרים" },
  { key: "leads", label: "לידים" },
  { key: "cash", label: "קופה" },
];
const REFRESH_MS = 120_000;

// Per-viewer conveniences only; storage can be unavailable (private mode), so never let it throw.
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (configError) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    // Keep this callback synchronous: awaiting other supabase calls inside it can deadlock the client.
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) { setAllowed(null); return; }
    let live = true;
    supabase.rpc("is_dashboard_user").then(({ data, error }) => { if (live) setAllowed(!error && data === true); });
    return () => { live = false; };
  }, [userId]);

  if (configError) return <Screen title="הגדרה חסרה" body={configError} />;
  if (session === undefined) return <Screen title="טוען…" />;
  if (!session) return <Login />;
  if (allowed === null) return <Screen title="בודק הרשאה…" />;
  if (!allowed) {
    return (
      <Screen title="אין הרשאה" body={`המשתמש ${session.user.email} מחובר, אבל לא ברשימת המורשים לדשבורד (או שהמייל עוד לא אומת).`}
        action={<button onClick={() => supabase.auth.signOut()}>יציאה</button>} />
    );
  }
  return <Dashboard email={session.user.email ?? ""} />;
}

function Dashboard({ email }: { email: string }) {
  const [tab, setTab] = useState<Tab>(() => (store.get("tab") as Tab) || "overview");
  const [rangeKey, setRangeKey] = useState<RangeKey>(() => (store.get("range") as RangeKey) || "30d");
  const [site, setSite] = useState("");
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [stats, setStats] = useState<StatRow[] | null>(null);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[] | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [l, s, w] = await Promise.all([fetchLeads(), fetchStats(), fetchWithdrawals()]);
      setLeads(l); setStats(s); setWithdrawals(w); setLoadedAt(Date.now()); setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [load]);

  useEffect(() => store.set("tab", tab), [tab]);
  useEffect(() => store.set("range", rangeKey), [rangeKey]);

  const today = todayPT();
  const days = useMemo(() => (leads && stats ? buildDaily(stats, leads, today) : []), [leads, stats, today]);

  const reloadWithdrawals = useCallback(async () => { setWithdrawals(await fetchWithdrawals()); }, []);

  if (!leads || !stats || !withdrawals) {
    return error
      ? <Screen title="שגיאה בטעינת הנתונים" body={error} action={<button onClick={load}>נסה שוב</button>} />
      : <Screen title="טוען נתונים…" />;
  }

  const cover = leadsCoverageFrom(leads);
  const firstDay = days[0]?.day ?? today;
  const range = resolveRange(rangeKey, firstDay, today);
  const openSite = (host: string) => { setSite(host); setTab("leads"); };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Snap Loans</div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "tab active" : "tab"} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="muted small">{loading ? "מרענן…" : `עודכן ${relativeHe(loadedAt)}`}</span>
        <button className="icon-btn" onClick={load} disabled={loading} title="רענון">⟳</button>
        <span className="muted small email" dir="ltr">{email}</span>
        <button className="link small" onClick={() => supabase.auth.signOut()}>יציאה</button>
      </header>

      <div className="rangebar" role="radiogroup" aria-label="טווח תאריכים" hidden={tab === "cash"}>
        {RANGES.map((r) => (
          <button key={r.key} role="radio" aria-checked={rangeKey === r.key} className={rangeKey === r.key ? "seg active" : "seg"} onClick={() => setRangeKey(r.key)}>{r.label}</button>
        ))}
        <span className="muted small range-dates">{longDay(range.from)}{range.from !== range.to ? ` – ${longDay(range.to)}` : ""}</span>
      </div>

      {error && <div className="alert alert-error">⚠ הרענון האחרון נכשל: {error}. מוצגים הנתונים מ{relativeHe(loadedAt)}.</div>}

      <main>
        {tab === "overview" && <Overview leads={leads} days={days} cover={cover} range={range} onSite={openSite} />}
        {tab === "sites" && <Sites leads={leads} cover={cover} range={range} today={today} onSite={openSite} />}
        {tab === "leads" && <Leads leads={leads} cover={cover} range={range} site={site} setSite={setSite} />}
        {tab === "cash" && <Cash days={days} withdrawals={withdrawals} onChanged={reloadWithdrawals} />}
      </main>

      <footer className="muted small">
        ימים לפי שעון Leap (קליפורניה), שעות בשעון ישראל. סיכומים יומיים מ-{longDay(firstDay)}, פירוט לכל ליד מ-{longDay(cover)}.
      </footer>
    </div>
  );
}

function Screen({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="center-screen">
      <div className="card">
        <h2>{title}</h2>
        {body && <p>{body}</p>}
        {action}
      </div>
    </div>
  );
}
