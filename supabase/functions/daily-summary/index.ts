// daily-summary — Supabase Edge Function
// Sends a simple daily Telegram summary (totals only) of Leap Theory leads stored in leap_leads.
// Triggers: pg_cron (x-cron-key header), manual call (same header), or Telegram bot
// commands via webhook (/summary, /today, /day YYYY-MM-DD).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
// DAY_TZ decides which leads belong to which "day". Leap Theory is based in Santa Monica, CA,
// so their report day is Pacific time; midnight Pacific = 10:00 Israel, so the morning summary
// covers exactly one full Leap day.
// SEND_TZ + SUMMARY_HOUR decide when the morning summary is sent (Israel, 10:00).
const DAY_TZ = Deno.env.get("SUMMARY_TZ") ?? "America/Los_Angeles";
const SEND_TZ = "Asia/Jerusalem";
const SUMMARY_HOUR = Number(Deno.env.get("SUMMARY_HOUR") ?? "10");
const FN_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/daily-summary`;
const SYNC_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/leap-sync`;
const DIGEST_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/lead-digest`;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Row = { accepted: number; rejected: number; earnings: number; state?: string; domain?: string };
type Summary = {
  day: string; total: number; accepted: number; rejected: number; other: number; earnings: number;
  by_state: Row[]; by_domain: Row[]; by_hour: { hour: number; count: number }[];
};

// ---------- time helpers (DST-safe via Intl) ----------
function localParts(d: Date, tz = DAY_TZ) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}
function shiftDate(iso: string, days: number) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function prettyDay(iso: string) {
  const d = new Date(iso + "T12:00:00Z");
  const weekday = new Intl.DateTimeFormat("he-IL", { weekday: "long", timeZone: "UTC" }).format(d);
  const [y, m, dd] = iso.split("-");
  return `יום ${weekday.replace("יום ", "")} ${dd}/${m}/${y}`;
}

// ---------- telegram ----------
async function tg(method: string, payload: Record<string, unknown> | FormData) {
  const isForm = payload instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: isForm ? payload : JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`telegram ${method} ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- summary ----------
async function getSummary(day: string): Promise<Summary> {
  const { data, error } = await supabase.rpc("lead_summary", { p_day: day, p_tz: DAY_TZ });
  if (error) throw new Error(`lead_summary: ${error.message}`);
  return data as Summary;
}

function pct(a: number, t: number) { return t ? Math.round((a / t) * 100) : 0; }
const money = (n: number) => `$${Number(n).toFixed(2)}`;

// Change vs. the previous day: 🟢 +35% (20 → 27) / 🔴 -12% / ⚪ 0%
function cmp(cur: number, prev: number, fmt: (n: number) => string = String) {
  if (!prev && !cur) return "";
  if (!prev) return ` 🟢 חדש (אתמול ${fmt(prev)})`;
  const d = cur - prev;
  const p = Math.round((d / prev) * 100);
  const icon = d > 0 ? "🟢" : d < 0 ? "🔴" : "⚪";
  return ` ${icon} ${d > 0 ? "+" : ""}${p}% (${fmt(prev)} → ${fmt(cur)})`;
}

function buildText(s: Summary, prev: Summary, label: string) {
  const lines: string[] = [];
  lines.push(`📊 <b>${label} – ${esc(prettyDay(s.day))}</b>`);
  lines.push("");
  lines.push(`📥 סה"כ לידים: <b>${s.total}</b>${cmp(s.total, prev.total)}`);
  lines.push(`✅ אושרו: <b>${s.accepted}</b>${s.total ? ` (${pct(s.accepted, s.total)}%)` : ""}${cmp(s.accepted, prev.accepted)}`);
  lines.push(`❌ נדחו: <b>${s.rejected}</b>${s.other ? ` · ⚠️ אחר: ${s.other}` : ""}`);
  lines.push(`💵 רווח: <b>${money(s.earnings)}</b>${cmp(Number(s.earnings), Number(prev.earnings), money)}`);
  if (s.total && s.accepted) lines.push(`📈 ממוצע לליד מאושר: ${money(Number(s.earnings) / s.accepted)}`);
  return lines.join("\n");
}


