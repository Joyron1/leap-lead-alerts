-- Daily aggregation by local calendar day (default: Leap's Pacific day)
create or replace function public.lead_summary(p_day date, p_tz text default 'America/Los_Angeles')
returns jsonb language sql stable security definer set search_path = public as $$
with base as (
  select coalesce(nullif(state, ''), '?') as state, domain, status, payout,
         (coalesce(client_ts, received_at) at time zone p_tz) as local_ts,
         (status = 'accepted') as ok
  from public.leap_leads
  where coalesce(source, '') <> 'test' and lead_id not like 'TEST-%'
    and (coalesce(client_ts, received_at) at time zone p_tz)::date = p_day
)
select jsonb_build_object(
  'day', p_day,
  'total', (select count(*) from base),
  'accepted', (select count(*) from base where ok),
  'rejected', (select count(*) from base where status = 'rejected'),
  'other', (select count(*) from base where not ok and status <> 'rejected'),
  'earnings', (select coalesce(sum(payout), 0) from base where ok),
  'by_state', (select coalesce(jsonb_agg(jsonb_build_object('state', state, 'accepted', a, 'rejected', r, 'earnings', e) order by (a + r) desc, e desc), '[]'::jsonb)
    from (select state, count(*) filter (where ok) a, count(*) filter (where status = 'rejected') r, coalesce(sum(payout) filter (where ok), 0) e from base group by state) s),
  'by_domain', (select coalesce(jsonb_agg(jsonb_build_object('domain', domain, 'accepted', a, 'rejected', r, 'earnings', e) order by (a + r) desc, e desc), '[]'::jsonb)
    from (select domain, count(*) filter (where ok) a, count(*) filter (where status = 'rejected') r, coalesce(sum(payout) filter (where ok), 0) e from base group by domain) d),
  'by_hour', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'count', c) order by h), '[]'::jsonb)
    from (select extract(hour from local_ts)::int h, count(*) c from base group by 1) x)
);
$$;
revoke all on function public.lead_summary(date, text) from public, anon, authenticated;

-- Range aggregation (bot commands /week /month /top /domain /state)
create or replace function public.lead_range_summary(
  p_from date, p_to date, p_tz text default 'America/Los_Angeles',
  p_domain text default null, p_state text default null, p_top int default 5)
returns jsonb language sql stable security definer set search_path = public as $$
with base as (
  select coalesce(nullif(state, ''), '?') as state, domain, status, payout, loan_range,
         (coalesce(client_ts, received_at) at time zone p_tz)::date as d,
         (status = 'accepted') as ok
  from public.leap_leads
  where coalesce(source, '') <> 'test' and lead_id not like 'TEST-%'
    and (coalesce(client_ts, received_at) at time zone p_tz)::date between p_from and p_to
    and (p_domain is null or domain ilike '%' || p_domain || '%')
    and (p_state is null or state = upper(p_state))
)
select jsonb_build_object(
  'from', p_from, 'to', p_to,
  'total', (select count(*) from base),
  'accepted', (select count(*) from base where ok),
  'rejected', (select count(*) from base where status = 'rejected'),
  'earnings', (select coalesce(sum(payout), 0) from base where ok),
  'active_days', (select count(distinct d) from base),
  'by_domain', (select coalesce(jsonb_agg(x order by e desc, n desc), '[]'::jsonb) from (
      select jsonb_build_object('name', domain, 'n', count(*), 'accepted', count(*) filter (where ok), 'earnings', coalesce(sum(payout) filter (where ok),0)) x,
             coalesce(sum(payout) filter (where ok),0) e, count(*) n from base group by domain order by e desc, n desc limit p_top) t),
  'by_state', (select coalesce(jsonb_agg(x order by e desc, n desc), '[]'::jsonb) from (
      select jsonb_build_object('name', state, 'n', count(*), 'accepted', count(*) filter (where ok), 'earnings', coalesce(sum(payout) filter (where ok),0)) x,
             coalesce(sum(payout) filter (where ok),0) e, count(*) n from base group by state order by e desc, n desc limit p_top) t),
  'by_loan', (select coalesce(jsonb_agg(x order by n desc), '[]'::jsonb) from (
      select jsonb_build_object('name', coalesce(loan_range, '?'), 'n', count(*), 'accepted', count(*) filter (where ok), 'earnings', coalesce(sum(payout) filter (where ok),0)) x, count(*) n
      from base group by loan_range order by n desc limit p_top) t),
  'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n, 'earnings', e) order by d), '[]'::jsonb) from (
      select d, count(*) n, coalesce(sum(payout) filter (where ok),0) e from base group by d) t)
);
$$;
revoke all on function public.lead_range_summary(date, date, text, text, text, int) from public, anon, authenticated;
