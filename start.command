#!/bin/zsh
# Double-click this file to start Fluent (the English coach).
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
URL="http://localhost:4322"
# Chrome is best for voice; any browser works.
openApp() { open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"; }

if ! command -v node >/dev/null; then
  echo "Node.js is missing. Install the LTS version from https://nodejs.org, then double-click start.command again."
  read -k1 "?Press a key to close."
  exit 1
fi

# Already running (second double-click): just open the app.
if curl -fsS -o /dev/null "$URL/api/status" 2>/dev/null; then
  echo "Fluent is already running."
  openApp
  exit 0
fi

if [ ! -d node_modules/@anthropic-ai/sdk ]; then
  echo "First start: installing (one time only)..."
  if ! npm install --no-fund --no-audit; then
    echo "The install failed. Check the internet connection, then double-click start.command again."
    read -k1 "?Press a key to close."
    exit 1
  fi
fi

# Open the browser as soon as the server answers.
( for i in {1..60}; do curl -fsS -o /dev/null "$URL/api/status" 2>/dev/null && { openApp; exit 0; }; sleep 0.5; done ) &
node server.js
