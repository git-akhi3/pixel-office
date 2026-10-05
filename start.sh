#!/usr/bin/env bash
# Starts the patched Pixel Agents (resident agents) on http://127.0.0.1:3100.
# It shows the office's agents (the control app writes a small transcript into this workspace's
# Claude project folder). PIXEL_WORKSPACE picks the workspace; the default ~/.office/pixel keeps that
# transcript out of your real repos. Turn on "Watch All Sessions" in its settings to also see your own
# Claude sessions. The control app reads the workspace from ~/.office/pixel-workspace.
export PATH="$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
workspace="${PIXEL_WORKSPACE:-$HOME/.office/pixel}"
mkdir -p "$workspace"
mkdir -p "$HOME/.office" && printf '%s\n' "$workspace" > "$HOME/.office/pixel-workspace"
cd "$workspace" && exec node "$here/apps/pixel/dist/cli.js" --port 3100
