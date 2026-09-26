// push-send — Supabase Edge Function
// Delivers Web Push notifications to every device registered in push_subscriptions, so a lead pops
// up on the computer/phone even when the dashboard is closed.
//
// Callers:
//   - the leap_leads trigger (push_on_final_lead) via pg_net, header x-cron-key, body {"lead_id": "..."}:
//     fires once per lead, when Leap has accepted/rejected it (the same moment Telegram announces it)
//   - the dashboard's "test" button, with the signed-in user's JWT, body {"test": true}:
//     sends a test to that user's own devices
//   - an operator, x-cron-key + {"test": true}: test to every device
//
// Secrets: VAPID_PRIVATE_JWK (P-256 private key as JWK), VAPID_SUBJECT (contact URL).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendPush, type PushResult } from "../_shared/webpush.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const VAPID_JWK = Deno.env.get("VAPID_PRIVATE_JWK") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "https://leap-lead-alerts.vercel.app";
const ORIGINS = ["https://leap-lead-alerts.vercel.app", "http://localhost:5180"];
const NETWORK = "snaploans.cash";

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ORIGINS.includes(origin) ? origin : ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
});

type Sub = { id: number; endpoint: string; p256dh: string; auth: string; user_email: string };
type LeadRow = { lead_id: string; domain: string | null; state: string | null; status: string | null; payout: number | string | null; loan_range: string | null };

// Same scale as the Telegram alerts: one mark per full $10, max ten.
const fireMarks = (p: number) => "🔥".repeat(Math.max(0, Math.min(10, Math.floor(p / 10))));
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function leadMessage(l: LeadRow) {
  const payout = Number(l.payout) || 0;
  const accepted = l.status === "accepted";
  const site = (l.domain ?? "").toLowerCase().replace(`.${NETWORK}`, "") || "?";
  const m = l.loan_range?.match(/^(\d+(?:\.\d+)?);(\d+(?:\.\d+)?)$/);
  const loan = m ? `סכום מבוקש $${Number(m[1]).toLocaleString("en-US")}–$${Number(m[2]).toLocaleString("en-US")}` : "";
  return {
    title: accepted ? `✅ ליד חדש – ${money(payout)} ${fireMarks(payout)}`.trim() : "❌ ליד נדחה",
    body: [site, (l.state ?? "").toUpperCase(), loan].filter(Boolean).join(" · "),
    tag: l.lead_id,
    url: "/",
  };
}

// Only devices of people who are still on the dashboard allow-list.
async function targets(email?: string): Promise<Sub[]> {
  const { data: users } = await supabase.from("dashboard_users").select("email");
  const allowed = new Set(((users ?? []) as { email: string }[]).map((u) => u.email.toLowerCase()));
  let q = supabase.from("push_subscriptions").select("id, endpoint, p256dh, auth, user_email");
  if (email) q = q.eq("user_email", email.toLowerCase());
  const { data, error } = await q;
  if (error) throw new Error(`push_subscriptions: ${error.message}`);
  return ((data ?? []) as Sub[]).filter((s) => allowed.has(s.user_email.toLowerCase()));
}

async function deliver(subs: Sub[], message: unknown) {
  const jwk = JSON.parse(VAPID_JWK) as JsonWebKey;
  const results: PushResult[] = await Promise.all(subs.map((s) => sendPush(s, message, { jwk, subject: VAPID_SUBJECT })));
  let sent = 0, removed = 0, failed = 0;
  await Promise.all(results.map(async (r, i) => {
    const id = subs[i].id;
    if (r.status >= 200 && r.status < 300) {
      sent++;
      await supabase.from("push_subscriptions").update({ last_ok_at: new Date().toISOString(), failures: 0, last_error: null }).eq("id", id);
    } else if (r.gone) {
      removed++;
      await supabase.from("push_subscriptions").delete().eq("id", id);
    } else {
      failed++;
      const { data } = await supabase.from("push_subscriptions").select("failures").eq("id", id).maybeSingle();
      await supabase.from("push_subscriptions").update({ failures: ((data?.failures as number) ?? 0) + 1, last_error: `${r.status} ${r.error ?? ""}`.slice(0, 300) }).eq("id", id);
    }
  }));
  return { total: subs.length, sent, removed, failed, statuses: results.map((r) => r.status) };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { ...cors(origin), "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!VAPID_JWK) return json({ error: "VAPID_PRIVATE_JWK not set" }, 500);

  const body = await req.json().catch(() => ({})) as { lead_id?: string; test?: boolean };
  const { data: keyRow } = await supabase.from("app_secrets").select("value").eq("key", "cron_key").maybeSingle();
  const isSystem = !!keyRow?.value && req.headers.get("x-cron-key") === keyRow.value;

  // A signed-in dashboard user may only send a test to their own devices.
  let email: string | undefined;
  if (!isSystem) {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data } = token ? await supabase.auth.getUser(token) : { data: { user: null } };
    const user = data.user;
    if (!user?.email || !user.email_confirmed_at) return json({ error: "forbidden" }, 403);
    const { data: allowed } = await supabase.from("dashboard_users").select("email").eq("email", user.email.toLowerCase()).maybeSingle();
    if (!allowed) return json({ error: "forbidden" }, 403);
    email = user.email.toLowerCase();
  }

  try {
    if (body.test) {
      const subs = await targets(email);
      return json({ ok: true, mode: "test", ...(await deliver(subs, { title: "🔔 בדיקת התראה", body: "התראות Snap Loans מגיעות למכשיר הזה.", tag: "test", url: "/" })) });
    }
    if (isSystem && body.lead_id) {
      const { data: lead } = await supabase.from("leap_leads").select("lead_id, domain, state, status, payout, loan_range").eq("lead_id", body.lead_id).maybeSingle();
      if (!lead || (lead.status !== "accepted" && lead.status !== "rejected")) return json({ ok: true, skipped: "not final" });
      return json({ ok: true, mode: "lead", ...(await deliver(await targets(), leadMessage(lead as LeadRow))) });
    }
    return json({ error: "nothing to do: send {test:true} or {lead_id} with x-cron-key" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
