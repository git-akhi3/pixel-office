#!/usr/bin/env bash
# Starts the patched Pixel Agents (resident agents) on http://127.0.0.1:3100. It watches Claude sessions for the cwd below (zobaze-item-search).
export PATH="$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"; cd "$HOME/Documents/zobaze workspace/zobaze-item-search" && exec node "$here/apps/pixel/dist/cli.js" --port 3100
