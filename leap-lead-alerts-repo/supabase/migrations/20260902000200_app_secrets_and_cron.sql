create extension if not exists pg_cron;
create extension if not exists pg_net;

-- internal state/secrets (service role only): cron_key, leap_cookies, leap_sync_state
create table if not exists public.app_secrets (key text primary key, value text not null);
alter table public.app_secrets enable row level security;
insert into public.app_secrets (key, value) values ('cron_key', encode(gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;
