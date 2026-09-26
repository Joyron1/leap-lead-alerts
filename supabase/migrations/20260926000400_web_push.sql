-- Web Push: devices that asked for lead notifications, and a trigger that fires push-send once per lead.

create table if not exists public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_email  text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text not null default '',
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failures    integer not null default 0,
  last_error  text
);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- A signed-in dashboard user manages only their own devices. Delivery (push-send) uses the service role.
drop policy if exists own_read on public.push_subscriptions;
create policy own_read on public.push_subscriptions for select to authenticated
  using (public.is_dashboard_user() and user_email = lower(auth.jwt() ->> 'email'));
drop policy if exists own_insert on public.push_subscriptions;
create policy own_insert on public.push_subscriptions for insert to authenticated
  with check (public.is_dashboard_user() and user_email = lower(auth.jwt() ->> 'email'));
drop policy if exists own_update on public.push_subscriptions;
create policy own_update on public.push_subscriptions for update to authenticated
  using (public.is_dashboard_user() and user_email = lower(auth.jwt() ->> 'email'))
  with check (public.is_dashboard_user() and user_email = lower(auth.jwt() ->> 'email'));
drop policy if exists own_delete on public.push_subscriptions;
create policy own_delete on public.push_subscriptions for delete to authenticated
  using (user_email = lower(auth.jwt() ->> 'email'));

-- One push per lead, at the moment Leap decides it (accepted/rejected) — the same rule as Telegram.
-- Rows older than 30 minutes never push, so silent historical backfills stay silent.
-- Any failure here is swallowed: a notification problem must never block storing a lead.
create or replace function public.push_on_final_lead() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_key text;
begin
  if new.status in ('accepted', 'rejected')
     and (tg_op = 'INSERT' or coalesce(old.status, '') not in ('accepted', 'rejected'))
     and coalesce(new.client_ts, new.received_at) > now() - interval '30 minutes'
     and exists (select 1 from public.push_subscriptions)
  then
    begin
      select value into v_key from public.app_secrets where key = 'cron_key';
      perform net.http_post(
        url := 'https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/push-send',
        headers := jsonb_build_object('content-type', 'application/json', 'x-cron-key', v_key),
        body := jsonb_build_object('lead_id', new.lead_id),
        timeout_milliseconds := 20000);
    exception when others then
      raise warning 'push_on_final_lead: %', sqlerrm;
    end;
  end if;
  return new;
end $$;
revoke all on function public.push_on_final_lead() from public, anon, authenticated;

drop trigger if exists leap_leads_push on public.leap_leads;
create trigger leap_leads_push
  after insert or update of status on public.leap_leads
  for each row execute function public.push_on_final_lead();
