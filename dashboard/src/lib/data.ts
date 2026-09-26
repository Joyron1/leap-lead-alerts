// Pure data logic: no network, so `npm run selftest` can exercise it. Fetching lives in api.ts.
import { addDays, eachDay, pacificDay, pacificMidnight, israelHour, type Range } from "./time";

// ---------- shapes ----------
export type RawLead = {
  lead_id: string; domain: string | null; page: string | null; state: string | null; status: string | null;
  payout: number | string | null; pay_model: string | null; source: string | null;
  client_ts: string | null; received_at: string; loan_range: string | null; loan_amount: number | string | null;
};
export type Lead = {
  id: string; host: string; site: string; page: string; state: string; status: string; payout: number;
  payModel: string; source: "browser" | "sync"; ts: number; day: string; loan: string;
};
export type StatRow = { day: string; leads: number; accepted: number; earnings: number };
export type Day = { day: string; leads: number; accepted: number; earnings: number };
export type Totals = { leads: number; accepted: number; earnings: number };

export const NETWORK = "snaploans.cash";
export const shortSite = (host: string) => (host === NETWORK ? "(ראשי)" : host.replace(`.${NETWORK}`, "")) || "?";

function loanLabel(range: string | null, amount: number | string | null) {
  const m = range?.match(/^(\d+(?:\.\d+)?);(\d+(?:\.\d+)?)$/);
  if (m) return `$${Number(m[1]).toLocaleString("en-US")}–$${Number(m[2]).toLocaleString("en-US")}`;
  const a = Number(amount);
  return a > 0 ? `$${a.toLocaleString("en-US")}` : "";
}

export function normalizeLead(r: RawLead): Lead {
  const ts = Date.parse(r.client_ts ?? r.received_at);
  const host = (r.domain ?? "").toLowerCase();
  return {
    id: r.lead_id, host, site: shortSite(host), page: r.page ?? "", state: (r.state ?? "").toUpperCase(),
    status: (r.status ?? "").toLowerCase(), payout: Number(r.payout) || 0, payModel: r.pay_model ?? "",
    source: r.source === "leap-sync" ? "sync" : "browser", ts, day: pacificDay(ts), loan: loanLabel(r.loan_range, r.loan_amount),
  };
}

// ---------- one daily series from two sources ----------
// Per-lead rows are live and exact but only exist from the backfill onward (Leap deletes per-lead
// rows after ~90 days). The daily Statistics mirror covers the whole account history but is refreshed
// once a day. So: statistics before the first complete per-lead day, per-lead rows from then on.
// The first per-lead day itself is skipped because it may be partial.
export function leadsCoverageFrom(leads: Lead[]) {
  if (!leads.length) return "9999-12-31";
  let min = leads[0].day;
  for (const l of leads) if (l.day < min) min = l.day;
  return addDays(min, 1);
}

export function buildDaily(stats: StatRow[], leads: Lead[], today: string): Day[] {
  const cover = leadsCoverageFrom(leads);
  const byDay = new Map<string, Day>();
  for (const s of stats) if (s.day < cover) byDay.set(s.day, { day: s.day, leads: s.leads, accepted: s.accepted, earnings: s.earnings });
  for (const l of leads) {
    if (l.day < cover) continue;
    const d = byDay.get(l.day) ?? { day: l.day, leads: 0, accepted: 0, earnings: 0 };
    d.leads++;
    if (l.status === "accepted") d.accepted++;
    d.earnings += l.payout;
    byDay.set(l.day, d);
  }
  const firstWithData = stats.find((s) => s.leads > 0)?.day ?? (leads.length ? cover : today);
  return eachDay(firstWithData, today).map((day) => {
    const d = byDay.get(day);
    return d ? { ...d, earnings: Math.round(d.earnings * 100) / 100 } : { day, leads: 0, accepted: 0, earnings: 0 };
  });
}

export function sumDays(days: Day[], from: string, to: string): Totals {
  const t = { leads: 0, accepted: 0, earnings: 0 };
  for (const d of days) if (d.day >= from && d.day <= to) { t.leads += d.leads; t.accepted += d.accepted; t.earnings += d.earnings; }
  t.earnings = Math.round(t.earnings * 100) / 100;
  return t;
}

function sumLeads(leads: Lead[], pred: (l: Lead) => boolean): Totals {
  const t = { leads: 0, accepted: 0, earnings: 0 };
  for (const l of leads) if (pred(l)) { t.leads++; if (l.status === "accepted") t.accepted++; t.earnings += l.payout; }
  t.earnings = Math.round(t.earnings * 100) / 100;
  return t;
}

// Current and comparison totals for a range. "Today" compares with yesterday up to the same moment,
// so a morning is never measured against a whole finished day.
export function periodTotals(range: Range, days: Day[], leads: Lead[], now = Date.now()): { cur: Totals; prev: Totals | null } {
  if (range.key === "today") {
    const cut = now - 864e5;
    return {
      cur: sumLeads(leads, (l) => l.day === range.from),
      prev: sumLeads(leads, (l) => l.day === range.prev!.from && l.ts <= cut),
    };
  }
  return { cur: sumDays(days, range.from, range.to), prev: range.prev ? sumDays(days, range.prev.from, range.prev.to) : null };
}

