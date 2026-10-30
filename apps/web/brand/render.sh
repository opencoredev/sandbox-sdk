#!/usr/bin/env bash
# Renders the PNG logos, social images and README banner with agent-browser.
# Needs agent-browser on PATH and the web app's dependencies installed.
# Run `bun apps/web/brand/build.ts` first: the PNG logos are drawn from its SVGs.
# Usage: apps/web/brand/render.sh [mark] [preview-dir]
#   mark: a name from marks.ts (default: the `logo` there). With a preview dir,
#   the social images go there instead of to their place in the repo, and the
#   PNG logos are skipped.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
web="$(cd "$here/.." && pwd)"
repo="$(cd "$web/../.." && pwd)"
mark="${1:-}"
preview="${2:-}"
fonts="$web/node_modules/geist/dist/fonts"
port="${BRAND_PORT:-47677}"
site="$(mktemp -d)"
server=""
cleanup() {
  if [ -n "$server" ]; then kill "$server" 2>/dev/null || true; fi
  agent-browser --session sandbox-sdk-brand close >/dev/null 2>&1 || true
  rm -rf "${site:?}"
}
trap cleanup EXIT

cp "$here/card.html" "$here/raster.html" "$site/"
cp -r "$web/public" "$site/public"
cp -r "$repo/apps/docs/public/integrations" "$site/integrations"
mkdir -p "$site/fonts"
cp "$fonts/geist-sans/Geist-Regular.woff2" "$fonts/geist-sans/Geist-Medium.woff2" \
  "$fonts/geist-mono/GeistMono-Regular.woff2" "$fonts/geist-pixel/GeistPixel-Square.woff2" "$site/fonts/"
bun build "$here/card.ts" --outfile "$site/card.js" --target browser >/dev/null

python3 -m http.server "$port" --bind 127.0.0.1 --directory "$site" >/dev/null 2>&1 &
server=$!
sleep 0.5
# another process on the port would serve the wrong files
if ! kill -0 "$server" 2>/dev/null; then
  echo "Could not start a server on port $port. Set BRAND_PORT to a free port." >&2
  exit 1
fi

ab() { agent-browser --session sandbox-sdk-brand "$@"; }
base="http://127.0.0.1:$port"

card() {
  local name="$1" w="$2" h="$3" dest="$4"
  if [ -n "$preview" ]; then dest="$preview/$name-${mark:-default}.png"; fi
  ab set viewport "$w" "$h" >/dev/null
  ab open "$base/card.html?card=$name&mark=$mark" >/dev/null
  ab wait '#card[data-ready="1"]' >/dev/null
  ab screenshot "#card" "$dest" >/dev/null
  echo "$dest"
}

# draws an image the server holds into a transparent PNG, with corners of radius $5
raster() {
  local src="$1" w="$2" h="$3" dest="$4" r="${5:-0}"
  ab open "$base/raster.html?src=$src&w=$w&h=$h&r=$r" >/dev/null
  ab wait --fn "window.png" >/dev/null
  ab eval "window.png" | tr -d '"\n' | base64 -d >"$dest"
  echo "$dest"
}

card og 1200 630 "$web/public/og-image.png"
card social 1280 640 "$here/github-social-preview.png"
# the README banner, at 2x with transparent rounded corners
banner="$repo/.github/banner.png"
if [ -n "$preview" ]; then banner="$preview/banner-${mark:-default}.png"; fi
ab set viewport 1280 720 2 >/dev/null
ab open "$base/card.html?card=banner&mark=$mark" >/dev/null
ab wait '#card[data-ready="1"]' >/dev/null
ab screenshot "#card" "$site/banner-square.png" >/dev/null
raster /banner-square.png 2560 1440 "$banner" 40
ab set viewport 1280 640 1 >/dev/null
[ -n "$preview" ] && exit 0

cp "$web/public/og-image.png" "$web/public/brand/sandbox-sdk-og.png"
raster /public/brand/sandbox-sdk-mark.svg 512 512 "$web/public/brand/sandbox-sdk-mark.png"
raster /public/brand/sandbox-sdk-mark-cream.svg 512 512 "$web/public/brand/sandbox-sdk-mark-cream.png"
raster /public/brand/sandbox-sdk-mark-dark.svg 512 512 "$web/public/brand/sandbox-sdk-mark-dark.png"
raster /public/brand/sandbox-sdk-lockup.svg 772 128 "$web/public/brand/sandbox-sdk-lockup.png"
raster /public/brand/sandbox-sdk-lockup-dark.svg 772 128 "$web/public/brand/sandbox-sdk-lockup-dark.png"
raster /public/favicon-dark.svg 180 180 "$web/src/app/apple-icon.png"
