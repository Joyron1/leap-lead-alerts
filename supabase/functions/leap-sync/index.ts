// leap-sync — Supabase Edge Function
// Logs in to the Leap Theory publisher account, reads the "Leads" report for today (and
// yesterday, Pacific time), and fills in any lead the browser-side hook missed:
// inserts it into leap_leads (source = 'leap-sync') and sends the Telegram alert.
// Leap's report is the source of truth, so payout/status of known leads are updated too.
//
// Secrets: LEAP_USER, LEAP_PASS (Leap login), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// Auth: x-cron-key header (value stored in app_secrets.cron_key).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const LEAP_USER = Deno.env.get("LEAP_USER") ?? "";
const LEAP_PASS = Deno.env.get("LEAP_PASS") ?? "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const LEAP_TZ = "America/Los_Angeles";
const BASE = "https://leaptheory.com";
const REPORT_PATH = "/account/publisher/reports/general-report";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ---------- small helpers ----------
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ");
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function localDate(d: Date, tz = LEAP_TZ) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24 };
}
function shiftDate(iso: string, days: number) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
// "2026-09-04" + "07:36" in Pacific -> UTC Date (DST-safe)
function zonedToUtc(day: string, hh: number, mm: number, tz = LEAP_TZ) {
  const [y, m, d] = day.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm); // the wanted wall-clock time, expressed as UTC numbers
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(guess));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
    const wall = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
    const diff = wall - target;
    if (!diff) break;
    guess -= diff;
  }
  return new Date(guess);
}

// ---------- retry for transient failures (gateway timeouts, brief network errors) ----------
async function retry<T>(label: string, fn: () => Promise<T>, tries = 3, delayMs = 1500): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      // do not retry things that will not fix themselves (bad credentials)
      if (/rejected the email\/password|LEAP_USER \/ LEAP_PASS not set/.test(msg)) throw e;
      if (i < tries) await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw new Error(`${label}: ${String((last as Error)?.message ?? last)} (after ${tries} attempts)`);
}

// ---------- telegram ----------
async function tg(text: string) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ---------- state in app_secrets ----------
async function getState(key: string): Promise<string> {
  const { data } = await supabase.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return data?.value ?? "";
}
async function setState(key: string, value: string) {
  await supabase.from("app_secrets").upsert({ key, value }, { onConflict: "key" });
}

// Immediate alerts are reserved for leads that actually pay something; everything below this
// is stored silently and batched by the lead-digest function. Dollars.
const DEFAULT_MIN_PAYOUT = 3;
async function minPayout(): Promise<number> {
  const raw = (await getState("alert_min_payout")) || Deno.env.get("ALERT_MIN_PAYOUT") || "";
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_PAYOUT;
}

// ---------- Leap session (cookie jar) ----------
type Jar = Record<string, string>;
const jarHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(jar: Jar, res: Response) {
  const h = res.headers as any;
  const list: string[] = typeof h.getSetCookie === "function"
    ? h.getSetCookie()
    : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[^=;,\s]+=)/).filter(Boolean);
  for (const c of list) {
    const m = c.match(/^\s*([^=;\s]+)=([^;]*)/);
    if (!m) continue;
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(c)) delete jar[m[1]]; else jar[m[1]] = m[2];
  }
}
async function get(path: string, jar: Jar) {
  const res = await fetch(BASE + path, { headers: { "user-agent": UA, cookie: jarHeader(jar), accept: "text/html,*/*" }, redirect: "manual" });
  absorb(jar, res);
  return res;
}
const isLoginPage = (html: string) => /name="usr"/.test(html) && /name="pwd"/.test(html);

