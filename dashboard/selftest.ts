// `npm run selftest` — checks the pure data logic (no network, no credentials).
import { buildDaily, groupBy, hourlyPoints, leadsCoverageFrom, normalizeLead, periodTotals, siteRows, type Lead, type StatRow } from "./src/lib/data";
import { niceTicks } from "./src/lib/format";
import { addDays, pacificDay, pacificMidnight, resolveRange } from "./src/lib/time";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};

// --- time ---
eq("pacificDay: 06:59 UTC is still the previous Leap day (PDT)", pacificDay(Date.parse("2026-09-26T06:59:00Z")), "2026-09-25");
eq("pacificDay: 07:00 UTC is the new Leap day (PDT)", pacificDay(Date.parse("2026-09-26T07:00:00Z")), "2026-09-26");
eq("pacificMidnight in PDT = 07:00Z", new Date(pacificMidnight("2026-09-26")).toISOString(), "2026-09-26T07:00:00.000Z");
eq("pacificMidnight in PST = 08:00Z", new Date(pacificMidnight("2026-01-15")).toISOString(), "2026-01-15T08:00:00.000Z");
eq("addDays across month", addDays("2026-02-28", 1), "2026-03-01");
const r7 = resolveRange("7d", "2025-08-13", "2026-09-26");
eq("7d range", [r7.from, r7.to, r7.prev], ["2026-09-20", "2026-09-26", { from: "2026-09-13", to: "2026-09-19" }]);
const mtd = resolveRange("mtd", "2025-08-13", "2026-03-31");
eq("mtd on Mar 31 compares with all of Feb (clamped)", mtd.prev, { from: "2026-02-01", to: "2026-02-28" });
eq("all range starts at first day, no comparison", [resolveRange("all", "2025-08-13", "2026-09-26").from, resolveRange("all", "2025-08-13", "2026-09-26").prev], ["2025-08-13", null]);
eq("niceTicks(63.2)", niceTicks(63.2), [0, 20, 40, 60, 80]);
eq("niceTicks(0)", niceTicks(0), [0, 1]);

// --- data ---
const L = (id: string, iso: string, domain: string, payout: number, status = "accepted", state = "TX"): Lead =>
  normalizeLead({ lead_id: id, domain, page: "/", state, status, payout, pay_model: "", source: "leap-sync",
    client_ts: iso, received_at: iso, loan_range: "100;500", loan_amount: null });
const leads = [
  L("1", "2026-09-20T15:00:00Z", "el-paso.snaploans.cash", 0.6),          // first per-lead day: partial -> ignored by the series
  L("2", "2026-09-21T15:00:00Z", "el-paso.snaploans.cash", 1.8),
  L("3", "2026-09-21T16:00:00Z", "jackson.snaploans.cash", 27.8),
  L("4", "2026-09-22T15:00:00Z", "jackson.snaploans.cash", 0, "rejected", "MS"),
];
const stats: StatRow[] = [
  { day: "2026-09-19", leads: 5, accepted: 5, earnings: 3 },
  { day: "2026-09-20", leads: 9, accepted: 9, earnings: 9.9 },   // stats wins for the partial first day
  { day: "2026-09-21", leads: 99, accepted: 99, earnings: 999 }, // per-lead rows win from here on
];
eq("coverage starts the day after the first per-lead day", leadsCoverageFrom(leads), "2026-09-21");
const days = buildDaily(stats, leads, "2026-09-23");
eq("daily series merges stats (before) and leads (from coverage)", days.map((d) => [d.day, d.leads, d.earnings]),
  [["2026-09-19", 5, 3], ["2026-09-20", 9, 9.9], ["2026-09-21", 2, 29.6], ["2026-09-22", 1, 0], ["2026-09-23", 0, 0]]);
const range = resolveRange("7d", days[0].day, "2026-09-23");
eq("period totals from the merged series", periodTotals(range, days, leads).cur, { leads: 17, accepted: 16, earnings: 42.5 });
eq("groupBy site sorted by earnings", groupBy(leads, "2026-09-21", "2026-09-23", (l) => l.site).map((b) => [b.key, b.leads, b.earnings]),
  [["jackson", 2, 27.8], ["el-paso", 1, 1.8]]);
const sr = siteRows(leads, "2026-09-21", "2026-09-23", "2026-09-23");
eq("site rows keep every site, with share", sr.map((s) => [s.key, s.leads, Math.round(s.share * 1000) / 1000]).sort(),
  [["el-paso", 1, 0.061], ["jackson", 2, 0.939]]);
const hp = hourlyPoints(leads, "2026-09-21");
eq("hourly: 24 buckets, first labelled 10:00 Israel", [hp.length, hp[0].label], [24, "10:00"]);
eq("hourly: 15:00Z = 08:00 PDT -> bucket 8, 16:00Z -> bucket 9", [hp[8].value, hp[9].value], [1.8, 27.8]);
eq("loan label", leads[0].loan, "$100–$500");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) throw new Error(`${failed} self-test check(s) failed`);
