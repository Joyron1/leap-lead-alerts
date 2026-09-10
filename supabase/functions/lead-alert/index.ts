// lead-alert — Supabase Edge Function
// Receives a minimal, PII-free ping from the snaploans.cash sites whenever the
// Leap Theory embedded form finishes posting a lead, stores it, and forwards a
// Telegram notification.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const ALERT_KEY = Deno.env.get("ALERT_KEY") ?? "";
const ALLOWED_HOST_SUFFIX = Deno.env.get("ALLOWED_HOST_SUFFIX") ?? "snaploans.cash";
const TZ = Deno.env.get("ALERT_TZ") ?? "Asia/Jerusalem";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function corsHeaders(origin: string | null) {
  const ok = !!origin && originAllowed(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

function originAllowed(origin: string) {
  try {
    const h = new URL(origin).hostname;
    return h === ALLOWED_HOST_SUFFIX || h.endsWith("." + ALLOWED_HOST_SUFFIX);
  } catch {
    return false;
  }
}

// "100;500" -> "$100 – $500"; falls back to the single amount
function formatLoan(range: string | null, amount: number | null) {
  const m = range && range.match(/^(\d+(?:\.\d+)?);(\d+(?:\.\d+)?)$/);
  if (m) return `$${Number(m[1]).toLocaleString("en-US")} – $${Number(m[2]).toLocaleString("en-US")}`;
  if (amount) return `$${amount.toLocaleString("en-US")}`;
  return "";
}

function esc(s: unknown) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Immediate alerts are reserved for leads that actually pay something; everything below this
// is stored silently and batched by the lead-digest function. Dollars.
const DEFAULT_MIN_PAYOUT = 3;
async function minPayout(): Promise<number> {
  const { data } = await supabase.from("app_secrets").select("value").eq("key", "alert_min_payout").maybeSingle();
  const n = Number(data?.value ?? Deno.env.get("ALERT_MIN_PAYOUT") ?? DEFAULT_MIN_PAYOUT);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_PAYOUT;
}

async function sendTelegram(text: string) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${await r.text()}`);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors });
  if (!origin || !originAllowed(origin)) return new Response("forbidden origin", { status: 403, headers: cors });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400, headers: cors }); }

  if (ALERT_KEY && body.key !== ALERT_KEY) return new Response("forbidden", { status: 403, headers: cors });

  const leadId = String(body.leadId ?? "").trim();
  if (!leadId || leadId.length > 64) return new Response("missing leadId", { status: 400, headers: cors });

  const status = String(body.status ?? "unknown").toLowerCase().slice(0, 20);
  const payout = Number(body.payout ?? 0) || 0;
  const row = {
    lead_id: leadId,
    domain: String(body.domain ?? new URL(origin).hostname).slice(0, 120),
    page: String(body.page ?? "").slice(0, 200),
    state: String(body.state ?? "").toUpperCase().slice(0, 2),
    status,
    payout,
    pay_model: String(body.payModel ?? "").slice(0, 10),
    is_declined: body.isDeclined === true,
    source: String(body.source ?? "").slice(0, 20),
    loan_amount: Number(body.loanAmount) > 0 ? Number(body.loanAmount) : null,
    loan_range: String(body.loanRange ?? "").replace(/[^0-9;.-]/g, "").slice(0, 20) || null,
    client_ts: (() => { const d = new Date(String(body.ts ?? "")); return isNaN(d.getTime()) ? null : d.toISOString(); })(),
  };

  // Insert first; a duplicate leadId (e.g. backup hook firing too) is silently ignored -> no double alert.
  const { data: inserted, error } = await supabase
    .from("leap_leads")
    .upsert(row, { onConflict: "lead_id", ignoreDuplicates: true })
    .select("id");
  if (error) return new Response(`db error: ${error.message}`, { status: 500, headers: cors });
  let headline = "ליד חדש";
  if (!inserted || inserted.length === 0) {
    const { data: k } = await supabase.from("leap_leads").select("status, payout").eq("lead_id", leadId).maybeSingle();
    const final = status === "accepted" || status === "rejected";
    const knownFinal = k && (k.status === "accepted" || k.status === "rejected");
    // what only the browser knows
    const patch: Record<string, unknown> = {};
    if (row.loan_amount) patch.loan_amount = row.loan_amount;
    if (row.loan_range) patch.loan_range = row.loan_range;
    if (row.pay_model) patch.pay_model = row.pay_model;
    if (row.page) patch.page = row.page;
    if (k && !knownFinal && final) {
      // the Leap sync announced it as "pending" – complete it now with the real result and alert
      Object.assign(patch, { status, payout, is_declined: row.is_declined });
      await supabase.from("leap_leads").update(patch).eq("lead_id", leadId);
      headline = "ליד חדש"; // the pending row was stored silently, so this is the first (and only) alert
    } else {
      if (Object.keys(patch).length) await supabase.from("leap_leads").update(patch).eq("lead_id", leadId);
      return new Response(JSON.stringify({ ok: true, duplicate: true }), { headers: { ...cors, "content-type": "application/json" } });
    }
  }

  // Cheap lead: the row is already stored, so say nothing now and let lead-digest batch it.
  if (payout < await minPayout()) {
    return new Response(JSON.stringify({ ok: true, digest: true }), {
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  // Note: Leap's isDeclined flag only means the visitor was not redirected to a lender;
  // the lead is still accepted and paid, so it is shown as ACCEPTED.
  const accepted = status === "accepted";
  const icon = accepted ? "✅" : status === "rejected" ? "❌" : "⚠️";
  const label = accepted ? "ACCEPTED" : status === "rejected" ? "REJECTED" : status.toUpperCase();
  const fire = payout > 20 ? " 🔥🔥🔥" : payout > 10 ? " 🔥🔥" : payout > 5 ? " 🔥" : "";
  const loan = formatLoan(row.loan_range, row.loan_amount);
  const text = [
    `${icon} <b>${headline} – ${label}</b>${fire}`,
    `🌐 ${esc(row.domain)}`,
    `📍 ${esc(row.state || "?")}`,
    `💵 $${payout.toFixed(2)}${row.pay_model ? ` (${esc(row.pay_model)})` : ""}`,
    ...(loan ? [`🏦 סכום מבוקש: ${esc(loan)}`] : []),
    `🆔 ${esc(leadId)}`,
  ].join("\n");

  let tgErr: string | null = null;
  try { await sendTelegram(text); } catch (e) { tgErr = String(e).slice(0, 500); }
  await supabase.from("leap_leads").update({ telegram_sent: !tgErr, telegram_error: tgErr }).eq("lead_id", leadId);

  return new Response(JSON.stringify({ ok: !tgErr, telegram: tgErr ?? "sent" }), {
    status: tgErr ? 502 : 200,
    headers: { ...cors, "content-type": "application/json" },
  });
});
