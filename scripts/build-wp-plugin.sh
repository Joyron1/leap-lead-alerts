#!/usr/bin/env bash
# Builds wordpress/leap-lead-alerts.zip for upload (Network Admin → Plugins → Upload → Replace current with uploaded).
# Keep the JS in wordpress/wpcode-snippet.html and the PHP wrapper in sync: the PHP embeds the same <script>.
set -euo pipefail
cd "$(dirname "$0")/../wordpress"
php -l leap-lead-alerts/leap-lead-alerts.php
rm -f leap-lead-alerts.zip && zip -rq leap-lead-alerts.zip leap-lead-alerts && ls -la leap-lead-alerts.zip
