-- Noise control: an immediate Telegram alert is only worth sending for a lead that pays real money.
-- Leads below app_secrets.alert_min_payout are stored silently and batched by the `lead-digest`
-- function, which stamps digested_at so a lead is never reported twice.
alter table public.leap_leads add column if not exists digested_at timestamptz;

-- lead-digest reads exactly this slice; a partial index keeps it tiny.
create index if not exists leap_leads_undigested_idx
  on public.leap_leads (received_at)
  where telegram_sent = false and digested_at is null;

-- Dollars. Changeable at runtime (bot: /threshold 5) without a redeploy.
insert into public.app_secrets (key, value) values ('alert_min_payout', '3')
on conflict (key) do nothing;

-- Everything already in the table predates the digest, so do not let the first run
-- dump the whole history into one message.
update public.leap_leads set digested_at = now()
where digested_at is null and telegram_sent = false;

-- Batched digest of the sub-threshold leads: every 3 hours (UTC).
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'lead_digest_3h' loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule('lead_digest_3h', '0 */3 * * *', $$
  select net.http_post(url := 'https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/lead-digest',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select value from public.app_secrets where key='cron_key')),
    body := '{"cron":true}'::jsonb, timeout_milliseconds := 60000) $$);
