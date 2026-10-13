#!/bin/sh
# Final brand set, offline. Needs python3 with fonttools (PYTHON=...), node + puppeteer-core (PUPPETEER_CORE=...), system Chrome.
set -e; cd "$(dirname "$0")"
${PYTHON:-python3} build.py >/dev/null
${PYTHON:-python3} jobs.py >/dev/null
node ../../tools/shoot.mjs .jobs.json
${PYTHON:-python3} build.py ico
rm -f .jobs.json