async function login(jar: Jar): Promise<void> {
  if (!LEAP_USER || !LEAP_PASS) throw new Error("LEAP_USER / LEAP_PASS not set");
  // 1) load the login form (any account page shows it) to get the CSRF token + pre-login cookies
  const r1 = await get(REPORT_PATH + "?report=leads", jar);
  const html = await r1.text();
  const csrf = html.match(/name="_ap_csrf"\s+value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("login form / csrf token not found");
  // 2) post credentials to the same URL (the form has no action attribute)
  const body = new URLSearchParams({ _ap_csrf: csrf, usr: LEAP_USER, pwd: LEAP_PASS });
  const r2 = await fetch(BASE + REPORT_PATH + "?report=leads", {
    method: "POST", redirect: "manual",
    headers: { "user-agent": UA, cookie: jarHeader(jar), "content-type": "application/x-www-form-urlencoded", origin: BASE, referer: BASE + REPORT_PATH },
    body,
  });
  absorb(jar, r2);
  const html2 = await r2.text().catch(() => "");
  if (/Invalid/i.test(html2) && isLoginPage(html2)) {
    throw new Error("Leap rejected the email/password (\"Invalid\"). Check LEAP_USER / LEAP_PASS – if the account uses \"Sign in with Google\", set a password via \"Forgot your password?\" first.");
  }
  // 3) verify
  const r3 = await get(REPORT_PATH + "?report=leads", jar);
  const html3 = await r3.text();
  if (isLoginPage(html3)) {
    throw new Error(`login did not stick (POST status ${r2.status}, cookies: ${Object.keys(jar).join(",") || "none"})`);
  }
}

async function fetchReport(day: string, jar: Jar): Promise<string> {
  const path = `${REPORT_PATH}?report=leads&date=${day}+-+${day}`;
  let res = await get(path, jar);
  let html = await res.text();
  if (isLoginPage(html) || res.status === 404 || (res.status >= 300 && res.status < 400)) {
    await login(jar);
    res = await get(path, jar);
    html = await res.text();
    if (isLoginPage(html)) throw new Error("not logged in after login()");
  }
  return html;
}

// ---------- report parsing ----------
type Lead = { id: string; status: string; type: string; hh: number; mm: number; domain: string; state: string; earnings: number };

function parseLeads(html: string): Lead[] {
  const out: Lead[] = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(stripTags);
    if (cells.length < 8) continue;
    const idIdx = cells.findIndex((c) => /^\d{8,20}$/.test(c));
    if (idIdx < 0) continue;
    // Date column: today -> "14:32"; past days -> "Sep 03, 22:31"; be liberal about other date prefixes too
    const timeCell = cells.find((c, i) => i > idIdx && /^(?:[A-Za-z]{3,9}\.? \d{1,2},? |\d{4}-\d{2}-\d{2} |\d{2}-\d{2} |\d{2}\/\d{2}(?:\/\d{2,4})? )?\d{1,2}:\d{2}(?::\d{2})?$/.test(c));
    if (!timeCell) continue;
    const statusCell = cells.find((c) => /^(accepted|rejected|error|pending)$/i.test(c)) ?? "";
    const typeCell = cells.find((c) => /^(form|api|site)$/i.test(c)) ?? "";
    const domIdx = cells.findIndex((c, i) => i > idIdx && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c));
    if (domIdx < 0) continue;
    const state = /^[A-Z]{2}$/.test(cells[domIdx + 1] ?? "") ? cells[domIdx + 1] : "";
    const earnCell = cells.slice(domIdx + (state ? 2 : 1)).find((c) => /^-?\d+(\.\d+)?$/.test(c)) ?? "0";
    const [hh, mm] = timeCell.slice(timeCell.lastIndexOf(" ") + 1).split(":").map(Number);
    out.push({ id: cells[idIdx], status: statusCell.toLowerCase(), type: typeCell, hh, mm, domain: cells[domIdx].toLowerCase(), state, earnings: Number(earnCell) || 0 });
  }
  return out;
}

// ---------- alert text (same look as the instant alert, tagged as synced) ----------
const isFinal = (st: string) => st === "accepted" || st === "rejected";
// 🔥 scale (owner's spec, 2026-09-18): one mark per full $10, nothing under $10, capped at 10 marks
// ($100+). Keep identical to lead-alert.
function fireMarks(payout: number) {
  const n = Math.min(10, Math.floor(payout / 10));
  return n ? " " + "🔥".repeat(n) : "";
}
const timeTag = (l: Lead) => `${String(l.hh).padStart(2, "0")}:${String(l.mm).padStart(2, "0")} שעון קליפורניה`;

function alertText(l: Lead, headline = "ליד חדש") {
  const accepted = l.status === "accepted";
  const icon = accepted ? "✅" : l.status === "rejected" ? "❌" : "⚠️";
  const label = accepted ? "ACCEPTED" : l.status === "rejected" ? "REJECTED" : l.status.toUpperCase();
  const fire = fireMarks(l.earnings);
  // Accepted leads carry the money in the headline, readable from the notification preview.
  const title = accepted ? `${headline} – ${label} – $${l.earnings.toFixed(2)}` : `${headline} – ${label}`;
  return [
    `${icon} <b>${title}</b>${fire}`,
    `🌐 ${esc(l.domain)}`,
    `📍 ${esc(l.state || "?")}`,
    `💵 $${l.earnings.toFixed(2)}`,
    `🆔 ${esc(l.id)}`,
    `🔁 <i>נקלט מהדוח של Leap (${timeTag(l)})</i>`,
  ].join("\n");
}

