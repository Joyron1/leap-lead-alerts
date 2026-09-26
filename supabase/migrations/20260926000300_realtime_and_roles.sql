-- 1) Live lead alerts in the dashboard: stream row changes over Supabase Realtime. Realtime applies the
--    subscriber's RLS, so only dashboard users receive events (same select policies as the REST reads).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'leap_leads') then
    alter publication supabase_realtime add table public.leap_leads;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'withdrawals') then
    alter publication supabase_realtime add table public.withdrawals;
  end if;
end $$;

-- 2) Roles. Everyone in dashboard_users can read everything; only admins change the cash box.
--    New rows default to 'viewer' so adding a person never grants write access by accident.
alter table public.dashboard_users add column if not exists role text not null default 'viewer';
do $$ begin
  alter table public.dashboard_users add constraint dashboard_users_role_check check (role in ('admin', 'viewer'));
exception when duplicate_object then null; end $$;
update public.dashboard_users set role = 'admin' where lower(email) = 'jron81@gmail.com';

-- The caller's role, or null when not an allowed + confirmed user. Used by the UI and the policies.
create or replace function public.dashboard_role() returns text
language sql stable security definer set search_path = public, auth as $$
  select d.role
  from public.dashboard_users d
  join auth.users u on lower(u.email) = lower(d.email)
  where u.id = auth.uid() and u.email_confirmed_at is not null
  limit 1;
$$;
revoke all on function public.dashboard_role() from public, anon;
grant execute on function public.dashboard_role() to authenticated;

create or replace function public.is_dashboard_admin() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select coalesce(public.dashboard_role() = 'admin', false);
$$;
revoke all on function public.is_dashboard_admin() from public, anon;
grant execute on function public.is_dashboard_admin() to authenticated;

drop policy if exists dashboard_insert on public.withdrawals;
create policy dashboard_insert on public.withdrawals for insert to authenticated with check (public.is_dashboard_admin());
drop policy if exists dashboard_update on public.withdrawals;
create policy dashboard_update on public.withdrawals for update to authenticated using (public.is_dashboard_admin()) with check (public.is_dashboard_admin());
drop policy if exists dashboard_delete on public.withdrawals;
create policy dashboard_delete on public.withdrawals for delete to authenticated using (public.is_dashboard_admin());
