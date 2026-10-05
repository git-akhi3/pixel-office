"""Custom furniture pack for Pixel Agents: room-name signs + your own images as wall art.

  uv run --with pillow python build_art.py                      # (re)build the room signs
  uv run --with pillow python build_art.py photo.jpg MY_POSTER 3x2   # image -> 3x2-tile wall art

Output: art-pack/assets/furniture/<ID>/{manifest.json,<ID>.png}. Load it once with
Settings > Add Asset Directory > art-pack (or it is already in ~/.pixel-agents/config.json).
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance

PACK = Path(__file__).parent / "art-pack" / "assets" / "furniture"
TILE = 16

# 3x5 pixel font: each glyph is 5 rows of 3 bits
FONT = {
    "A": "010101111101101", "B": "110101110101110", "C": "011100100100011", "D": "110101101101110",
    "E": "111100110100111", "F": "111100110100100", "G": "011100101101011", "H": "101101111101101",
    "I": "111010010010111", "J": "001001001101010", "K": "101101110101101", "L": "100100100100111",
    "M": "101111111101101", "N": "110101101101101", "O": "010101101101010", "P": "110101110100100",
    "Q": "010101101110011", "R": "110101110101101", "S": "011100010001110", "T": "111010010010010",
    "U": "101101101101111", "V": "101101101101010", "W": "101101111111101", "X": "101101010101101",
    "Y": "101101010010010", "Z": "111001010100111", "&": "010101010101011", "-": "000000111000000",
    " ": "000000000000000",
}

# room -> (plate color, accent color), matching the room's floor in build_layouts.py
SIGNS = {
    "MANAGER": ((70, 30, 20), (255, 200, 90)),
    "DESIGN LAB": ((60, 10, 60), (255, 110, 230)),
    "RESEARCH & DOCS": ((45, 35, 20), (240, 200, 120)),
    "REVIEW": ((15, 25, 70), (120, 200, 255)),
    "DEVELOPMENT": ((5, 45, 50), (80, 255, 230)),
    "QA LAB": ((20, 50, 15), (170, 255, 90)),
    "LOUNGE": ((45, 15, 60), (230, 140, 255)),
    "FINANCE": ((55, 45, 5), (255, 220, 60)),
    "HEALTH": ((10, 50, 35), (120, 255, 170)),
}


def sign_id(text: str) -> str:
    return "SIGN_" + re.sub(r"[^A-Z0-9]+", "_", text.upper()).strip("_")


def write_asset(asset_id: str, name: str, img: Image.Image, tiles_w: int, tiles_h: int) -> None:
    d = PACK / asset_id
    d.mkdir(parents=True, exist_ok=True)
    img.save(d / f"{asset_id}.png")
    (d / "manifest.json").write_text(json.dumps({
        "id": asset_id, "name": name, "category": "wall", "type": "asset", "file": f"{asset_id}.png",
        "width": tiles_w * TILE, "height": tiles_h * TILE, "footprintW": tiles_w, "footprintH": tiles_h,
        "canPlaceOnWalls": True, "canPlaceOnSurfaces": False, "backgroundTiles": 0,
    }, indent=2))


def make_sign(text: str, plate: tuple, accent: tuple) -> tuple[str, int]:
    text_w = len(text) * 4 - 1
    tiles_w = max(2, math.ceil((text_w + 6) / TILE))
    w, h = tiles_w * TILE, TILE
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 3, w - 1, h - 3], fill=(*accent, 255))            # neon frame
    d.rectangle([1, 4, w - 2, h - 4], fill=(*plate, 255))             # plate
    d.point([(2, 5), (w - 3, 5), (2, h - 5), (w - 3, h - 5)], fill=(*accent, 255))  # rivets
    x0, y0 = (w - text_w) // 2, 5
    for i, ch in enumerate(text):
        bits = FONT.get(ch, FONT[" "])
        for r in range(5):
            for c in range(3):
                if bits[r * 3 + c] == "1":
                    img.putpixel((x0 + i * 4 + c, y0 + r), (255, 255, 255, 255))
    asset_id = sign_id(text)
    write_asset(asset_id, f"Sign: {text.title()}", img, tiles_w, 1)
    return asset_id, tiles_w


def image_to_wall_art(src: str, asset_id: str, size: str) -> None:
    """Any image -> framed pixel-art painting of W x H tiles (16 px per tile)."""
    tw, th = (int(v) for v in size.lower().split("x"))
    w, h = tw * TILE, th * TILE
    art = Image.open(src).convert("RGB")
    art = ImageEnhance.Color(art).enhance(1.3)
    # crop to the target aspect ratio, then pixelate with a limited palette
    ratio = (w - 4) / (h - 4)
    iw, ih = art.size
    if iw / ih > ratio:
        nw = int(ih * ratio); art = art.crop(((iw - nw) // 2, 0, (iw - nw) // 2 + nw, ih))
    else:
        nh = int(iw / ratio); art = art.crop((0, (ih - nh) // 2, iw, (ih - nh) // 2 + nh))
    art = art.resize((w - 4, h - 4), Image.LANCZOS).quantize(colors=24, method=Image.Quantize.MEDIANCUT).convert("RGBA")
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle([0, 0, w - 1, h - 1], fill=(92, 58, 30, 255), outline=(50, 30, 15, 255))
    img.paste(art, (2, 2))
    write_asset(asset_id, asset_id.replace("_", " ").title(), img, tw, th)
    print(f"{asset_id}: {tw}x{th} tiles -> {PACK / asset_id}")


if __name__ == "__main__":
    if len(sys.argv) == 4:
        image_to_wall_art(sys.argv[1], sys.argv[2].upper(), sys.argv[3])
    else:
        for text, (plate, accent) in SIGNS.items():
            aid, tw = make_sign(text, plate, accent)
            print(f"{aid:24} {tw} tiles wide")
