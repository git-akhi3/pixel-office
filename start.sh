#!/usr/bin/env bash
# Starts the patched Pixel Agents (resident agents) on http://127.0.0.1:3100 for the zobaze repo.
export PATH="$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"; cd "$HOME/Documents/zobaze workspace/zobaze-item-search" && exec node "$here/src/dist/cli.js" --port 3100
