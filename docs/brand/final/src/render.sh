#!/bin/sh
# Final brand set, offline. Needs python3 with fonttools (PYTHON=...), node + puppeteer-core (PUPPETEER_CORE=...), system Chrome.
set -e; cd "$(dirname "$0")"
${PYTHON:-python3} build.py >/dev/null
${PYTHON:-python3} jobs.py >/dev/null
node ../../tools/shoot.mjs .jobs.json
${PYTHON:-python3} build.py ico
cp ../../v3/x/avatar-d.png ../x-avatar-400.png; cp ../../v3/x/avatar-d@2x.png ../x-avatar-400@2x.png
cp ../../v3/x/banner-d.png ../x-banner-1500x500.png; cp ../../v3/x/banner-d@2x.png ../x-banner-1500x500@2x.png
rm -f .jobs.json
