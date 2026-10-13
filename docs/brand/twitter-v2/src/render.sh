#!/bin/sh
# Render X/Twitter v2 assets offline. Needs node + puppeteer-core (see ../../tools/shoot.mjs) and system Chrome.
set -e; cd "$(dirname "$0")"; python3 jobs.py; node ../../tools/shoot.mjs .jobs.json
