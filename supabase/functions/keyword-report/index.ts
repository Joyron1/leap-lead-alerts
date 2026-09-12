// keyword-report — Supabase Edge Function (weekly, Monday)
// Answers two questions about the snaploans.cash network, every week, in a Google Sheet + Telegram:
//   1. Are the keywords we target actually earning impressions/clicks? (Google Search Console, last 28 days
//      vs the 28 before, per city site and per query, plus "quick wins" and "wasted impressions".)
//   2. Which US payday-loan search terms are we missing? (Claude with web search, fed the GSC facts and
//      each site's live SEO title, asked for a structured verdict.)
//
// Two stages, because the research call can take minutes and an edge invocation cannot:
//   {"stage":"data"}     (default, cron) — GSC -> Sheet tabs Summary/Sites/Queries/Quick wins -> Telegram,
//                        stores the research input in app_secrets, then fires stage "research" at itself.
//   {"stage":"research"} — reads that input, calls Claude, writes the Recommendations tab, second Telegram.
//   {"dry":true}         — either stage: return what would be written, send/write nothing.
//
// Secrets: GSC_SA_JSON (Google service-account key JSON; needs Search Console API + Sheets API enabled, the
//   account added to the GSC property, and the sheet shared with it), GSC_PROPERTY (e.g. sc-domain:snaploans.cash),
//   KEYWORD_SHEET_ID, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// Auth: x-cron-key header (value stored in app_secrets.cron_key).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const GSC_PROPERTY = Deno.env.get("GSC_PROPERTY") ?? "sc-domain:snaploans.cash";
const SHEET_ID = Deno.env.get("KEYWORD_SHEET_ID") ?? "15reZqnfz18V_2Hje0QnmFdqRzgtUUFIBOG7kUriTHMU";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;
const SELF_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/keyword-report`;
const NETWORK_SUFFIX = "snaploans.cash";
const WINDOW_DAYS = 28;
const GSC_LAG_DAYS = 3; // Search Console data is final ~3 days behind

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ---------- small helpers ----------
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const delta = (cur: number, prev: number) => {
  if (!prev && !cur) return "";
  if (!prev) return " 🟢 חדש";
  const p = Math.round(((cur - prev) / prev) * 100);
  return ` ${p > 0 ? "🟢 +" : p < 0 ? "🔴 " : "⚪ "}${p}%`;
};
const isoDaysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
const shortHost = (h: string) => h === NETWORK_SUFFIX ? "(main)" : h.replace(`.${NETWORK_SUFFIX}`, "");

async function getState(key: string): Promise<string> {
  const { data } = await supabase.from("app_secrets").select("value").eq("key", key).maybeSingle();
  return data?.value ?? "";
}
async function setState(key: string, value: string) {
  await supabase.from("app_secrets").upsert({ key, value }, { onConflict: "key" });
}

async function tg(text: string) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ---------- Google service-account auth (RS256 JWT -> access token) ----------
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function googleToken(scopes: string[]): Promise<string> {
  const raw = Deno.env.get("GSC_SA_JSON");
  if (!raw) throw new Error("GSC_SA_JSON not set (Google service-account key)");
  const sa = JSON.parse(raw) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iss: sa.client_email, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`google token: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token as string;
}

// ---------- Search Console ----------
type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

async function gscQuery(token: string, startDate: string, endDate: string): Promise<GscRow[]> {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_PROPERTY)}/searchAnalytics/query`;
  const out: GscRow[] = [];
  for (let startRow = 0; startRow < 25000; startRow += 5000) {
    const r = await fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: ["page", "query"], rowLimit: 5000, startRow, dataState: "final" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`gsc ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const rows = (j.rows ?? []) as GscRow[];
    out.push(...rows);
    if (rows.length < 5000) break;
  }
  return out;
}

type Agg = { clicks: number; impressions: number; posSum: number; n: number };
const bump = (m: Map<string, Agg>, k: string, r: GscRow) => {
  const a = m.get(k) ?? { clicks: 0, impressions: 0, posSum: 0, n: 0 };
  a.clicks += r.clicks; a.impressions += r.impressions; a.posSum += r.position * r.impressions; a.n += r.impressions;
  m.set(k, a);
};
const avgPos = (a: Agg | undefined) => a && a.n ? a.posSum / a.n : 0;
const ctrOf = (a: Agg | undefined) => a && a.impressions ? a.clicks / a.impressions : 0;

