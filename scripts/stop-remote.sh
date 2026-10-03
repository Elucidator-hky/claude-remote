#!/usr/bin/env bash
# Stop everything
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Stopping..."
pkill -f "ttyd .*-b /t/" 2>/dev/null && echo "  ttyd killed"
pkill -f "$ROOT/bin/frpc" 2>/dev/null && echo "  frpc killed"
pkill -f "relay-server.js" 2>/dev/null && echo "  relay-server killed"
pkill -f "file-server.js" 2>/dev/null && echo "  file-server killed"
echo "Done."
