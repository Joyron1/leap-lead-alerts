// lead-digest — Supabase Edge Function
// Most Leap leads pay well under a dollar, so announcing each one drowns the real ones.
// `lead-alert` and `leap-sync` only send an immediate Telegram message for leads worth at
// least app_secrets.alert_min_payout; every other finalized lead is left unannounced and
// collected here into one message, on a cron (every 3h) or on demand from the bot.
//
// Auth: x-cron-key header (value stored in app_secrets.cron_key).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const READ_TZ = "Asia/Jerusalem"; // the digest is read by a human in Israel, not by Leap's report day
const TOP_DOMAINS = 5;
const TOP_STATES = 4;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number) => `$${n.toFixed(2)}`;
const short = (d: string) => String(d).replace(/\.snaploans\.cash$/, "");
const hhmm = (iso: string) =>
  new Intl.DateTimeFormat("he-IL", { timeZone: READ_TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso));

async function tg(text: string) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

type Row = {
  lead_id: string; domain: string | null; state: string | null; status: string | null;
  payout: number | null; client_ts: string | null; received_at: string;
};
type Bucket = { name: string; n: number; usd: number };

// Group by a field, biggest earner first; everything past `top` is folded into one "and N more" row.
function group(rows: Row[], pick: (r: Row) => string, top: number) {
  const m = new Map<string, Bucket>();
  for (const r of rows) {
    const name = pick(r) || "?";
    const b = m.get(name) ?? { name, n: 0, usd: 0 };
    b.n++; b.usd += Number(r.payout ?? 0);
    m.set(name, b);
  }
  const all = [...m.values()].sort((a, b) => b.usd - a.usd || b.n - a.n);
  return { head: all.slice(0, top), rest: all.slice(top) };
}
const foldRest = (rest: Bucket[]) => rest.reduce((a, b) => ({ n: a.n + b.n, usd: a.usd + b.usd }), { n: 0, usd: 0 });

function buildText(rows: Row[]) {
  const total = rows.length;
  const accepted = rows.filter((r) => r.status === "accepted").length;
  const rejected = rows.filter((r) => r.status === "rejected").length;
  const other = total - accepted - rejected;
  const usd = rows.reduce((a, r) => a + Number(r.payout ?? 0), 0);
  const times = rows.map((r) => r.client_ts ?? r.received_at).sort();

  const lines: string[] = [];
  lines.push(`📦 <b>${total} לידים מרוכזים</b>`);
  if (times.length) {
    const from = hhmm(times[0]), to = hhmm(times[times.length - 1]);
    lines.push(`🕐 ${from === to ? from : `${from} – ${to}`} (שעון ישראל)`);
  }
  lines.push(`💵 ${money(usd)} · ✅ ${accepted}${rejected ? ` · ❌ ${rejected}` : ""}${other ? ` · ⚠️ ${other}` : ""}`);

  const dom = group(rows, (r) => short(r.domain ?? ""), TOP_DOMAINS);
  if (dom.head.length) {
    lines.push("", "<b>🌐 דומיינים</b>");
    for (const b of dom.head) lines.push(`• ${esc(b.name)}: ${b.n} · ${money(b.usd)}`);
    if (dom.rest.length) {
      const f = foldRest(dom.rest);
      lines.push(`• עוד ${dom.rest.length} דומיינים: ${f.n} · ${money(f.usd)}`);
    }
  }

  const st = group(rows, (r) => (r.state ?? "").toUpperCase(), TOP_STATES);
  if (st.head.length) {
    const parts = st.head.map((b) => `${esc(b.name)} ${b.n}`);
    if (st.rest.length) parts.push(`+${st.rest.length}`);
    lines.push("", `<b>📍 States</b>  ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const { data: keyRow } = await supabase.from("app_secrets").select("value").eq("key", "cron_key").maybeSingle();
  const key = keyRow?.value ?? "";
  if (!key || req.headers.get("x-cron-key") !== key) return new Response("forbidden", { status: 403 });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

  try {
    // Everything final that nobody has been told about yet. `pending` rows are excluded:
    // Leap has not decided them, so they are not news until leap-sync finalizes them.
    const { data, error } = await supabase
      .from("leap_leads")
      .select("lead_id, domain, state, status, payout, client_ts, received_at")
      .eq("telegram_sent", false)
      .is("digested_at", null)
      .neq("status", "pending")
      .order("received_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(`select undigested: ${error.message}`);

    const rows = (data ?? []) as Row[];
    if (!rows.length) return json({ ok: true, sent: false, count: 0 });

    await tg(buildText(rows));
    // Stamp only after Telegram accepted the message: a failed send is retried by the next run.
    const ids = rows.map((r) => r.lead_id);
    const { error: markErr } = await supabase
      .from("leap_leads").update({ digested_at: new Date().toISOString() }).in("lead_id", ids);
    if (markErr) throw new Error(`mark digested: ${markErr.message}`);

    return json({ ok: true, sent: true, count: rows.length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
