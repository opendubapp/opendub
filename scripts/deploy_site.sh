#!/usr/bin/env bash
# Build and deploy the public site to opendub.app.
#   scripts/deploy_site.sh work/<demo-job-dir>
# Everything else before the HTML pages, so a served page never names a file
# that is not there yet; then the live site is tested end to end.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=root@104.36.65.54
ROOT=/var/www/opendub
SITE=${SITE:-https://opendub.app/}

.venv/bin/python scripts/build_site.py "$1"

rsync -a --delete --exclude '*.html' dist/ "$HOST:$ROOT/"
rsync -a dist/*.html "$HOST:$ROOT/"
ssh "$HOST" "chown -R www-data:www-data $ROOT && chmod -R a+rX $ROOT"

node tests/site.mjs "$SITE"
