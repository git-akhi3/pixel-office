#!/bin/bash
# Runs the office for its login item (tools/mac-agent.sh); launchd starts it again whenever it exits.
#
# - While another copy serves the port (one you started by hand), it waits, then takes over.
# - The office is the main process, so launchd's SIGTERM reaches its shutdown handler (running steps
#   are parked for you to resume, not killed half-way).
# - caffeinate keeps the Mac from sleeping while the office runs on power. On battery it sleeps as usual.
set -u

root="$(cd "$(dirname "$0")/.." && pwd)"
port="${OFFICE_PORT:-4100}"
home="${OFFICE_HOME:-$HOME/.office}"

# Something holds the port (a copy started by hand, busy or not): wait for it to go.
while (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do
  sleep 30
done

# Without its token the office can't start: say so every few minutes rather than rebuilding the board
# on every relaunch.
if ! grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' "$home/env" 2>/dev/null; then
  echo "$(date '+%F %T') office-service: no CLAUDE_CODE_OAUTH_TOKEN in $home/env yet (see the README)."
  sleep 300
  exit 1
fi

cd "$root/apps/control" || exit 1
npx vite build --config web/vite.config.ts --logLevel warn || exit 1
caffeinate -s -w $$ &
exec node --import tsx server/src/index.ts
