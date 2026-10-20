#!/bin/bash
# Keeps the office running on this Mac while it's awake: a login item (launchd agent) that starts the
# office at login, restarts it after a crash, and keeps the Mac awake on power while it runs.
#
#   tools/mac-agent.sh install [--with-pixel]   install (or reinstall) and start it
#   tools/mac-agent.sh uninstall                stop it and remove the login item
#   tools/mac-agent.sh status                   is it loaded, and is the office answering?
#   tools/mac-agent.sh plist [office|pixel]     print the login item without installing it
#
# install records the PATH of the shell you run it from (and OFFICE_HOME / OFFICE_PORT if set), so the
# office finds node, git, gh and each repo's own tools (flutter, uv, …). Run it again after changing
# your PATH or moving this checkout.
# --with-pixel also keeps the pixel office (npm run pixel) running.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
agents="$HOME/Library/LaunchAgents"
log_dir="${OFFICE_HOME:-$HOME/.office}"
domain="gui/$(id -u)"
OFFICE=com.pixeloffice.office
PIXEL=com.pixeloffice.pixel

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# launchd starts node itself, never a shell script: macOS lets a launchd job into ~/Documents only when
# the program it starts has been allowed there (node has; /bin/bash hasn't).
node_bin="$(command -v node)"
pixel_home="${OFFICE_HOME:-$HOME/.office}/pixel"

# The launchd agent for one service: the office (through office-service.mjs) or the pixel office.
plist() {
  local label program arg2 arg3 workdir log
  if [[ "$1" == office ]]; then
    label=$OFFICE program="$root/tools/office-service.mjs" arg2='' arg3='' workdir="$root" log="$log_dir/server.log"
  else
    label=$PIXEL program="$root/apps/pixel/dist/cli.js" arg2='--port' arg3='3100' workdir="$pixel_home" log="$log_dir/pixel.log"
  fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$(xml "$node_bin")</string><string>$(xml "$program")</string>$(if [[ -n "$arg2" ]]; then printf '<string>%s</string><string>%s</string>' "$arg2" "$arg3"; fi)</array>
  <key>WorkingDirectory</key><string>$(xml "$workdir")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$PATH")</string>
$(for name in OFFICE_HOME OFFICE_PORT; do if [[ -n "${!name:-}" ]]; then printf '    <key>%s</key><string>%s</string>\n' "$name" "$(xml "${!name}")"; fi; done)
  </dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log")</string>
</dict>
</plist>
EOF
}

load() {
  local label=$1 file="$agents/$1.plist"
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl enable "$domain/$label"
  # A previous copy may still be shutting down (up to 30 s): try for a while.
  for _ in $(seq 1 40); do
    launchctl bootstrap "$domain" "$file" 2>/dev/null && return 0
    sleep 1
  done
  launchctl bootstrap "$domain" "$file"
}

unload() {
  launchctl bootout "$domain/$1" 2>/dev/null || true
  rm -f "$agents/$1.plist"
}

case "${1:-}" in
  install)
    mkdir -p "$agents"
    mkdir -p -m 700 "$log_dir"
    plist office >"$agents/$OFFICE.plist"
    plutil -lint -s "$agents/$OFFICE.plist"
    load $OFFICE
    echo "Installed $OFFICE: the office starts at login and restarts if it stops. Log: $log_dir/server.log"
    if [[ "${2:-}" == --with-pixel ]]; then
      # What start.sh does: the pixel office watches this workspace, and the control app reads where it is.
      mkdir -p "$pixel_home" && (cd "$pixel_home" && pwd -P >"${OFFICE_HOME:-$HOME/.office}/pixel-workspace")
      plist pixel >"$agents/$PIXEL.plist"
      plutil -lint -s "$agents/$PIXEL.plist"
      load $PIXEL
      echo "Installed $PIXEL: the pixel office too. Log: $log_dir/pixel.log"
    fi
    ;;
  uninstall)
    unload $OFFICE
    unload $PIXEL
    echo "Removed the login items. The office no longer starts by itself."
    ;;
  status)
    for label in $OFFICE $PIXEL; do
      if launchctl print "$domain/$label" >/dev/null 2>&1; then
        echo "$label: $(launchctl print "$domain/$label" | awk -F' = ' '/^\tstate = /{print $2}')"
      else
        echo "$label: not installed"
      fi
    done
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:${OFFICE_PORT:-4100}/api/health"; then echo "office: answering on port ${OFFICE_PORT:-4100}"; else echo "office: not answering"; fi
    ;;
  plist)
    case "${2:-office}" in office | pixel) plist "${2:-office}" ;; *) echo "plist office|pixel" >&2; exit 1 ;; esac
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
