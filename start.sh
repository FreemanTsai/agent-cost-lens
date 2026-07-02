#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Parsing Codex logs ==="
node scripts/parse-codex-logs.mjs --fill=30
node scripts/parse-claude-logs.mjs --fill=30

echo "=== Starting server ==="
node scripts/server.mjs &
SERVER_PID=$!
sleep 1

case "$(uname -s)" in
  Darwin) open "http://localhost:8080" ;;
  Linux)  xdg-open "http://localhost:8080" 2>/dev/null || echo "Open http://localhost:8080 in your browser" ;;
  MINGW*|MSYS*|CYGWIN*) start "http://localhost:8080" ;;
  *) echo "Open http://localhost:8080 in your browser" ;;
esac

echo "Press Ctrl+C to stop"
trap "kill $SERVER_PID 2>/dev/null; exit" INT TERM
wait $SERVER_PID
