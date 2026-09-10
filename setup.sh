#!/usr/bin/env bash
set -euo pipefail

export BROWSER_EXECUTABLE_PATH="/usr/sbin/firefox"

if [ ! -x "$BROWSER_EXECUTABLE_PATH" ]; then
  echo "Error: $BROWSER_EXECUTABLE_PATH is not found or not executable. Install Firefox first." >&2
  exit 1
fi

echo "==> 1. Installing dependencies and compiling TypeScript"
if command -v bun >/dev/null 2>&1; then
  bun install
  bun run build
else
  npm install
  npm run build
fi

echo "==> 2. Installing OpenH264 and Widevine DRM into Firefox profile"
python3 tools/install_firefox_media.py --accept-license

echo "==> 3. Opening Spotify in Firefox for initial login"
echo "Log in, set Spotify language to English, and return to the terminal."
if command -v bun >/dev/null 2>&1; then
  bun run login
else
  npm run login
fi

echo ""
echo "Setup complete. Start the API server with:"
echo "  export API_TOKEN=\$(node -e \"process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))\")"
echo "  export BROWSER_EXECUTABLE_PATH=/usr/sbin/firefox"
echo "  bun run start"
