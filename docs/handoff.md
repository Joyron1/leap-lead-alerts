# Hand-off notes (2026-09-10)

## Status
- Everything is deployed and running: `lead-alert` (v13), `daily-summary` (v12), `leap-sync` (v14), `lead-digest` (v1). All four were deployed from this repo on 2026-09-10 with `scripts/deploy.sh`, so production == repo. Four pg_cron jobs are active: `leap_sync_1min`, `lead_digest_3h`, `daily_summary_0700utc`, `daily_summary_0800utc`.
- Data verified against Leap's own report on 2026-09-02 (27/27), 09-03 (24/24 after backfill), 09-04 (21/21).
- WordPress plugin v1.2 is network-active on the multisite.

## Deployed 2026-09-10 (leap-sync retry fix)
`supabase/functions/leap-sync/index.ts` — this version is now in production:
- retries transient failures (Supabase gateway timeouts, network blips) up to 3×,
- alerts about sync failures only after 5 consecutive failed runs (was: every single failure → noisy "failed"/"recovered" flip-flop),
- clearer failure text (auth problem vs transient).
Future deploys: `scripts/deploy.sh leap-sync` from WSL (see below). Note: running `scripts/deploy.sh` with no argument deploys **all** functions.

## Repo / environment
- Source of truth: https://github.com/Joyron1/leap-lead-alerts. Working copy: `~/projects/leap-lead-alerts` in WSL (Ubuntu).
- Supabase CLI 2.117 lives in WSL at `~/.local/bin/supabase` (no sudo needed), already logged in and linked to the project. The Windows npm install is not logged in; use WSL.

## 2026-09-12: back to one message per lead
Joy tried the digest for two days and did not like it: every lead should show up as its own message the moment it lands.
`alert_min_payout` is now **0**, so every finalized lead alerts immediately and the digest never
has anything to send. The digest code and its cron stay in place (dormant, harmless) — restore the
batching with `/threshold 3` at any time. Do not re-enable it on your own initiative.

## Alert threshold + digest (added 2026-09-10, switched off 2026-09-12 — see above)
The chat was getting ~27 messages a day, most of them for leads paying a few cents: of the first
265 accepted leads, 159 paid ≤$0.60 and only 4 paid over $10. So:
- an **immediate** alert now requires `payout >= app_secrets.alert_min_payout` (seeded at **$3**),
- every other finalized lead is stored silently and batched by the new **`lead-digest`** function
  (cron `0 */3 * * *`) into one message with totals, top domains and top states,
- `leap_leads.digested_at` marks what a digest already reported, so a lead is announced exactly once,
- 🔥 marks moved to $5 / $10 / $20; at the old $10/$30/$50 they had essentially never appeared,
- new bot commands: `/threshold` (read, `/threshold 5` to change — no redeploy needed) and `/digest`
  (send what is waiting right now).

The migration backfilled `digested_at = now()` on the 44 historical rows that had never been sent,
so the first digest could not dump the whole history.

Expected volume after the change: roughly 2 immediate alerts a day plus up to 8 digests, instead of ~27 pings.
If it still feels noisy, raise the threshold from the phone; there is no redeploy involved.

## Why the "connection to Leap keeps dropping" messages happened
`net._http_response` showed the failures were `select known leads: Gateway Timeout` — the function's own call to the
Supabase REST gateway timing out (~0.5% of runs), not Leap. With a 1-minute schedule and no retry, one timeout
produced a failure message and the next minute a "recovered" message. Fixed by the pending change above.

## Liveness watchdog (added 2026-09-10)
The system had no defence against its worst failure: a broken form on the sites, or a change to
Leap's report markup that makes `parseLeads` match nothing. Both produce runs that return `ok`
with zero leads, so the failure alert never fires and the first sign is a bad morning summary.

`leap-sync` now checks twice an hour (at :00 and :30) how long it has been since the newest lead.
Past `app_secrets.quiet_alert_hours` (default **6**) it warns once, repeats at most every 6h while
the drought lasts, and sends a "leads are back" message when they resume. `/quiet` shows it,
`/quiet 4` changes it, `/quiet 0` disables it. Force a check with `{"quiet":true}`.

6h was chosen from the data, not by feel: over the first 10 days the median gap between leads was
28 minutes, p99 4.3h and the longest 5.6h, so 6h produces no false alarms while 5h would already
have fired once on healthy traffic. Re-check this once there is more history.

Both paths were verified end to end on 2026-09-10 by temporarily setting the threshold to 0.2h
(alert fired) and back to 6h (recovery message fired, state reset).

## `scripts/run.sh` was sending broken JSON (fixed 2026-09-10)
The script built its body as `BODY="${2:-{}}"`. Bash ends the expansion at the first `}`, so a
supplied body came out with a stray `}` appended, the function's `req.json()` threw, and the
`.catch(() => ({}))` made it fall back to its defaults. Every documented manual call was affected:
`{"setup":"webhook"}` just sent yesterday's summary, `{"debug":true,...}` never reached debug mode.
If a manual call ever looks like it ignored its arguments, check the body first.

## Handy SQL
```sql
-- cron key for manual calls
select value from public.app_secrets where key = 'cron_key';
-- leads waiting for the next digest
select count(*) from public.leap_leads where telegram_sent = false and digested_at is null and status <> 'pending';
-- current immediate-alert threshold (dollars) and watchdog window (hours)
select key, value from public.app_secrets where key in ('alert_min_payout','quiet_alert_hours');
-- how long since the last lead
select round(extract(epoch from (now() - max(client_ts)))/3600, 2) as idle_hours from public.leap_leads;
-- today by Leap's day
select * from public.lead_summary(current_date, 'America/Los_Angeles');
-- recent sync results
select created, status_code, left(content::text, 200) from net._http_response order by created desc limit 20;
-- cron jobs
select jobname, schedule, active from cron.job;
```

## Type-check locally without Deno
```bash
cat > /tmp/stub.d.ts <<'STUB'
declare const Deno: any;
declare module "jsr:@supabase/functions-js/edge-runtime.d.ts" {}
declare module "npm:@supabase/supabase-js@2" { export function createClient(a: string, b: string): any; }
STUB
tsc --noEmit --strict --target es2022 --lib es2022,dom,dom.iterable /tmp/stub.d.ts supabase/functions/leap-sync/index.ts
```

## Ideas discussed but not built
- Storing applicant PII (name/phone/email…) for future campaigns — deliberately NOT built; needs review of the Leap publisher agreement, TCPA/CCPA consent language, and must never include SSN/DOB/bank data. If done, store in a locked Supabase table, not WordPress.
- Weekly summary, quiet-day alert, dashboard/export.