// ---------- free-form queries (/domain, /state, /top, /week, /month) ----------
type Bucket = { name: string; n: number; accepted: number; earnings: number };
type RangeSummary = {
  from: string; to: string; total: number; accepted: number; rejected: number; earnings: number;
  active_days: number; by_domain: Bucket[]; by_state: Bucket[]; by_loan: Bucket[]; by_day: { day: string; n: number; earnings: number }[];
};

async function getRange(from: string, to: string, domain?: string, state?: string, top = 5): Promise<RangeSummary> {
  const { data, error } = await supabase.rpc("lead_range_summary", {
    p_from: from, p_to: to, p_tz: DAY_TZ, p_domain: domain ?? null, p_state: state ?? null, p_top: top,
  });
  if (error) throw new Error(`lead_range_summary: ${error.message}`);
  return data as RangeSummary;
}

// "7" / "30" = last N full days (yesterday backwards); "month" = this month to date; "today"; "yesterday"
function parsePeriod(arg: string | undefined) {
  const { date: today } = localParts(new Date());
  const a = (arg ?? "").toLowerCase();
  if (a === "today" || a === "היום") return { from: today, to: today, label: "היום" };
  if (a === "yesterday" || a === "אתמול") { const y = shiftDate(today, -1); return { from: y, to: y, label: "אתמול" }; }
  if (a === "month" || a === "חודש") return { from: today.slice(0, 8) + "01", to: today, label: "החודש (עד היום)" };
  const n = /^\d{1,3}$/.test(a) ? Math.max(1, Math.min(365, Number(a))) : 7;
  return { from: shiftDate(today, -n), to: shiftDate(today, -1), label: `${n} הימים האחרונים` };
}
const short = (d: string) => String(d).replace(/\.snaploans\.cash$/, "");
const fmtRange = (r: { from: string; to: string }) => r.from === r.to ? r.from : `${r.from} → ${r.to}`;

function bucketLines(rows: Bucket[]) {
  return rows.map((b, i) => `${i + 1}. ${esc(short(b.name))}: ${money(b.earnings)} · ${b.n} לידים${b.accepted !== b.n ? ` (${b.accepted} אושרו)` : ""}`).join("\n");
}

function rangeHeader(title: string, r: RangeSummary, prev?: RangeSummary) {
  const lines = [`📊 <b>${title}</b>`, `🗓 ${esc(fmtRange(r))}`, ""];
  lines.push(`📥 סה"כ לידים: <b>${r.total}</b>${prev ? cmp(r.total, prev.total) : ""}`);
  lines.push(`✅ אושרו: <b>${r.accepted}</b>${r.total ? ` (${pct(r.accepted, r.total)}%)` : ""}`);
  if (r.rejected) lines.push(`❌ נדחו: <b>${r.rejected}</b>`);
  lines.push(`💵 רווח: <b>${money(r.earnings)}</b>${prev ? cmp(Number(r.earnings), Number(prev.earnings), money) : ""}`);
  if (r.accepted) lines.push(`📈 ממוצע לליד מאושר: ${money(Number(r.earnings) / r.accepted)}`);
  if (r.active_days > 1) lines.push(`📅 ממוצע ליום: ${money(Number(r.earnings) / r.active_days)} · ${(r.total / r.active_days).toFixed(1)} לידים`);
  return lines;
}

async function send(text: string) {
  for (const chunk of splitMessage(text)) {
    await tg("sendMessage", { chat_id: CHAT_ID, text: chunk, parse_mode: "HTML", disable_web_page_preview: true });
  }
}

