// All "days" in this app are Leap days: calendar days in America/Los_Angeles, exactly as Leap's own
// reports and the Telegram bot count them. Display times are shown in Israel time.
export const LEAP_TZ = "America/Los_Angeles";
export const VIEW_TZ = "Asia/Jerusalem";

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: LEAP_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const pacificDay = (ms: number) => dayFmt.format(new Date(ms));
export const todayPT = () => pacificDay(Date.now());

export function addDays(day: string, n: number) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export const daysInclusive = (from: string, to: string) =>
  Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / 864e5) + 1;

// Wall-clock midnight of a Leap day as a UTC epoch (DST-safe; same technique as leap-sync).
export function pacificMidnight(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, 0, 0);
  let guess = target;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: LEAP_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  for (let i = 0; i < 3; i++) {
    const p = fmt.formatToParts(new Date(guess));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
    const wall = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
    if (wall === target) break;
    guess -= wall - target;
  }
  return guess;
}

const ilDateTime = new Intl.DateTimeFormat("he-IL", { timeZone: VIEW_TZ, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const ilHour = new Intl.DateTimeFormat("he-IL", { timeZone: VIEW_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
export const israelDateTime = (ms: number) => ilDateTime.format(new Date(ms));
export const israelHour = (ms: number) => ilHour.format(new Date(ms));

export function shortDay(day: string) {
  const [, m, d] = day.split("-");
  return `${Number(d)}/${Number(m)}`;
}
export function longDay(day: string) {
  const [y, m, d] = day.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
}
export function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return `${m}/${y.slice(2)}`;
}

export function relativeHe(ms: number, now = Date.now()) {
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return "עכשיו";
  if (min < 60) return `לפני ${min} דק׳`;
  const h = Math.round(min / 60);
  if (h < 24) return `לפני ${h} שע׳`;
  const d = Math.round(h / 24);
  return d === 1 ? "לפני יום" : `לפני ${d} ימים`;
}

// ---------- date ranges ----------
export type RangeKey = "today" | "7d" | "30d" | "90d" | "mtd" | "all";
export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "היום" },
  { key: "7d", label: "7 ימים" },
  { key: "30d", label: "30 יום" },
  { key: "90d", label: "90 יום" },
  { key: "mtd", label: "החודש" },
  { key: "all", label: "הכל" },
];
export type Range = { key: RangeKey; from: string; to: string; prev: { from: string; to: string } | null; prevLabel: string };

export function resolveRange(key: RangeKey, firstDay: string, today = todayPT()): Range {
  const back = (n: number): Range => ({
    key, from: addDays(today, -(n - 1)), to: today,
    prev: { from: addDays(today, -(2 * n - 1)), to: addDays(today, -n) }, prevLabel: `לעומת ${n} הימים שלפני`,
  });
  switch (key) {
    case "today":
      // "Yesterday up to the same time" is computed from the per-lead rows (see periodTotals).
      return { key, from: today, to: today, prev: { from: addDays(today, -1), to: addDays(today, -1) }, prevLabel: "לעומת אתמול עד אותה שעה" };
    case "7d": return back(7);
    case "30d": return back(30);
    case "90d": return back(90);
    case "mtd": {
      const from = today.slice(0, 8) + "01";
      const prevFrom = addDays(from, -1).slice(0, 8) + "01";
      const prevEndCap = addDays(from, -1);
      const sameDay = addDays(prevFrom, daysInclusive(from, today) - 1);
      return { key, from, to: today, prev: { from: prevFrom, to: sameDay < prevEndCap ? sameDay : prevEndCap }, prevLabel: "לעומת אותם ימים בחודש הקודם" };
    }
    case "all":
      return { key, from: firstDay, to: today, prev: null, prevLabel: "" };
  }
}
