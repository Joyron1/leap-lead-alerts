#!/usr/bin/env bash
# Deploy one or all edge functions to the leap-lead-alerts project.
# Usage: scripts/deploy.sh [lead-alert|daily-summary|leap-sync|lead-digest|all]
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_REF=tipuzwoirrzlibplmbji
FN="${1:-all}"
command -v supabase >/dev/null || { echo "Install the Supabase CLI first: npm i -g supabase  (then: supabase login)"; exit 1; }
supabase link --project-ref "$PROJECT_REF" >/dev/null 2>&1 || true
deploy() { echo "→ deploying $1"; supabase functions deploy "$1" --project-ref "$PROJECT_REF" --no-verify-jwt; }
if [ "$FN" = all ]; then for f in lead-alert daily-summary leap-sync lead-digest keyword-report; do deploy "$f"; done; else deploy "$FN"; fi