async function cmdDomain(name: string, periodArg?: string) {
  const p = parsePeriod(periodArg);
  const r = await getRange(p.from, p.to, name);
  if (!r.total) return send(`🌐 <b>${esc(name)}</b> – ${esc(p.label)}\n\nלא נמצאו לידים לדומיין הזה בתקופה.`);
  const lines = rangeHeader(`🌐 ${esc(short(name))} – ${esc(p.label)}`, r);
  if (r.by_domain.length > 1) { lines.push("", "<b>דומיינים תואמים:</b>", bucketLines(r.by_domain)); }
  if (r.by_state.length) { lines.push("", "<b>States מובילים:</b>", bucketLines(r.by_state)); }
  return send(lines.join("\n"));
}

async function cmdState(state: string, periodArg?: string) {
  const p = parsePeriod(periodArg);
  const r = await getRange(p.from, p.to, undefined, state);
  if (!r.total) return send(`📍 <b>${esc(state.toUpperCase())}</b> – ${esc(p.label)}\n\nלא נמצאו לידים מה-state הזה בתקופה.`);
  const lines = rangeHeader(`📍 ${esc(state.toUpperCase())} – ${esc(p.label)}`, r);
  if (r.by_domain.length) { lines.push("", "<b>דומיינים מובילים:</b>", bucketLines(r.by_domain)); }
  return send(lines.join("\n"));
}

async function cmdTop(periodArg?: string) {
  const p = parsePeriod(periodArg);
  const r = await getRange(p.from, p.to, undefined, undefined, 5);
  if (!r.total) return send(`🏆 <b>Top – ${esc(p.label)}</b>\n\nאין לידים בתקופה.`);
  const lines = rangeHeader(`🏆 Top – ${esc(p.label)}`, r);
  lines.push("", "<b>🌐 דומיינים (לפי רווח):</b>", bucketLines(r.by_domain));
  lines.push("", "<b>📍 States (לפי רווח):</b>", bucketLines(r.by_state));
  if (r.by_loan.length) lines.push("", "<b>🏦 סכומים מבוקשים:</b>", bucketLines(r.by_loan.map((b) => ({ ...b, name: b.name.replace(/^(\d+);(\d+)$/, "$$$1–$$$2") }))));
  return send(lines.join("\n"));
}

async function cmdWeek() {
  const { date: today } = localParts(new Date());
  const cur = await getRange(shiftDate(today, -7), shiftDate(today, -1));
  const prev = await getRange(shiftDate(today, -14), shiftDate(today, -8));
  const lines = rangeHeader("📆 סיכום שבועי (7 ימים אחרונים מול 7 שלפניהם)", cur, prev);
  if (cur.by_day.length) {
    lines.push("", "<b>לפי יום:</b>");
    for (const d of cur.by_day) lines.push(`• ${esc(d.day.slice(5))}: ${d.n} לידים · ${money(d.earnings)}`);
  }
  if (cur.by_domain.length) lines.push("", "<b>🌐 דומיינים מובילים:</b>", bucketLines(cur.by_domain));
  if (cur.by_state.length) lines.push("", "<b>📍 States מובילים:</b>", bucketLines(cur.by_state));
  return send(lines.join("\n"));
}

async function cmdMonth() {
  const { date: today } = localParts(new Date());
  const from = today.slice(0, 8) + "01";
  const dayN = Number(today.slice(8, 10));
  const prevFrom = shiftDate(from, -1).slice(0, 8) + "01";
  const prevTo = shiftDate(prevFrom, dayN - 1); // same number of days last month
  const cur = await getRange(from, today);
  const prev = await getRange(prevFrom, prevTo);
  const lines = rangeHeader(`🗓 החודש עד היום (מול ${dayN} הימים הראשונים של החודש הקודם)`, cur, prev);
  if (cur.by_domain.length) lines.push("", "<b>🌐 דומיינים מובילים:</b>", bucketLines(cur.by_domain));
  if (cur.by_state.length) lines.push("", "<b>📍 States מובילים:</b>", bucketLines(cur.by_state));
  return send(lines.join("\n"));
}

