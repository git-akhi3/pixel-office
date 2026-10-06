"""Builds the Avengers theme pack for Pixel Agents.

  uv run --with pillow python build_pack.py

Writes:
  tools/avengers-pack/assets/characters/char_N.png   the heroes (N = 0..7) and six field agents (8..13);
                                                     Pixel Agents appends them after its six bundled skins,
                                                     so hero N is palette 6 + N (see build_layouts.py)
  tools/avengers-pack/assets/furniture/<ID>/        one folder per prop with its manifest.json
  apps/control/web/public/heroes/<role>.png          16x16 portraits (x4) for the board's crew list

Load the pack with Settings > Add Asset Directory (tools/apply.sh avengers does it), then apply the layout.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import heroes  # noqa: E402
import props  # noqa: E402
from pix import scaled, slug, write_asset, write_state_asset  # noqa: E402

HERE = Path(__file__).parent
PACK = HERE.parent / "avengers-pack" / "assets"
PORTRAITS = HERE.parent.parent / "apps" / "control" / "web" / "public" / "heroes"

# Palette index of every character in the pack, as the office sees it (after the 6 bundled skins).
BUNDLED_SKINS = 6


def build_characters() -> dict[str, int]:
    out = PACK / "characters"
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("char_*.png"):
        old.unlink()
    PORTRAITS.mkdir(parents=True, exist_ok=True)
    palettes: dict[str, int] = {}
    for i, h in enumerate(heroes.hero_list()):
        heroes.sheet(h).image().save(out / f"char_{i}.png")
        palettes[h.key] = BUNDLED_SKINS + i
        if h.role:
            scaled(heroes.portrait(h).image(), 4).save(PORTRAITS / f"{h.role}.png")
    # the field agents share one portrait
    agent = next(h for h in heroes.hero_list() if h.key == "agent0")
    scaled(heroes.portrait(agent).image(), 4).save(PORTRAITS / "agent.png")
    return palettes


def build_furniture() -> list[str]:
    out = PACK / "furniture"
    ids = []
    for p in props.PROPS:
        write_asset(out, p.id, p.name, p.category, p.draw(), on_walls=p.on_walls, on_surfaces=p.on_surfaces,
                    background=p.background, orientation=p.orientation)
        ids.append(p.id)
    write_state_asset(out, "HOLO_SCREEN", "Holo screen", "electronics", props._holo_screen(False),
                      [props._holo_screen(True, f) for f in range(3)], on_surfaces=True, background=1)
    ids.append("HOLO_SCREEN")
    for text, (plate, accent) in props.SIGNS.items():
        sid = "SIGN_" + slug(text)
        write_asset(out, sid, f"Sign: {text.title()}", "wall", props.sign(text, plate, accent), on_walls=True)
        ids.append(sid)
    return ids


if __name__ == "__main__":
    palettes = build_characters()
    ids = build_furniture()
    (PACK.parent / "pack.json").write_text(json.dumps({
        "name": "Avengers",
        "palettes": palettes,
        "heroes": {h.role: h.name for h in heroes.hero_list() if h.role},
        "furniture": ids,
    }, indent=2))
    print(f"{len(palettes)} characters, {len(ids)} furniture items -> {PACK}")
