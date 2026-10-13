#!/bin/sh
# Render all X/Twitter brand assets offline with system Chrome (headless, no network).
# Usage: sh docs/brand/twitter/src/render.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"; OUT="$(dirname "$SRC")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
shot() { # url w h scale out
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$TMP" \
    --host-resolver-rules="MAP * ~NOTFOUND" --allow-file-access-from-files \
    --force-device-scale-factor="$4" --window-size="$2,$3" --virtual-time-budget=3000 \
    --screenshot="$5" "$1" >/dev/null 2>&1
  echo "$5 $(sips -g pixelWidth -g pixelHeight "$5" | awk '/pixel/{printf "%s ", $2}')"
}
for v in a b c; do
  shot "file://$SRC/avatar.html#$v" 400 400 1 "$OUT/avatar-$v.png"
  shot "file://$SRC/avatar.html#$v" 400 400 2 "$OUT/avatar-$v@2x.png"
  shot "file://$SRC/banner.html#$v" 1500 500 1 "$OUT/banner-$v.png"
  shot "file://$SRC/banner.html#$v" 1500 500 2 "$OUT/banner-$v@2x.png"
done
shot "file://$SRC/preview-avatar.html" 1640 1000 1 "$OUT/preview-avatar-circle.png"
shot "file://$SRC/preview-safezone.html" 1600 1720 1 "$OUT/preview-banner-safezone.png"
shot "file://$SRC/preview-profile.html" 1400 1780 1 "$OUT/preview-profile.png"
rm -rf "$TMP"