// ---------- each site's live SEO title (public Yoast endpoint, no auth) ----------
async function siteTitles(hosts: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...hosts];
  const worker = async () => {
    while (queue.length) {
      const h = queue.shift()!;
      try {
        const r = await fetch(`https://${h}/wp-json/yoast/v1/get_head?url=https://${h}/`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        const t = j?.json?.title;
        if (typeof t === "string") out.set(h, t);
      } catch { /* site down or no Yoast; the report just shows a blank title */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

// ---------- Google Sheets ----------
async function ensureTabs(token: string, tabs: string[]) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`sheets get: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  const have = new Set(((j.sheets ?? []) as { properties: { title: string } }[]).map((s) => s.properties.title));
  const missing = tabs.filter((t) => !have.has(t));
  if (!missing.length) return;
  const r2 = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }),
  });
  if (!r2.ok) throw new Error(`sheets addSheet: ${r2.status} ${(await r2.text()).slice(0, 200)}`);
}

async function writeTab(token: string, tab: string, values: unknown[][]) {
  const range = encodeURIComponent(`${tab}!A1`);
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}!A:Z:clear`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  });
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=RAW`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ range: `${tab}!A1`, majorDimension: "ROWS", values }),
  });
  if (!r.ok) throw new Error(`sheets write ${tab}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// ---------- stage 1: data ----------
type ResearchInput = {
  window: { from: string; to: string };
  network: { clicks: number; impressions: number; prevClicks: number; prevImpressions: number };
  topQueries: { query: string; clicks: number; impressions: number; ctr: string; position: number; prevClicks: number; prevImpressions: number }[];
  quickWins: { site: string; query: string; impressions: number; position: number }[];
  wasted: { query: string; impressions: number; ctr: string; position: number }[];
  sites: { site: string; title: string; clicks: number; impressions: number }[];
  silentSites: string[];
};

async function stageData(dry: boolean) {
  const token = await googleToken(["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/spreadsheets"]);
  const to = isoDaysAgo(GSC_LAG_DAYS), from = isoDaysAgo(GSC_LAG_DAYS + WINDOW_DAYS - 1);
  const pTo = isoDaysAgo(GSC_LAG_DAYS + WINDOW_DAYS), pFrom = isoDaysAgo(GSC_LAG_DAYS + 2 * WINDOW_DAYS - 1);
  const [cur, prev] = await Promise.all([gscQuery(token, from, to), gscQuery(token, pFrom, pTo)]);

  const bySite = new Map<string, Agg>(), bySitePrev = new Map<string, Agg>();
  const byQuery = new Map<string, Agg>(), byQueryPrev = new Map<string, Agg>();
  const bySiteQuery = new Map<string, Agg>();
  for (const r of cur) { const h = hostOf(r.keys[0]); bump(bySite, h, r); bump(byQuery, r.keys[1], r); bump(bySiteQuery, `${h}\t${r.keys[1]}`, r); }
  for (const r of prev) { bump(bySitePrev, hostOf(r.keys[0]), r); bump(byQueryPrev, r.keys[1], r); }
  const sum = (m: Map<string, Agg>) => [...m.values()].reduce((a, b) => ({ clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions }), { clicks: 0, impressions: 0 });
  const net = sum(bySite), netPrev = sum(bySitePrev);

  // Every host we know of: whatever GSC saw in either window, plus every domain that ever sent a lead.
  const { data: leadDomains } = await supabase.from("leap_leads").select("domain").not("domain", "is", null).limit(5000);
  const hosts = new Set<string>([...bySite.keys(), ...bySitePrev.keys()]);
  for (const d of (leadDomains ?? []) as { domain: string }[]) if (d.domain?.endsWith(NETWORK_SUFFIX)) hosts.add(d.domain.toLowerCase());
  hosts.delete("");
  const titles = await siteTitles([...hosts]);

  const sites = [...hosts].map((h) => {
    const a = bySite.get(h), p = bySitePrev.get(h);
    const top = [...bySiteQuery.entries()].filter(([k]) => k.startsWith(`${h}\t`)).sort((x, y) => y[1].impressions - x[1].impressions)[0];
    return { host: h, site: shortHost(h), title: titles.get(h) ?? "", clicks: a?.clicks ?? 0, impressions: a?.impressions ?? 0,
      ctr: ctrOf(a), position: avgPos(a), prevClicks: p?.clicks ?? 0, prevImpressions: p?.impressions ?? 0, topQuery: top ? top[0].split("\t")[1] : "" };
  }).sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions);
  const silentSites = sites.filter((s) => !s.impressions).map((s) => s.site);

  const queries = [...byQuery.entries()].map(([q, a]) => {
    const p = byQueryPrev.get(q);
    return { query: q, clicks: a.clicks, impressions: a.impressions, ctr: ctrOf(a), position: avgPos(a), prevClicks: p?.clicks ?? 0, prevImpressions: p?.impressions ?? 0 };
  }).sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions);

  // Quick wins: real demand, page 1-2 but not top 3 — a title/content tweak can move these.
  const quickWins = [...bySiteQuery.entries()]
    .map(([k, a]) => { const [h, q] = k.split("\t"); return { site: shortHost(h), query: q, impressions: a.impressions, clicks: a.clicks, position: avgPos(a) }; })
    .filter((r) => r.impressions >= 30 && r.position >= 4 && r.position <= 20)
    .sort((x, y) => y.impressions - x.impressions).slice(0, 60);
  // Wasted: lots of impressions, almost no clicks — the title/snippet is not earning the click.
  const wasted = queries.filter((q) => q.impressions >= 200 && q.ctr < 0.005).slice(0, 30);

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const summaryRows: unknown[][] = [
    ["SnapLoans weekly keyword report", stamp],
    ["Window", `${from} → ${to}`, "Previous", `${pFrom} → ${pTo}`],
    [],
    ["Metric", "Current", "Previous", "Change"],
    ["Clicks", net.clicks, netPrev.clicks, delta(net.clicks, netPrev.clicks).trim()],
    ["Impressions", net.impressions, netPrev.impressions, delta(net.impressions, netPrev.impressions).trim()],
    ["CTR", pct(net.impressions ? net.clicks / net.impressions : 0), pct(netPrev.impressions ? netPrev.clicks / netPrev.impressions : 0)],
    ["Sites with impressions", sites.length - silentSites.length, "", ""],
    ["Sites with zero impressions", silentSites.length, silentSites.join(", ")],
    ["Distinct queries", queries.length],
    ["Quick wins (pos 4-20, ≥30 impr)", quickWins.length],
    ["Wasted (≥200 impr, CTR <0.5%)", wasted.length],
  ];
  const siteRows: unknown[][] = [["Site", "Live SEO title", "Clicks", "Impressions", "CTR", "Avg position", "Prev clicks", "Prev impressions", "Δ clicks", "Top query"],
    ...sites.map((s) => [s.site, s.title, s.clicks, s.impressions, pct(s.ctr), +s.position.toFixed(1), s.prevClicks, s.prevImpressions, delta(s.clicks, s.prevClicks).trim(), s.topQuery])];
  const queryRows: unknown[][] = [["Query", "Clicks", "Impressions", "CTR", "Avg position", "Prev clicks", "Prev impressions", "Δ clicks", "Δ impressions"],
    ...queries.slice(0, 500).map((q) => [q.query, q.clicks, q.impressions, pct(q.ctr), +q.position.toFixed(1), q.prevClicks, q.prevImpressions, delta(q.clicks, q.prevClicks).trim(), delta(q.impressions, q.prevImpressions).trim()])];
  const winRows: unknown[][] = [["Site", "Query", "Impressions", "Clicks", "Avg position"], ...quickWins.map((w) => [w.site, w.query, w.impressions, w.clicks, +w.position.toFixed(1)])];

  const research: ResearchInput = {
    window: { from, to },
    network: { clicks: net.clicks, impressions: net.impressions, prevClicks: netPrev.clicks, prevImpressions: netPrev.impressions },
    topQueries: queries.slice(0, 40).map((q) => ({ ...q, ctr: pct(q.ctr), position: +q.position.toFixed(1) })),
    quickWins: quickWins.slice(0, 20).map((w) => ({ site: w.site, query: w.query, impressions: w.impressions, position: +w.position.toFixed(1) })),
    wasted: wasted.slice(0, 10).map((q) => ({ query: q.query, impressions: q.impressions, ctr: pct(q.ctr), position: +q.position.toFixed(1) })),
    sites: sites.slice(0, 60).map((s) => ({ site: s.site, title: s.title, clicks: s.clicks, impressions: s.impressions })),
    silentSites,
  };

  const top3 = queries.slice(0, 3).map((q) => `• ${esc(q.query)}: ${q.clicks} קליקים / ${q.impressions} הופעות${delta(q.clicks, q.prevClicks)}`);
  const text = [
    `📈 <b>דוח מילות מפתח שבועי</b>`,
    `🗓 ${from} → ${to} (מול 28 הימים שלפני)`,
    "",
    `🖱 קליקים: <b>${net.clicks}</b>${delta(net.clicks, netPrev.clicks)}`,
    `👁 הופעות: <b>${net.impressions}</b>${delta(net.impressions, netPrev.impressions)}`,
    `🌐 ${sites.length - silentSites.length} אתרים עם תנועה${silentSites.length ? ` · ${silentSites.length} בלי אף הופעה` : ""}`,
    "",
    "<b>השאילתות המובילות:</b>", ...top3,
    "",
    `🎯 ${quickWins.length} הזדמנויות מהירות (מיקום 4-20 עם ביקוש)`,
    `🕳 ${wasted.length} שאילתות עם הופעות ובלי קליקים`,
    "",
    `📊 הדוח המלא: ${SHEET_URL}`,
    "🤖 המלצות מחקר השוק יגיעו בהודעה נפרדת בעוד כמה דקות.",
  ].join("\n");

  if (dry) return { ok: true, dry: true, stage: "data", summary: summaryRows, sites: siteRows.length - 1, queries: queryRows.length - 1, quickWins: winRows.length - 1, telegram: text, research };

  await ensureTabs(token, ["Summary", "Sites", "Queries", "Quick wins", "Recommendations"]);
  await writeTab(token, "Summary", summaryRows);
  await writeTab(token, "Sites", siteRows);
  await writeTab(token, "Queries", queryRows);
  await writeTab(token, "Quick wins", winRows);
  await setState("keyword_report_input", JSON.stringify(research));
  await tg(text);

  // Hand the slow part to a fresh invocation so this one returns well inside the time limit.
  const key = await getState("cron_key");
  const kick = fetch(SELF_URL, { method: "POST", headers: { "content-type": "application/json", "x-cron-key": key }, body: JSON.stringify({ stage: "research" }) }).catch(() => {});
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(kick);
  return { ok: true, stage: "data", clicks: net.clicks, impressions: net.impressions, sites: sites.length, silent: silentSites.length, quickWins: quickWins.length };
}

