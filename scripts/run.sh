#!/usr/bin/env bash
# Manually trigger a function. Examples:
#   CRON_KEY=... scripts/run.sh leap-sync '{"cron":true}'
#   CRON_KEY=... scripts/run.sh leap-sync '{"debug":true,"days":["2026-09-04"]}'
#   CRON_KEY=... scripts/run.sh leap-sync '{"days":["2026-09-01"],"alert":false}'   # silent backfill
#   CRON_KEY=... scripts/run.sh daily-summary '{"period":"today"}'
#   CRON_KEY=... scripts/run.sh daily-summary '{"setup":"webhook"}'                  # (re)register the Telegram bot webhook + command menu
set -euo pipefail
: "${CRON_KEY:?set CRON_KEY (scripts/cron-key.sh)}"
FN="${1:?function name}"
# Note: "${2:-{}}" looks right but bash ends the expansion at the first "}", so a supplied
# body came out with a stray "}" appended -> invalid JSON -> the function silently used its
# defaults. Keep the two steps.
BODY="${2-}"; [ -n "$BODY" ] || BODY='{}'
curl -s -w '\n[HTTP %{http_code}]\n' -m 120 -X POST "https://tipuzwoirrzlibplmbji.supabase.co/functions/v1/$FN" \
  -H "x-cron-key: $CRON_KEY" -H 'content-type: application/json' -d "$BODY"
