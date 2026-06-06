#!/usr/bin/env bash
# dev.sh — pull latest, install if needed, start the app, auto-restart on main-process changes
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

# Colors
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

log()  { echo -e "${GREEN}[dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[dev]${NC} $*"; }
err()  { echo -e "${RED}[dev]${NC} $*"; }

pull_and_install() {
  log "Pulling latest from origin..."
  git fetch origin main --quiet
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main)

  if [ "$LOCAL" != "$REMOTE" ]; then
    warn "New commits found — updating..."
    PKG_BEFORE=$(git show HEAD:package.json 2>/dev/null | md5)
    git pull origin main --quiet
    PKG_AFTER=$(cat package.json | md5)
    if [ "$PKG_BEFORE" != "$PKG_AFTER" ]; then
      log "package.json changed — running npm install..."
      npm install --silent
    fi
    log "Updated to $(git rev-parse --short HEAD)"
    return 0  # changed
  fi
  return 1  # no change
}

start_app() {
  log "Starting Aurum Signals FX Bot..."
  npm start &
  APP_PID=$!
  echo $APP_PID
}

stop_app() {
  local pid=$1
  if kill -0 "$pid" 2>/dev/null; then
    warn "Stopping app (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

# Initial pull + install
pull_and_install || true

APP_PID=$(start_app)
log "App running (pid $APP_PID). Watching for changes every 30s..."
log "Press Ctrl+C to stop."

trap 'stop_app $APP_PID; log "Stopped."; exit 0' INT TERM

while true; do
  sleep 30
  if pull_and_install; then
    warn "Code changed — restarting app..."
    stop_app "$APP_PID"
    sleep 1
    APP_PID=$(start_app)
    log "App restarted (pid $APP_PID)"
  fi
done