// ---------- stage 2: research (Claude + web search, structured JSON) ----------
type Research = {
  summary_he: string;
  current_keywords: { keyword: string; verdict: "keep" | "fix_title" | "drop"; why: string }[];
  missing_keywords: { keyword: string; why: string; evidence: string; suggested_page: string }[];
  quick_win_actions: { site: string; query: string; action: string }[];
};

const RESEARCH_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["summary_he", "current_keywords", "missing_keywords", "quick_win_actions"],
  properties: {
    summary_he: { type: "string", description: "3-5 short Hebrew sentences for a Telegram message: the one thing to do this week, and why." },
    current_keywords: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["keyword", "verdict", "why"],
      properties: { keyword: { type: "string" }, verdict: { type: "string", enum: ["keep", "fix_title", "drop"] }, why: { type: "string" } } } },
    missing_keywords: { type: "array", maxItems: 15, items: { type: "object", additionalProperties: false, required: ["keyword", "why", "evidence", "suggested_page"],
      properties: { keyword: { type: "string" }, why: { type: "string" }, evidence: { type: "string", description: "What in the search results or the GSC data supports this; name sources." }, suggested_page: { type: "string", description: "Which page type on a city site should target it: home | get-a-loan | instant-cash-guide | rates-fees | blog post" } } } },
    quick_win_actions: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["site", "query", "action"],
      properties: { site: { type: "string" }, query: { type: "string" }, action: { type: "string" } } } },
  },
} as const;

