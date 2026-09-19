-- Leap's per-lead "Leads" report only keeps a rolling ~90 days (verified 2026-09-19: June 18 had
-- 19 leads on the 18th of September and none on the 19th). Its daily "Statistics" report keeps
-- the full account history and carries figures the per-lead report lacks (redirects, EPL).
-- This table mirrors that report one row per Leap day (America/Los_Angeles).
create table if not exists public.leap_daily_stats (
  day               date primary key,
  leads             integer not null default 0,
  accepted          integer not null default 0,
  accept_rate       numeric(6,2),      -- percent, as Leap shows it
  redirect_rate     numeric(6,2),      -- percent of accepted leads redirected to a lender
  success_redirects integer not null default 0,
  all_redirects     integer not null default 0,
  epl               numeric(10,4),     -- earnings per lead (all leads)
  earnings          numeric(10,2) not null default 0,
  fetched_at        timestamptz not null default now()
);
alter table public.leap_daily_stats enable row level security;

-- Refresh the last 7 Leap days once a day, after the Pacific day has closed (07:00 UTC = midnight
-- Pacific during DST; 08:10 leaves room for Leap to settle the numbers and runs after the summary).
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'leap_stats_daily' loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule('leap_stats_daily', '10 8 * * *', $$
  select net.http_post(url := 'https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/leap-sync',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select value from public.app_secrets where key='cron_key')),
    body := '{"stats":true}'::jsonb, timeout_milliseconds := 60000) $$);
