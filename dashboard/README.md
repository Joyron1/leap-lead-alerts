# Snap Loans dashboard

Private web dashboard over the lead data the Supabase functions collect (`leap_leads`,
`leap_daily_stats`). React + Vite, no server of its own: the browser reads Supabase directly with
the **publishable** key, and the RLS policies from `supabase/migrations/20260926000100_dashboard_access.sql`
decide what a signed-in user may see. Deploys to Vercel unchanged later (root directory `dashboard`).

## Run it locally

Windows: double-click `start-dashboard.cmd` — it starts the server in WSL and opens
<http://localhost:5180>. Or from WSL:

```bash
cd ~/projects/leap-lead-alerts/dashboard
npm install        # first time only
npm run dev        # http://localhost:5180
```

Needs `dashboard/.env.local` (git-ignored) — copy `.env.example` and fill in the publishable key
(Supabase dashboard → Project Settings → API Keys, or the Supabase MCP `get_publishable_keys`).

To get an app window and icon instead of a browser tab: in Chrome/Edge open the dashboard and use
**⋮ → Cast, save and share → Install page as app** (Edge: **Apps → Install this site as an app**).
The installed app only works while the local server is running, until this is on Vercel.

## First sign-in

1. Open the app → **פעם ראשונה? יצירת משתמש**, with an email that is in `public.dashboard_users`
   (seeded with jron81@gmail.com) and a password.
2. Click the confirmation link in the email. If it lands on a wrong page, ignore that — the account
   is confirmed either way. To make it land here, add `http://localhost:5180` (and later the Vercel
   URL) under Supabase → Authentication → URL Configuration → Redirect URLs.
3. Back in the app, sign in.

Access rule: signed in **and** email in `dashboard_users` **and** email confirmed. Anyone else who
signs up sees an "אין הרשאה" screen and zero rows. To add a person:
`insert into public.dashboard_users (email) values ('someone@example.com');`
Before going public on Vercel, also turn off open sign-ups (Authentication → Sign In / Providers).

## What's in it

- **סקירה** — revenue (hero), leads, EPL, accept rate vs the previous period; revenue per hour /
  day / month depending on the range; top sites and states (click a site to see its leads).
- **אתרים** — every site that ever produced a lead: leads, accepted, revenue, EPL, share, last 7
  days vs the 7 before, time since the last lead, and a ⚠ flag after 3 quiet days. Sortable.
- **לידים** — every lead with filters (site, state, status, source, free text), paging, CSV export.

Ranges: היום / 7 / 30 / 90 ימים / החודש / הכל. Days are Leap days (America/Los_Angeles), times are
shown in Israel time. Data refreshes every 2 minutes.

Two data sources, one series: `leap_daily_stats` (whole history since 2025-08-13, refreshed daily)
before the per-lead coverage starts, `leap_leads` (live, per lead) from then on. Leap itself deletes
per-lead rows after ~90 days, so per-site/per-state detail only exists from the backfill onward.

## Checks

```bash
npm run typecheck   # tsc
npm run selftest    # pure data/time logic, no network
npm run build       # production bundle in dist/
```
