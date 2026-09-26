-- Cash box: money taken out of the Leap earnings. Balance ("updated earnings") = all-time earnings
-- (same merged series the dashboard charts) minus the sum of withdrawals. Written from the dashboard,
-- so this is the first table the browser may modify — only dashboard users, only this table.
create table if not exists public.withdrawals (
  id          bigint generated always as identity primary key,
  withdrawn_on date not null,
  amount      numeric(12,2) not null check (amount > 0),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  created_by  text not null default coalesce(auth.jwt() ->> 'email', 'system')
);
alter table public.withdrawals enable row level security;

revoke all on public.withdrawals from anon;
grant select, insert, update, delete on public.withdrawals to authenticated;

drop policy if exists dashboard_read on public.withdrawals;
create policy dashboard_read on public.withdrawals for select to authenticated using (public.is_dashboard_user());
drop policy if exists dashboard_insert on public.withdrawals;
create policy dashboard_insert on public.withdrawals for insert to authenticated with check (public.is_dashboard_user());
drop policy if exists dashboard_update on public.withdrawals;
create policy dashboard_update on public.withdrawals for update to authenticated using (public.is_dashboard_user()) with check (public.is_dashboard_user());
drop policy if exists dashboard_delete on public.withdrawals;
create policy dashboard_delete on public.withdrawals for delete to authenticated using (public.is_dashboard_user());

-- Opening entry: the owner's total of all withdrawals up to 2026-09-26 (itemised history not provided).
-- Against $6,111.15 earned to date this leaves $1,756.89, matching the owner's own spreadsheet.
insert into public.withdrawals (withdrawn_on, amount, note, created_by)
select '2026-09-26', 4354.26, 'סך כל המשיכות עד 26.9.2026 (יתרת פתיחה)', 'jron81@gmail.com'
where not exists (select 1 from public.withdrawals);
