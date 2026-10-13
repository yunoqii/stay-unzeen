#!/bin/sh
# Build + render the logo system (offline). Needs: python3 with fonttools, node with puppeteer-core (see ../../tools/shoot.mjs).
set -e
cd "$(dirname "$0")"
${PYTHON:-python3} build.py >/dev/null
${PYTHON:-python3} jobs.py
node ../../tools/shoot.mjs .jobs.json
