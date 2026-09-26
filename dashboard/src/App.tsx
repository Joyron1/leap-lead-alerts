import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { configError, supabase } from "./lib/supabase";
import { buildDaily, leadsCoverageFrom, normalizeLead, type Lead, type RawLead, type StatRow, type Withdrawal } from "./lib/data";
import { fetchLeads, fetchStats, fetchWithdrawals } from "./lib/api";
import { chime, notificationsSupported, subscribeLive, systemNotify, type LiveStatus } from "./lib/live";
import { fireMarks, money } from "./lib/format";
import { longDay, RANGES, relativeHe, resolveRange, todayPT, type RangeKey } from "./lib/time";
import { Login } from "./components/Login";
import { Toasts, type Toast } from "./components/Toasts";
import { Overview } from "./pages/Overview";
import { Sites } from "./pages/Sites";
import { Leads } from "./pages/Leads";
import { Cash } from "./pages/Cash";
import { Analytics } from "./pages/Analytics";

type Tab = "overview" | "analytics" | "sites" | "leads" | "cash";
export type Role = "admin" | "viewer";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "סקירה" },
  { key: "analytics", label: "ניתוח" },
  { key: "sites", label: "אתרים" },
  { key: "leads", label: "לידים" },
  { key: "cash", label: "קופה" },
];
const REFRESH_MS = 120_000;      // safety net under the realtime stream
const CATCH_UP_MS = 15 * 60e3;   // a poll that finds a lead finalized this recently still announces it
const TOAST_MS = 15_000;
const BASE_TITLE = "Snap Loans · דשבורד";

// Per-viewer conveniences only; storage can be unavailable (private mode), so never let it throw.
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const isFinal = (l: Lead) => l.status === "accepted" || l.status === "rejected";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [role, setRole] = useState<Role | null | undefined>(undefined);

  useEffect(() => {
    if (configError) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    // Keep this callback synchronous: awaiting other supabase calls inside it can deadlock the client.
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) { setRole(undefined); return; }
    let live = true;
    supabase.rpc("dashboard_role").then(({ data, error }) => {
      if (live) setRole(!error && (data === "admin" || data === "viewer") ? data : null);
    });
    return () => { live = false; };
  }, [userId]);

  if (configError) return <Screen title="הגדרה חסרה" body={configError} />;
  if (session === undefined) return <Screen title="טוען…" />;
  if (!session) return <Login />;
  if (role === undefined) return <Screen title="בודק הרשאה…" />;
  if (role === null) {
    return (
      <Screen title="אין הרשאה" body={`המשתמש ${session.user.email} מחובר, אבל לא ברשימת המורשים לדשבורד (או שהמייל עוד לא אומת).`}
        action={<button onClick={() => supabase.auth.signOut()}>יציאה</button>} />
    );
  }
  return <Dashboard email={session.user.email ?? ""} role={role} />;
}

