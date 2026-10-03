#!/usr/bin/env bash
# Claude Code Remote - macOS one-click start
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

echo "=== Claude Code Remote (macOS) ==="

echo "Stopping old processes..."
pkill -f "ttyd .*-b /t/" 2>/dev/null || true
pkill -f "$ROOT/bin/frpc" 2>/dev/null || true
pkill -f "relay-server.js" 2>/dev/null || true
pkill -f "file-server.js" 2>/dev/null || true
sleep 1

echo "Starting relay-server..."
nohup /opt/homebrew/bin/node "$ROOT/scripts/relay-server.js" \
    > "$LOG_DIR/relay-server.log" 2>&1 &
echo "  relay-server PID $!"

echo "Starting file-server..."
nohup /opt/homebrew/bin/node "$ROOT/scripts/file-server.js" \
    > "$LOG_DIR/file-server.log" 2>&1 &
echo "  file-server PID $!"

sleep 1

echo "Starting frpc..."
nohup "$ROOT/bin/frpc" -c "$ROOT/config/frpc.toml" \
    > "$LOG_DIR/frpc.log" 2>&1 &
echo "  frpc PID $!"

sleep 2

echo ""
echo "=== Status ==="
if lsof -nP -iTCP:7691 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  relay-server: listening on :7691 OK"
else
    echo "  relay-server: NOT listening — check $LOG_DIR/relay-server.log"
fi

if lsof -nP -iTCP:7690 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  file-server: listening on :7690 OK"
else
    echo "  file-server: NOT listening — check $LOG_DIR/file-server.log"
fi

if pgrep -f "$ROOT/bin/frpc" >/dev/null; then
    echo "  frpc: running (PID $(pgrep -f "$ROOT/bin/frpc"))"
else
    echo "  frpc: NOT running — check $LOG_DIR/frpc.log"
fi

echo ""
echo "URL: https://<your-domain>/claude/"
echo "Logs: $LOG_DIR/"