// ---------- sync one day ----------
async function syncDay(day: string, jar: Jar, alert: boolean) {
  const html = await retry("leap report", () => fetchReport(day, jar));
  const leads = parseLeads(html);
  const ids = leads.map((l) => l.id);
  type Known = { lead_id: string; status: string; payout: number; source: string };
  let existing: Known[] = [];
  if (ids.length) {
    existing = await retry("select known leads", async () => {
      const { data, error } = await supabase.from("leap_leads").select("lead_id, status, payout, source").in("lead_id", ids);
      if (error) throw new Error(error.message);
      return (data ?? []) as Known[];
    });
  }
  const known = new Map<string, Known>(existing.map((r) => [r.lead_id, r]));
  const min = await minPayout(); // below this a lead is stored silently and left to lead-digest
  let inserted = 0, updated = 0, alerted = 0, pending = 0;
  const notify = async (id: string, text: string) => {
    let err: string | null = null;
    try { await tg(text); alerted++; } catch (e) { err = String(e).slice(0, 300); }
    await supabase.from("leap_leads").update({ telegram_sent: !err, telegram_error: err }).eq("lead_id", id);
  };
  for (const l of leads) {
    const k = known.get(l.id);
    const final = isFinal(l.status);
    if (!final) pending++;
    if (!k) {
      // brand-new lead (the browser hook missed it): insert, and alert – stage 1 if not final yet
      const ts = zonedToUtc(day, l.hh, l.mm).toISOString();
      const { error } = await supabase.from("leap_leads").insert({
        lead_id: l.id, domain: l.domain, page: "", state: l.state, status: final ? l.status : "pending", payout: l.earnings,
        pay_model: "", is_declined: false, source: "leap-sync", client_ts: ts, telegram_sent: false,
      });
      if (error) { if (!/duplicate/i.test(error.message)) throw new Error(`insert ${l.id}: ${error.message}`); continue; }
      inserted++;
      // Pending leads wait for Leap to decide them; cheap ones wait for the digest.
      if (alert && final && l.earnings >= min) await notify(l.id, alertText(l));
    } else if (!isFinal(k.status) && final) {
      // a lead stored as pending is now Accepted/Rejected -> this is the (only) alert for it
      await supabase.from("leap_leads").update({ payout: l.earnings, status: l.status }).eq("lead_id", l.id);
      updated++;
      if (alert && l.earnings >= min) await notify(l.id, alertText(l));
    } else if (final && (Number(k.payout) !== l.earnings || k.status !== l.status)) {
      // Leap is the source of truth (e.g. PPR payout credited later). Worth interrupting for
      // only when the new payout crosses the threshold that the first report did not. With the
      // threshold at 0 (alert on everything) "crossing" means going from $0 to anything.
      await supabase.from("leap_leads").update({ payout: l.earnings, status: l.status }).eq("lead_id", l.id);
      updated++;
      const bar = Math.max(min, 0.01);
      if (alert && Number(k.payout) < bar && l.earnings >= bar) await notify(l.id, alertText(l, "עדכון לליד"));
    }
  }
  return { day, inLeap: leads.length, pending, inserted, updated, alerted };
}

// ---------- error notifications ----------
// A single failed run is usually a transient gateway/network hiccup and self-heals a minute later,
// so we only alert after FAIL_STREAK consecutive failures (and at most once per 6h), and send a
// "recovered" message only if a failure was actually announced.
const FAIL_STREAK = 5;
async function noteError(msg: string) {
  const st = JSON.parse((await getState("leap_sync_state")) || "{}");
  const now = Date.now();
  st.fail_count = (st.fail_count ?? 0) + 1;
  st.last_error = msg.slice(0, 500); st.last_error_at = now;
  if (st.fail_count >= FAIL_STREAK && (!st.notified_at || now - st.notified_at > 6 * 3600e3)) {
    const isAuth = /rejected the email\/password|login/i.test(msg);
    await tg(`⚠️ <b>הסנכרון מול Leap נכשל ${st.fail_count} פעמים ברצף</b>\n${esc(msg.slice(0, 300))}\n\n${isAuth ? "נראה כמו בעיית התחברות – בדקי את LEAP_USER / LEAP_PASS ב-Supabase." : "כנראה תקלה זמנית ברשת/בשרת; אודיע כשזה חוזר לעבוד."}\nההתראות מהאתרים ממשיכות לעבוד כרגיל.`).catch(() => {});
    st.notified_at = now; st.announced = true;
  }
  await setState("leap_sync_state", JSON.stringify(st));
}
async function noteOk() {
  const st = JSON.parse((await getState("leap_sync_state")) || "{}");
  if (st.announced) await tg("✅ הסנכרון מול Leap חזר לעבוד.").catch(() => {});
  await setState("leap_sync_state", JSON.stringify({ last_ok_at: Date.now(), fail_count: 0 }));
}

