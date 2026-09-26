-- Read access for the dashboard (dashboard/). The browser uses the publishable key plus a Supabase
-- Auth session; what a signed-in user may read is decided here, not in the frontend.
--
-- Access = a signed-in user whose email is in dashboard_users AND confirmed in auth.users. The
-- confirmation check is deliberate: if "Confirm email" were ever switched off in the Auth settings,
-- anyone could sign up with an allow-listed address; checking email_confirmed_at closes that.

create table if not exists public.dashboard_users (
  email    text primary key,
  added_at timestamptz not null default now()
);
alter table public.dashboard_users enable row level security;   -- no policies: invisible to clients
insert into public.dashboard_users (email) values ('jron81@gmail.com') on conflict do nothing;

create or replace function public.is_dashboard_user() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1
    from public.dashboard_users d
    join auth.users u on lower(u.email) = lower(d.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;
revoke all on function public.is_dashboard_user() from public, anon;
grant execute on function public.is_dashboard_user() to authenticated;

drop policy if exists dashboard_read on public.leap_leads;
create policy dashboard_read on public.leap_leads
  for select to authenticated using (public.is_dashboard_user());

drop policy if exists dashboard_read on public.leap_daily_stats;
create policy dashboard_read on public.leap_daily_stats
  for select to authenticated using (public.is_dashboard_user());

-- Defence in depth. Supabase's default grants give anon/authenticated full write privileges on
-- every public table; RLS already blocks the row-level ones, but TRUNCATE is not subject to RLS.
-- Only the edge functions (service_role) ever write here.
revoke insert, update, delete, truncate on public.leap_leads, public.leap_daily_stats, public.app_secrets,
  public.dashboard_users from anon, authenticated;
