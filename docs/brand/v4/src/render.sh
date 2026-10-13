#!/bin/sh
# Brand v4, offline. Needs python3 with fonttools (PYTHON=...), node + puppeteer-core (PUPPETEER_CORE=...), system Chrome.
set -e; cd "$(dirname "$0")"
${PYTHON:-python3} marks.py >/dev/null
${PYTHON:-python3} jobs.py >/dev/null
node ../../tools/shoot.mjs .jobs.json
rm -f .jobs.json
