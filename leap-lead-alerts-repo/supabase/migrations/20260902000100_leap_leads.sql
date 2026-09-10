-- Lead log (no PII). Written by the edge functions via service role only.
create table if not exists public.leap_leads (
  id bigserial primary key,
  lead_id text not null unique,
  domain text,
  page text,
  state text,
  status text,               -- accepted | rejected | pending | unknown
  payout numeric(10,2),
  pay_model text,
  is_declined boolean default false,  -- Leap flag: visitor not redirected to a lender; lead still paid
  source text,               -- xhr | fetch | hook (browser) | leap-sync (Leap report)
  client_ts timestamptz,
  received_at timestamptz not null default now(),
  telegram_sent boolean default false,
  telegram_error text,
  loan_amount numeric(10,2),
  loan_range text            -- e.g. "100;500" = the loan-amount button the visitor clicked
);
create index if not exists leap_leads_received_at_idx on public.leap_leads (received_at desc);
create index if not exists leap_leads_domain_idx on public.leap_leads (domain);
alter table public.leap_leads enable row level security;