async function stageResearch(dry: boolean) {
  const raw = await getState("keyword_report_input");
  if (!raw) throw new Error("no keyword_report_input: run stage data first");
  const input = JSON.parse(raw) as ResearchInput;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey, timeout: 240_000 });

  const system = [
    "You are an SEO analyst for a network of ~53 US city subdomains under snaploans.cash that refer visitors to payday / short-term lenders (affiliate; leads are paid by Leap Theory).",
    "Each city site has a home page, a get-a-loan page, an instant-cash guide, a rates & fees page, and localized blog posts. Titles follow patterns like 'Payday Loans {City} {ST} | ...'.",
    "You are given 28 days of Google Search Console facts for the whole network and each site's live SEO title.",
    "Job: (1) judge the keywords we currently target — keep, fix the title/snippet, or drop; (2) name US payday-loan / short-term-loan search terms with real demand that the network does not target yet, with evidence; (3) turn the quick wins into concrete page-level actions.",
    "Use web search to check what US searchers actually type in this niche right now (e.g. current terminology, 'near me' phrasing, state-specific terms, competitor titles on page 1). Cite what you found in `evidence`. Do not invent search volumes; if you do not have a number, say so.",
    "Compliance matters: never suggest keywords that promise guaranteed approval, no credit check as a guarantee, or anything deceptive. Prefer intent terms that match what the sites truthfully offer.",
    "Write `summary_he` in Hebrew, plain and specific. Everything else in English.",
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Search Console data and current titles (JSON):\n${JSON.stringify(input)}` }];
  const params = {
    model: "claude-opus-5",
    max_tokens: 16000,
    system,
    tools: [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 8, user_location: { type: "approximate" as const, country: "US" } }],
    output_config: { format: { type: "json_schema" as const, schema: RESEARCH_SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
  };

  // Manual loop: a server-tool turn can stop with pause_turn; push the partial turn back and continue.
  let message = await client.beta.messages.create({ ...params, messages });
  for (let i = 0; i < 4 && message.stop_reason === "pause_turn"; i++) {
    messages.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });
    message = await client.beta.messages.create({ ...params, messages });
  }
  if (message.stop_reason === "refusal") throw new Error("Claude declined the research request");
  const textBlock = message.content.find((b: { type: string }) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error(`no text in response (stop_reason ${message.stop_reason})`);
  const research = JSON.parse(textBlock.text) as Research;

  const rows: unknown[][] = [["Type", "Keyword / query", "Site / page", "Verdict / action", "Why", "Evidence"]];
  for (const k of research.current_keywords) rows.push(["current", k.keyword, "", k.verdict, k.why, ""]);
  for (const k of research.missing_keywords) rows.push(["missing", k.keyword, k.suggested_page, "add", k.why, k.evidence]);
  for (const a of research.quick_win_actions) rows.push(["quick win", a.query, a.site, a.action, "", ""]);
  rows.push([], ["Summary (he)", research.summary_he], ["Generated", new Date().toISOString(), `model ${message.model}`, `in ${message.usage.input_tokens} / out ${message.usage.output_tokens} tokens`]);

  const missing = research.missing_keywords.slice(0, 5).map((k) => `• ${esc(k.keyword)} → ${esc(k.suggested_page)}`);
  const fixes = research.current_keywords.filter((k) => k.verdict !== "keep").slice(0, 4).map((k) => `• ${esc(k.keyword)}: ${k.verdict === "drop" ? "לוותר" : "לתקן כותרת"} – ${esc(k.why)}`);
  const text = [
    "🤖 <b>המלצות מחקר השוק השבועי</b>",
    "",
    esc(research.summary_he),
    ...(missing.length ? ["", "<b>מילות מפתח שחסרות לנו:</b>", ...missing] : []),
    ...(fixes.length ? ["", "<b>מה לשנות במילים הנוכחיות:</b>", ...fixes] : []),
    "",
    `📊 הפירוט והראיות בלשונית Recommendations: ${SHEET_URL}`,
  ].join("\n");

  if (dry) return { ok: true, dry: true, stage: "research", research, telegram: text, usage: message.usage };
  const token = await googleToken(["https://www.googleapis.com/auth/spreadsheets"]);
  await ensureTabs(token, ["Recommendations"]);
  await writeTab(token, "Recommendations", rows);
  await tg(text);
  return { ok: true, stage: "research", current: research.current_keywords.length, missing: research.missing_keywords.length, usage: message.usage };
}

// ---------- handler ----------
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const key = await getState("cron_key");
  if (!key || req.headers.get("x-cron-key") !== key) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => ({})) as { stage?: string; dry?: boolean };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const dry = body.dry === true;
  try {
    const result = body.stage === "research" ? await stageResearch(dry) : await stageData(dry);
    return json(result);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (!dry) await tg(`⚠️ <b>דוח מילות המפתח נכשל</b> (${esc(body.stage ?? "data")})\n${esc(msg.slice(0, 300))}`).catch(() => {});
    return json({ ok: false, stage: body.stage ?? "data", error: msg }, 500);
  }
});
