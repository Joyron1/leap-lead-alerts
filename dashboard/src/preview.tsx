// Dev-only: renders the analysis and overview pages with SYNTHETIC leads, so layout and charts can be
// checked without signing in. Nothing here touches Supabase. Open /preview.html under `npm run dev`.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { buildDaily, normalizeLead, type Lead } from "./lib/data";
import { resolveRange, todayPT, addDays, RANGES, type RangeKey } from "./lib/time";
import { Analytics } from "./pages/Analytics";
import { Overview } from "./pages/Overview";

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T,>(xs: T[], w?: number[]) => {
  if (!w) return xs[Math.floor(rnd() * xs.length)];
  const s = w.reduce((a, b) => a + b, 0); let r = rnd() * s;
  for (let i = 0; i < xs.length; i++) { r -= w[i]; if (r <= 0) return xs[i]; }
  return xs[xs.length - 1];
};
const SITES = ["jackson", "el-paso", "spokane", "victorville", "anaheim", "alexandria", "denver", "miami", "tulsa", "reno"];
const STATES = ["TX", "CA", "MS", "FL", "WA", "VA", "OK", "NV", "CO", "AL", "GA", "OH"];
const PAGES = ["/", "/get-a-loan/", "/instant-cash-guide/", "/rates-fees/", "/blog/what-a-300-loan-costs/"];

function synth(): Lead[] {
  const today = todayPT();
  const out: Lead[] = [];
  for (let i = 0; i < 2200; i++) {
    const day = addDays(today, -Math.floor(rnd() * 95));
    const hourPt = pick([...Array(24).keys()], [2, 1, 1, 1, 1, 2, 4, 6, 7, 7, 6, 5, 5, 5, 6, 6, 7, 8, 9, 10, 9, 8, 6, 4]);
    const ts = Date.parse(`${day}T${String(hourPt).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}:00-07:00`);
    const rejected = rnd() < 0.03;
    const payout = rejected ? 0 : Math.round(Math.exp(Math.log(0.6) + 1.1 * (rnd() + rnd() + rnd() - 1.5)) * 20) / 20;
    out.push(normalizeLead({
      lead_id: String(1e9 + i), domain: `${pick(SITES, [9, 7, 6, 5, 4, 3, 3, 2, 2, 1])}.snaploans.cash`, page: rnd() < 0.7 ? pick(PAGES) : null,
      state: pick(STATES, [9, 8, 5, 5, 4, 3, 3, 2, 2, 2, 2, 1]), status: rejected ? "rejected" : "accepted", payout, pay_model: "",
      source: rnd() < 0.5 ? "leap-sync" : "xhr", client_ts: new Date(ts).toISOString(), received_at: new Date(ts).toISOString(),
      loan_range: rnd() < 0.6 ? pick(["100;500", "500;1000", "1000;2500", "2500;5000"]) : null, loan_amount: null,
    }));
  }
  return out.sort((a, b) => b.ts - a.ts);
}

const leads = synth();
function Preview() {
  const [key, setKey] = useState<RangeKey>("90d");
  const today = todayPT();
  const days = buildDaily([], leads, today);
  const range = resolveRange(key, days[0].day, today);
  return (
    <div className="app">
      <p className="alert alert-info" style={{ margin: "12px 0" }}>תצוגה מקדימה עם נתונים סינתטיים בלבד (פיתוח). אלה לא הנתונים האמיתיים.</p>
      <div className="rangebar">{RANGES.map((r) => <button key={r.key} className={key === r.key ? "seg active" : "seg"} onClick={() => setKey(r.key)}>{r.label}</button>)}</div>
      <Analytics leads={leads} days={days} cover={days[0].day} range={range} />
      <h2 style={{ marginTop: 32 }}>סקירה</h2>
      <Overview leads={leads} days={days} cover={days[0].day} range={range} onSite={() => {}} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
