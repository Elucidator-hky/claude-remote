#!/usr/bin/env bash
# Foreground supervisor for launchd. Starts file-server + frpc in the
# background, then execs relay-server in the foreground. Relay's exit
# (crash or signal) ends this script -> launchd KeepAlive respawns us,
# which pkills+restarts everything from scratch.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# Clean up any leftover processes from a previous instance.
pkill -f "ttyd .*-b /t/" 2>/dev/null
pkill -f "$ROOT/bin/frpc" 2>/dev/null
pkill -f "relay-server.js" 2>/dev/null
pkill -f "file-server.js" 2>/dev/null
sleep 1

# Helper processes — let them tail logs append-mode so launchd respawns
# don't clobber old debug context.
/opt/homebrew/bin/node "$ROOT/scripts/file-server.js" >> "$LOG_DIR/file-server.log" 2>&1 &
FILE_PID=$!

"$ROOT/bin/frpc" -c "$ROOT/config/frpc.toml" >> "$LOG_DIR/frpc.log" 2>&1 &
FRPC_PID=$!

# On exit/signal, kill children so launchd's relaunch starts from a clean slate.
cleanup() {
    kill "$FILE_PID" "$FRPC_PID" 2>/dev/null
    pkill -f "ttyd .*-b /t/" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Foreground: launchd watches THIS pid. relay-server exit -> supervisor exit -> respawn.
exec /opt/homebrew/bin/node "$ROOT/scripts/relay-server.js" >> "$LOG_DIR/relay-server.log" 2>&1