// ---------- chart series ----------
export type Point = { key: string; label: string; value: number; leads: number };

export function dailyPoints(days: Day[], from: string, to: string): Point[] {
  return days.filter((d) => d.day >= from && d.day <= to).map((d) => ({ key: d.day, label: d.day, value: d.earnings, leads: d.leads }));
}

export function monthlyPoints(days: Day[], from: string, to: string): Point[] {
  const m = new Map<string, Point>();
  for (const d of days) {
    if (d.day < from || d.day > to) continue;
    const k = d.day.slice(0, 7);
    const p = m.get(k) ?? { key: k, label: k, value: 0, leads: 0 };
    p.value += d.earnings; p.leads += d.leads;
    m.set(k, p);
  }
  return [...m.values()].map((p) => ({ ...p, value: Math.round(p.value * 100) / 100 }));
}

// 24 one-hour buckets across the Leap day, labelled in Israel time (10:00 … 09:00 next morning).
export function hourlyPoints(leads: Lead[], day: string): Point[] {
  const start = pacificMidnight(day);
  const pts: Point[] = Array.from({ length: 24 }, (_, h) => {
    const t = start + h * 3600e3;
    return { key: String(t), label: israelHour(t), value: 0, leads: 0 };
  });
  for (const l of leads) {
    if (l.day !== day) continue;
    const h = Math.min(23, Math.max(0, Math.floor((l.ts - start) / 3600e3)));
    pts[h].value += l.payout; pts[h].leads++;
  }
  return pts.map((p) => ({ ...p, value: Math.round(p.value * 100) / 100 }));
}

// ---------- breakdowns ----------
export type Bucket = { key: string; leads: number; accepted: number; earnings: number };

export function groupBy(leads: Lead[], from: string, to: string, pick: (l: Lead) => string): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const l of leads) {
    if (l.day < from || l.day > to) continue;
    const k = pick(l) || "?";
    const b = m.get(k) ?? { key: k, leads: 0, accepted: 0, earnings: 0 };
    b.leads++; if (l.status === "accepted") b.accepted++; b.earnings += l.payout;
    m.set(k, b);
  }
  return [...m.values()].map((b) => ({ ...b, earnings: Math.round(b.earnings * 100) / 100 }))
    .sort((a, b) => b.earnings - a.earnings || b.leads - a.leads);
}

export type SiteRow = Bucket & {
  host: string; lastTs: number; last7: number; prev7: number; epl: number; share: number;
};

// Per site for the range, plus range-independent health signals (last lead, last 7 vs previous 7 days).
export function siteRows(leads: Lead[], from: string, to: string, today: string): SiteRow[] {
  const inRange = groupBy(leads, from, to, (l) => l.host);
  const total = inRange.reduce((s, b) => s + b.earnings, 0) || 1;
  const last = new Map<string, number>(), w1 = new Map<string, number>(), w0 = new Map<string, number>();
  const d7 = addDays(today, -6), d14 = addDays(today, -13);
  for (const l of leads) {
    last.set(l.host, Math.max(last.get(l.host) ?? 0, l.ts));
    if (l.day >= d7) w1.set(l.host, (w1.get(l.host) ?? 0) + l.payout);
    else if (l.day >= d14) w0.set(l.host, (w0.get(l.host) ?? 0) + l.payout);
  }
  // Include every site ever seen, so a site that went silent still shows up (with zeros).
  const hosts = new Set([...inRange.map((b) => b.key), ...last.keys()]);
  const byHost = new Map(inRange.map((b) => [b.key, b]));
  return [...hosts].filter(Boolean).map((host) => {
    const b = byHost.get(host) ?? { key: host, leads: 0, accepted: 0, earnings: 0 };
    return {
      ...b, host, key: shortSite(host), lastTs: last.get(host) ?? 0,
      last7: Math.round((w1.get(host) ?? 0) * 100) / 100, prev7: Math.round((w0.get(host) ?? 0) * 100) / 100,
      epl: b.leads ? b.earnings / b.leads : 0, share: b.earnings / total,
    };
  });
}

// ---------- CSV ----------
export function leadsCsv(rows: Lead[]) {
  const head = ["lead_id", "israel_time", "leap_day", "site", "state", "status", "payout", "pay_model", "source", "page", "loan_requested"];
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const iso = (ms: number) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" });
  const lines = rows.map((l) => [l.id, iso(l.ts), l.day, l.host, l.state, l.status, l.payout.toFixed(2), l.payModel, l.source, l.page, l.loan].map(esc).join(","));
  return "﻿" + [head.join(","), ...lines].join("\n"); // BOM so Excel opens it as UTF-8
}
