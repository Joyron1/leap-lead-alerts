-- Weekly keyword report: Monday 08:30 UTC (11:30 Israel), after the 10:00 daily summary has gone out.
-- The function returns quickly (Search Console + Sheet + Telegram) and triggers its own slow
-- research stage in a second invocation, so a 60s pg_net timeout is enough here.
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'keyword_report_weekly' loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule('keyword_report_weekly', '30 8 * * 1', $$
  select net.http_post(url := 'https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/keyword-report',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select value from public.app_secrets where key='cron_key')),
    body := '{"stage":"data","cron":true}'::jsonb, timeout_milliseconds := 60000) $$);
