-- Schedules (UTC). The functions authenticate with x-cron-key = app_secrets.cron_key.
-- Re-running this file is safe: existing jobs with the same names are replaced.
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('daily_summary_0700utc','daily_summary_0800utc','leap_sync_1min') loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

-- Daily summary: fires 07:00 and 08:00 UTC; the function only sends when it is 10:00 in Israel (DST-safe)
select cron.schedule('daily_summary_0700utc', '0 7 * * *', $$
  select net.http_post(url := 'https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/daily-summary',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select value from public.app_secrets where key='cron_key')),
    body := '{"cron":true}'::jsonb, timeout_milliseconds := 60000) $$);
select cron.schedule('daily_summary_0800utc', '0 8 * * *', $$
  select net.http_post(url := 'https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/daily-summary',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select value from public.app_secrets where key='cron_key')),
    body := '{"cron":true}'::jsonb, timeout_milliseconds := 60000) $$);

-- Near-live reconciliation with Leap's own report: every minute
select cron.schedule('leap_sync_1min', '* * * * *', $$
  select net.http_post(url := 'https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/leap-sync',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select value from public.app_secrets where key='cron_key')),
    body := '{"cron":true}'::jsonb, timeout_milliseconds := 50000) $$);