// The immediate-alert threshold lives in app_secrets so it can be tuned from the phone,
// without a redeploy. lead-alert and leap-sync read the same key.
async function cmdThreshold(arg?: string) {
  if (arg && /^\d+(\.\d+)?$/.test(arg)) {
    const v = Number(arg);
    await supabase.from("app_secrets").upsert({ key: "alert_min_payout", value: String(v) }, { onConflict: "key" });
    return send(`✅ סף ההתראה המיידית עודכן ל-<b>${money(v)}</b>.\nלידים מתחת לסף ייאספו לסיכום המרוכז.`);
  }
  const { data } = await supabase.from("app_secrets").select("value").eq("key", "alert_min_payout").maybeSingle();
  return send([
    `⚙️ סף ההתראה המיידית: <b>${money(Number(data?.value ?? 3))}</b>`,
    "ליד ששווה יותר מזה מגיע מיד; כל השאר נאסף לסיכום מרוכז כל 3 שעות.",
    "לשינוי: <code>/threshold 5</code>",
  ].join("\n"));
}

// lead-digest sends the message itself, so only the empty case needs an answer here.
async function cmdDigest(key: string) {
  const r = await fetch(DIGEST_URL, {
    method: "POST", headers: { "content-type": "application/json", "x-cron-key": key },
    body: "{}", signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => ({})) as { count?: number };
  if (!j?.count) await send("📭 אין לידים שממתינים לסיכום מרוכז.");
}

const HELP = [
  "<b>פקודות זמינות:</b>",
  "/summary – סיכום של אתמול",
  "/today – סיכום היום עד עכשיו",
  "/day 2026-09-01 – סיכום של תאריך מסוים",
  "/week – 7 ימים אחרונים מול 7 שלפניהם",
  "/month – החודש עד היום מול החודש הקודם",
  "/top – דומיינים ו-states מובילים (7 ימים)",
  "/domain el-paso – נתוני דומיין (7 ימים)",
  "/state TX – נתוני state (7 ימים)",
  "/digest – לשלוח עכשיו את הלידים שממתינים לסיכום מרוכז",
  "/threshold – סף ההתראה המיידית (<code>/threshold 5</code> לשינוי)",
  "",
  "לתקופה אחרת הוסיפי מספר ימים או month: <code>/top 30</code>, <code>/domain jackson month</code>, <code>/state CA today</code>",
  "",
  "סיכום אוטומטי נשלח כל בוקר ב-10:00 (שעון ישראל). הימים נספרים לפי שעון Leap (קליפורניה), כמו בדוח שלהם.",
  "לידים זולים לא מפוצצים את הצ'אט: הם נאספים לסיכום מרוכז כל 3 שעות, ורק ליד מעל הסף מגיע מיד.",
].join("\n");

// Telegram caps a message at 4096 chars; split on line boundaries if needed.
function splitMessage(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = []; let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > max) { out.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

async function sendSummary(day: string, label: string) {
  const [s, prev] = await Promise.all([getSummary(day), getSummary(shiftDate(day, -1))]);
  for (const chunk of splitMessage(buildText(s, prev, label))) {
    await tg("sendMessage", { chat_id: CHAT_ID, text: chunk, parse_mode: "HTML", disable_web_page_preview: true });
  }
  return { day, total: s.total, accepted: s.accepted, earnings: s.earnings };
}

// ---------- auth ----------
async function cronKey(): Promise<string> {
  const { data } = await supabase.from("app_secrets").select("value").eq("key", "cron_key").single();
  return data?.value ?? "";
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const key = await cronKey();
  const url = new URL(req.url);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

  // --- Telegram webhook (bot commands) ---
  if (url.searchParams.get("tg") === "1") {
    if (!key || req.headers.get("x-telegram-bot-api-secret-token") !== key) return new Response("forbidden", { status: 403 });
    const update = await req.json().catch(() => ({}));
    const msg = update?.message ?? update?.channel_post;
    const text: string = String(msg?.text ?? "").trim();
    const chatId = String(msg?.chat?.id ?? "");
    if (!msg || chatId !== String(CHAT_ID)) return json({ ok: true }); // ignore strangers, always 200 so Telegram stops retrying
    const { date: today } = localParts(new Date());
    const [cmd, ...args] = text.replace(/@\w+$/, "").split(/\s+/); // strip "@botname" suffix
    const c = (cmd || "").toLowerCase();
    try {
      if (c === "/today") await sendSummary(today, "סיכום היום עד עכשיו");
      else if (c === "/summary" || c === "/yesterday") await sendSummary(shiftDate(today, -1), "סיכום יומי");
      else if (c === "/day" && /^\d{4}-\d{2}-\d{2}$/.test(args[0] ?? "")) await sendSummary(args[0], "סיכום יומי");
      else if (c === "/week") await cmdWeek();
      else if (c === "/month") await cmdMonth();
      else if (c === "/top") await cmdTop(args[0]);
      else if (c === "/domain" && args[0]) await cmdDomain(args[0].toLowerCase(), args[1]);
      else if (c === "/state" && /^[a-z]{2}$/i.test(args[0] ?? "")) await cmdState(args[0], args[1]);
      else if (c === "/digest") await cmdDigest(key);
      else if (c === "/threshold") await cmdThreshold(args[0]);
      else if (c === "/start" || c === "/help" || c === "/domain" || c === "/state" || c === "/day") await send(HELP);
    } catch (e) {
      await tg("sendMessage", { chat_id: CHAT_ID, text: `⚠️ שגיאה: ${esc(String(e).slice(0, 200))}` }).catch(() => {});
    }
    return json({ ok: true });
  }

  // --- cron / manual ---
  if (!key || req.headers.get("x-cron-key") !== key) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => ({}));

  if (body.setup === "webhook") {
    const r = await tg("setWebhook", { url: `${FN_URL}?tg=1`, secret_token: key, allowed_updates: ["message", "channel_post"], drop_pending_updates: true });
    await tg("setMyCommands", { commands: [
      { command: "summary", description: "סיכום של אתמול" },
      { command: "today", description: "סיכום היום עד עכשיו" },
      { command: "week", description: "7 ימים אחרונים מול 7 שלפניהם" },
      { command: "month", description: "החודש עד היום מול החודש הקודם" },
      { command: "top", description: "דומיינים ו-states מובילים (/top 30)" },
      { command: "domain", description: "נתוני דומיין: /domain el-paso [30|month]" },
      { command: "state", description: "נתוני state: /state TX [30|month]" },
      { command: "day", description: "סיכום לתאריך: /day 2026-09-01" },
      { command: "digest", description: "לשלוח עכשיו את הלידים הממתינים לסיכום מרוכז" },
      { command: "threshold", description: "סף ההתראה המיידית: /threshold 5" },
      { command: "help", description: "רשימת הפקודות" },
    ] }).catch(() => {});
    return json(r);
  }

  const { date: today } = localParts(new Date());
  const { hour } = localParts(new Date(), SEND_TZ);
  if (body.cron === true && hour !== SUMMARY_HOUR) return json({ skipped: true, localHour: hour });

  // Before the morning summary, reconcile yesterday against Leap's own report so the numbers match 1:1.
  if (body.cron === true || body.sync === true) {
    try {
      await fetch(SYNC_URL, { method: "POST", headers: { "content-type": "application/json", "x-cron-key": key },
        body: JSON.stringify({ days: [shiftDate(today, -1), today], alert: true }), signal: AbortSignal.timeout(90_000) });
    } catch (e) { console.error("pre-summary sync failed:", String(e)); }
  }

  let day = shiftDate(today, -1), label = "סיכום יומי";
  if (body.period === "today") { day = today; label = "סיכום היום עד עכשיו"; }
  else if (typeof body.period === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.period)) day = body.period;

  try {
    return json(await sendSummary(day, label));
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
