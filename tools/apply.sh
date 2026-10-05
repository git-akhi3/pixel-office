#!/usr/bin/env bash
# usage: ./apply.sh agent-hq   (then reload the Pixel Agents page)
# backs up the current office once to layouts/original-backup.json
set -e
here="$(cd "$(dirname "$0")" && pwd)"; src="$here/layouts/$1.json"; dst="$HOME/.pixel-agents/layout.json"
[ -f "$src" ] || { echo "no layout: $1 (have: $(ls "$here/layouts" | sed 's/.json//' | tr '\n' ' '))"; exit 1; }
[ -f "$here/layouts/original-backup.json" ] || cp "$dst" "$here/layouts/original-backup.json"
cp "$src" "$dst" && echo "applied $1 -> reload the Pixel Agents page"
