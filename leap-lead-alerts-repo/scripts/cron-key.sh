#!/usr/bin/env bash
# Prints the internal cron key (needed to call the functions manually). Requires: supabase link + psql access,
# or run the SQL in the Supabase SQL editor:  select value from public.app_secrets where key = 'cron_key';
set -euo pipefail
cd "$(dirname "$0")/.."
supabase db query "select value from public.app_secrets where key = 'cron_key';" 2>/dev/null || \
  echo "Run in the SQL editor: select value from public.app_secrets where key = 'cron_key';"
