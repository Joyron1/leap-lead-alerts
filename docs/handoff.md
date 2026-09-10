# Hand-off notes (2026-09-10)

## Status
- Everything is deployed and running: `lead-alert` (v11), `daily-summary` (v10), `leap-sync` (v10, deployed 2026-09-10 via the Supabase MCP), pg_cron jobs active.
- Data verified against Leap's own report on 2026-09-02 (27/27), 09-03 (24/24 after backfill), 09-04 (21/21).
- WordPress plugin v1.2 is network-active on the multisite.

## Deployed 2026-09-10 (leap-sync v10)
`supabase/functions/leap-sync/index.ts` — this version is now in production:
- retries transient failures (Supabase gateway timeouts, network blips) up to 3×,
- alerts about sync failures only after 5 consecutive failed runs (was: every single failure → noisy "failed"/"recovered" flip-flop),
- clearer failure text (auth problem vs transient).
Future deploys: `scripts/deploy.sh leap-sync` (needs `supabase login` in an interactive terminal first).

## Why the "connection to Leap keeps dropping" messages happened
`net._http_response` showed the failures were `select known leads: Gateway Timeout` — the function's own call to the
Supabase REST gateway timing out (~0.5% of runs), not Leap. With a 1-minute schedule and no retry, one timeout
produced a failure message and the next minute a "recovered" message. Fixed by the pending change above.

## Handy SQL
```sql
-- cron key for manual calls
select value from public.app_secrets where key = 'cron_key';
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
