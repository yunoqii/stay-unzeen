#!/bin/sh
# Build + render brand v3 offline. Needs python3 with fonttools (PYTHON=...), node with puppeteer-core
# (PUPPETEER_CORE=..., see ../../tools/shoot.mjs) and system Chrome. ONLY=<regex> renders a subset.
set -e; cd "$(dirname "$0")"
${PYTHON:-python3} build.py >/dev/null
${PYTHON:-python3} jobs.py
node ../../tools/shoot.mjs .jobs.json
