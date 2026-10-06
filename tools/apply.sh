#!/usr/bin/env bash
# usage: ./apply.sh helicarrier   (then restart the pixel office: npm run pixel)
#        ./apply.sh agent-hq      (back to the classic office)
# Backs up the current office once to layouts/original-backup.json. A layout that needs a theme pack
# (layouts/<name>.json next to <pack>/pack.json) also registers the pack's asset directory with Pixel Agents.
set -e
here="$(cd "$(dirname "$0")" && pwd)"; src="$here/layouts/$1.json"; dst="$HOME/.pixel-agents/layout.json"
cfg="$HOME/.pixel-agents/config.json"
[ -f "$src" ] || { echo "no layout: $1 (have: $(ls "$here/layouts" | sed 's/.json//' | tr '\n' ' '))"; exit 1; }
[ -f "$here/layouts/original-backup.json" ] || cp "$dst" "$here/layouts/original-backup.json"
cp "$src" "$dst" && echo "applied $1"

# Theme packs: the layout names its theme; the pack lives in <theme>-pack/.
theme="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('theme') or '')" "$src")"
if [ -n "$theme" ] && [ -d "$here/$theme-pack/assets" ]; then
  python3 - "$cfg" "$here/$theme-pack" <<'EOF'
import json, sys
cfg, pack = sys.argv[1], sys.argv[2]
c = json.load(open(cfg))
dirs = c.setdefault("externalAssetDirectories", [])
if pack not in dirs:
    dirs.append(pack)
    json.dump(c, open(cfg, "w"), indent=2)
    print(f"registered asset pack {pack}")
EOF
fi
echo "restart the pixel office (npm run pixel) so it loads the layout and assets, then reload the page"
