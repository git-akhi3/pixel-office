#!/usr/bin/env bash
# Starts the patched Pixel Agents (resident agents) on http://127.0.0.1:3100.
# It shows the office's agents (the control app writes a small transcript into this workspace's
# Claude project folder). PIXEL_WORKSPACE picks the workspace; the default ~/.office/pixel keeps that
# transcript out of your real repos. Turn on "Watch All Sessions" in its settings to also see your own
# Claude sessions. The control app reads the workspace from $OFFICE_HOME/pixel-workspace.
export PATH="$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
office="${OFFICE_HOME:-$HOME/.office}"
workspace="${PIXEL_WORKSPACE:-$office/pixel}"
mkdir -p "$workspace" "$office"
cd "$workspace" || exit 1
# Pixel Agents tracks its real working directory: record that (symlinks, trailing slashes resolved).
pwd -P > "$office/pixel-workspace"
exec node "$here/apps/pixel/dist/cli.js" --port 3100
