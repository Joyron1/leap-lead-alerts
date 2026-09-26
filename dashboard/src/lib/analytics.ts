// Pure analytics over per-lead rows (no network) — covered by `npm run selftest`.
import type { Day, Lead } from "./data";
import { addDays } from "./time";

export type Metric = "earnings" | "leads" | "epl" | "accept";
export const METRICS: { key: Metric; label: string }[] = [
  { key: "earnings", label: "הכנסה" },
  { key: "leads", label: "לידים" },
  { key: "epl", label: "הכנסה לליד" },
  { key: "accept", label: "אחוז אישור" },
];

export type Agg = { key: string; leads: number; accepted: number; rejected: number; earnings: number; epl: number; accept: number };

function finish(a: Omit<Agg, "epl" | "accept">): Agg {
  const earnings = Math.round(a.earnings * 100) / 100;
  return { ...a, earnings, epl: a.leads ? earnings / a.leads : 0, accept: a.leads ? a.accepted / a.leads : 0 };
}

export function aggregate(leads: Lead[], pick: (l: Lead) => string): Agg[] {
  const m = new Map<string, Omit<Agg, "epl" | "accept">>();
  for (const l of leads) {
    const k = pick(l);
    const a = m.get(k) ?? { key: k, leads: 0, accepted: 0, rejected: 0, earnings: 0 };
    a.leads++;
    if (l.status === "accepted") a.accepted++;
    if (l.status === "rejected") a.rejected++;
    a.earnings += l.payout;
    m.set(k, a);
  }
  return [...m.values()].map(finish);
}

export const total = (leads: Lead[]): Agg => aggregate(leads, () => "all")[0] ?? finish({ key: "all", leads: 0, accepted: 0, rejected: 0, earnings: 0 });

export const metricValue = (a: Agg, m: Metric) => (m === "earnings" ? a.earnings : m === "leads" ? a.leads : m === "epl" ? a.epl : a.accept);

// ---------- when do leads arrive: weekday × hour ----------
export type Tz = "il" | "pt";
export const TZ_NAME: Record<Tz, string> = { il: "Asia/Jerusalem", pt: "America/Los_Angeles" };
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<Tz, Intl.DateTimeFormat>();

export function weekdayHour(ms: number, tz: Tz): [number, number] {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: TZ_NAME[tz], weekday: "short", hour: "2-digit", hour12: false }); fmtCache.set(tz, f); }
  const p = f.formatToParts(new Date(ms));
  return [WD[p.find((x) => x.type === "weekday")?.value ?? "Sun"] ?? 0, Number(p.find((x) => x.type === "hour")?.value) % 24];
}

export type Cell = { leads: number; accepted: number; earnings: number };
export function heatmap(leads: Lead[], tz: Tz): Cell[][] {
  const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ leads: 0, accepted: 0, earnings: 0 })));
  for (const l of leads) {
    const [d, h] = weekdayHour(l.ts, tz);
    const c = g[d][h];
    c.leads++; if (l.status === "accepted") c.accepted++; c.earnings += l.payout;
  }
  return g;
}

// ---------- weekly series per site ----------
export const weekStart = (day: string) => addDays(day, -new Date(day + "T12:00:00Z").getUTCDay()); // Sunday-based

export function weeks(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) out.push(w);
  return out;
}

export function weeklyBy(leads: Lead[], keys: string[], pick: (l: Lead) => string, weekList: string[], metric: Metric): number[][] {
  const idx = new Map(weekList.map((w, i) => [w, i]));
  const cells = keys.map(() => weekList.map(() => ({ key: "", leads: 0, accepted: 0, rejected: 0, earnings: 0 })));
  const kIdx = new Map(keys.map((k, i) => [k, i]));
  for (const l of leads) {
    const ki = kIdx.get(pick(l)), wi = idx.get(weekStart(l.day));
    if (ki === undefined || wi === undefined) continue;
    const c = cells[ki][wi];
    c.leads++; if (l.status === "accepted") c.accepted++; if (l.status === "rejected") c.rejected++; c.earnings += l.payout;
  }
  return cells.map((row) => row.map((c) => metricValue(finish(c), metric)));
}

// ---------- payout distribution & concentration ----------
export const PAYOUT_BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "$0", lo: 0, hi: 0.005 },
  { label: "עד $0.5", lo: 0.005, hi: 0.5 },
  { label: "$0.5–1", lo: 0.5, hi: 1 },
  { label: "$1–2", lo: 1, hi: 2 },
  { label: "$2–5", lo: 2, hi: 5 },
  { label: "$5–10", lo: 5, hi: 10 },
  { label: "$10–20", lo: 10, hi: 20 },
  { label: "$20+", lo: 20, hi: Infinity },
];

export function payoutHistogram(leads: Lead[]) {
  const out = PAYOUT_BUCKETS.map((b) => ({ ...b, leads: 0, earnings: 0 }));
  for (const l of leads) {
    const b = out.find((x) => l.payout >= x.lo && l.payout < x.hi) ?? out[out.length - 1];
    b.leads++; b.earnings += l.payout;
  }
  return out.map((b) => ({ ...b, earnings: Math.round(b.earnings * 100) / 100 }));
}

// Share of revenue brought by the top `share` of leads (by payout).
export function concentration(leads: Lead[], share: number) {
  const p = leads.map((l) => l.payout).sort((a, b) => b - a);
  const all = p.reduce((s, x) => s + x, 0);
  const n = Math.max(1, Math.round(p.length * share));
  return all > 0 ? p.slice(0, n).reduce((s, x) => s + x, 0) / all : 0;
}

// ---------- requested loan amount ----------
const loanLow = (label: string) => Number(label.replace(/[^0-9–-]/g, "").split(/[–-]/)[0]) || 0;
export function byLoan(leads: Lead[]): Agg[] {
  return aggregate(leads.filter((l) => l.loan), (l) => l.loan).sort((a, b) => loanLow(a.key) - loanLow(b.key));
}

// ---------- landing pages (the same page type across all city sites) ----------
export function normalizePage(page: string) {
  if (!page) return "";
  let p = page.split(/[?#]/)[0].toLowerCase();
  try { if (/^https?:\/\//.test(p)) p = new URL(p).pathname; } catch { /* keep as is */ }
  p = p.replace(/\/+$/, "");
  return p || "/";
}
export const byPage = (leads: Lead[]) => aggregate(leads.filter((l) => l.page), (l) => normalizePage(l.page));

// ---------- monthly, whole history (from the merged daily series) ----------
export function monthly(days: Day[]) {
  const m = new Map<string, { key: string; leads: number; earnings: number }>();
  for (const d of days) {
    const k = d.day.slice(0, 7);
    const x = m.get(k) ?? { key: k, leads: 0, earnings: 0 };
    x.leads += d.leads; x.earnings += d.earnings;
    m.set(k, x);
  }
  return [...m.values()].map((x) => ({ ...x, earnings: Math.round(x.earnings * 100) / 100, epl: x.leads ? x.earnings / x.leads : 0 }));
}