// ---------- liveness watchdog ----------
// The dangerous failure is the silent one: if the form on the sites breaks, or Leap changes the
// report markup so parseLeads matches nothing, every run still returns ok with zero leads and
// noteError never fires. The only symptom is that leads stop arriving, so watch for that directly.
// Measured over the first 10 days: median gap between leads 28 min, p99 4.3h, longest 5.6h —
// hence a 6h default, which would not have produced a single false alarm.
const QUIET_HOURS_DEFAULT = 6;
async function quietCheck() {
  const hours = Number((await getState("quiet_alert_hours")) || QUIET_HOURS_DEFAULT);
  if (!Number.isFinite(hours) || hours <= 0) return; // 0 disables the watchdog
  const { data } = await supabase
    .from("leap_leads").select("client_ts").not("client_ts", "is", null)
    .order("client_ts", { ascending: false }).limit(1).maybeSingle();
  const last = data?.client_ts ? new Date(data.client_ts).getTime() : 0;
  if (!last) return; // empty table: nothing to compare against

  const st = JSON.parse((await getState("quiet_alert_state")) || "{}");
  const now = Date.now();
  const idle = (now - last) / 3600e3;

  if (idle >= hours) {
    // Repeat at most every 6h so a long outage does not become its own flood.
    if (st.notified_at && now - st.notified_at < 6 * 3600e3) return;
    await tg([
      `🔕 <b>לא נכנסו לידים כבר ${idle.toFixed(1)} שעות</b>`,
      `הסף להתראה הוא ${hours} שעות, והפער הכי ארוך שנמדד עד היום היה 5.6 שעות.`,
      "",
      "כדאי לבדוק שהטופס באתרים עדיין נטען ושהדוח של Leap נפתח כרגיל.",
      "אודיע כשלידים יחזרו להיכנס.",
    ].join("\n")).catch(() => {});
    await setState("quiet_alert_state", JSON.stringify({ notified_at: now, announced: true }));
  } else if (st.announced) {
    await tg(`🔔 <b>הלידים חזרו להיכנס.</b>\nהאחרון לפני ${idle.toFixed(1)} שעות.`).catch(() => {});
    await setState("quiet_alert_state", JSON.stringify({ recovered_at: now }));
  }
}

// ---------- handler ----------
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const key = await getState("cron_key");
  if (!key || req.headers.get("x-cron-key") !== key) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => ({}));
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

  const jar: Jar = {};
  try { Object.assign(jar, JSON.parse((await getState("leap_cookies")) || "{}")); } catch { /* ignore */ }

  try {
    const { date: today, hour } = localDate(new Date());
    const alert = body.alert !== false;               // {"alert":false} = backfill silently
    const days: string[] = Array.isArray(body.days) && body.days.length
      ? body.days.filter((d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
      : (hour < 2 ? [shiftDate(today, -1), today] : [today]); // near midnight also re-check yesterday
    if (body.debug === true) {
      const diag = [];
      for (const d of days) {
        const html = await fetchReport(d, jar);
        const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
        const sample = rows
          .map((r) => (r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(stripTags))
          .filter((c) => c.length >= 6).slice(0, 4);
        diag.push({ day: d, htmlLength: html.length, loginPage: isLoginPage(html), trCount: rows.length,
          parsed: parseLeads(html).length, sampleRows: sample,
          elementsText: (html.match(/\d+\s+elements?/i) ?? [])[0] ?? null,
          dateFieldValue: (html.match(/name="date"[^>]*value="([^"]*)"/) ?? [])[1] ?? null });
      }
      await setState("leap_cookies", JSON.stringify(jar));
      return json({ ok: true, debug: diag });
    }
    const results = [];
    for (const d of days) results.push(await syncDay(d, jar, alert));
    await setState("leap_cookies", JSON.stringify(jar));
    await noteOk();
    // Twice an hour is plenty for a 6-hour signal, and keeps this off the per-minute path.
    // {"quiet":true} forces the check for testing.
    const minute = new Date().getUTCMinutes();
    if (alert && (body.quiet === true || (body.cron === true && (minute === 0 || minute === 30)))) {
      await quietCheck().catch(() => {});
    }
    return json({ ok: true, results });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await noteError(msg);
    return json({ ok: false, error: msg }, 500);
  }
});