function Dashboard({ email, role }: { email: string; role: Role }) {
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

  // ---------- live alerts ----------
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sound, setSound] = useState(() => store.get("sound") !== "off");
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : "denied"));
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const knownFinal = useRef<Set<string> | null>(null);   // null until the first load has seeded it
  const unseen = useRef(0);

  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // One announcement per lead, when Leap has decided it — the same rule as the Telegram alerts.
  const announce = useCallback((l: Lead, test = false) => {
    const accepted = l.status === "accepted";
    const title = accepted ? `✅ ליד חדש – ${money(l.payout)} ${fireMarks(l.payout)}`.trim() : "❌ ליד נדחה";
    const body = [l.site, l.state, l.loan && `סכום מבוקש ${l.loan}`].filter(Boolean).join(" · ") + (test ? " (בדיקה)" : "");
    const id = `${l.id}-${Date.now()}`;
    setToasts((t) => [{ id, title, body, tone: accepted ? "good" : "bad" } as Toast, ...t].slice(0, 5));
    setTimeout(() => dismiss(id), TOAST_MS);
    if (soundRef.current) chime(accepted);
    if (document.hidden) {
      systemNotify(title, body, l.id);
      unseen.current++;
      document.title = `(${unseen.current}) ${BASE_TITLE}`;
    }
  }, [dismiss]);

  useEffect(() => {
    const onVis = () => { if (!document.hidden) { unseen.current = 0; document.title = BASE_TITLE; } };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [l, s, w] = await Promise.all([fetchLeads(), fetchStats(), fetchWithdrawals()]);
      if (knownFinal.current === null) {
        knownFinal.current = new Set(l.filter(isFinal).map((x) => x.id));
      } else {
        // Catch up on anything the stream missed (e.g. laptop asleep), but never replay old leads.
        for (const x of l) {
          if (!isFinal(x) || knownFinal.current.has(x.id)) continue;
          knownFinal.current.add(x.id);
          if (Date.now() - x.ts < CATCH_UP_MS) announce(x);
        }
      }
      setLeads(l); setStats(s); setWithdrawals(w); setLoadedAt(Date.now()); setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [announce]);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [load]);

  const reloadWithdrawals = useCallback(async () => { setWithdrawals(await fetchWithdrawals()); }, []);

  const onLead = useCallback((raw: RawLead) => {
    if (!raw?.lead_id) return;
    const l = normalizeLead(raw);
    setLeads((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((x) => x.id === l.id);
      const next = i >= 0 ? prev.map((x) => (x.id === l.id ? l : x)) : [l, ...prev];
      return next.sort((a, b) => b.ts - a.ts);
    });
    const known = knownFinal.current;
    if (known && isFinal(l) && !known.has(l.id)) { known.add(l.id); announce(l); }
  }, [announce]);

  const loaded = leads !== null;
  useEffect(() => {
    if (!loaded) return;   // subscribe only once the baseline exists, so old rows never look "new"
    return subscribeLive({ onLead, onWithdrawals: () => { void reloadWithdrawals(); }, onStatus: setLive });
  }, [loaded, onLead, reloadWithdrawals]);

  useEffect(() => store.set("tab", tab), [tab]);
  useEffect(() => store.set("range", rangeKey), [rangeKey]);
  useEffect(() => store.set("sound", sound ? "on" : "off"), [sound]);

  const today = todayPT();
  const days = useMemo(() => (leads && stats ? buildDaily(stats, leads, today) : []), [leads, stats, today]);

  if (!leads || !stats || !withdrawals) {
    return error
      ? <Screen title="שגיאה בטעינת הנתונים" body={error} action={<button onClick={load}>נסה שוב</button>} />
      : <Screen title="טוען נתונים…" />;
  }

  const cover = leadsCoverageFrom(leads);
  const firstDay = days[0]?.day ?? today;
  const range = resolveRange(rangeKey, firstDay, today);
  const openSite = (host: string) => { setSite(host); setTab("leads"); };
  const askPermission = async () => { if (notificationsSupported()) setPerm(await Notification.requestPermission()); };
  const testAlert = () => announce({ ...leads[0], id: "test", status: "accepted", payout: 27.8, site: "jackson", state: "MS", loan: "$100–$500" }, true);

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
        <span className={`live live-${live}`} title={live === "live" ? "לידים חדשים מופיעים כאן מיד" : "הנתונים עדיין מתרעננים כל 2 דקות"}>
          <span aria-hidden>●</span> {live === "live" ? "חי" : live === "connecting" ? "מתחבר…" : "לא מחובר"}
        </span>
        {notificationsSupported() && perm !== "granted" && (
          <button className="small" onClick={askPermission} disabled={perm === "denied"}
            title={perm === "denied" ? "ההתראות חסומות בהגדרות הדפדפן לאתר הזה" : "התראה של המערכת גם כשהחלון ברקע"}>
            {perm === "denied" ? "🔕 התראות חסומות" : "🔔 הפעלת התראות"}
          </button>
        )}
        <button className="icon-btn" onClick={() => setSound((s) => !s)} title={sound ? "השתקת צליל" : "הפעלת צליל"} aria-pressed={sound}>{sound ? "🔊" : "🔇"}</button>
        <button className="link small" onClick={testAlert}>בדיקת התראה</button>
        <span className="muted small">{loading ? "מרענן…" : `עודכן ${relativeHe(loadedAt)}`}</span>
        <button className="icon-btn" onClick={load} disabled={loading} title="רענון">⟳</button>
        <span className="muted small email" dir="ltr">{email}{role === "viewer" ? " · צפייה" : ""}</span>
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
        {tab === "analytics" && <Analytics leads={leads} days={days} cover={cover} range={range} />}
        {tab === "sites" && <Sites leads={leads} cover={cover} range={range} today={today} onSite={openSite} />}
        {tab === "leads" && <Leads leads={leads} cover={cover} range={range} site={site} setSite={setSite} />}
        {tab === "cash" && <Cash days={days} withdrawals={withdrawals} onChanged={reloadWithdrawals} canEdit={role === "admin"} />}
      </main>

      <footer className="muted small">
        ימים לפי שעון Leap (קליפורניה), שעות בשעון ישראל. סיכומים יומיים מ-{longDay(firstDay)}, פירוט לכל ליד מ-{longDay(cover)}.
      </footer>

      <Toasts toasts={toasts} onDismiss={dismiss} />
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
