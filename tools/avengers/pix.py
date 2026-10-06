"""Tiny pixel-art toolkit for the Avengers pack: a sprite grid with an automatic outline, a 3x5 font,
and the manifest writer that Pixel Agents' external asset loader understands."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from PIL import Image

RGBA = tuple[int, int, int, int]
TILE = 16
OUTLINE = (24, 20, 32, 255)


def rgb(r: int, g: int, b: int) -> RGBA:
    return (r, g, b, 255)


def shade(c: RGBA, k: float) -> RGBA:
    """k < 1 darkens, k > 1 lightens."""
    return (min(255, int(c[0] * k)), min(255, int(c[1] * k)), min(255, int(c[2] * k)), c[3])


def alpha(c: RGBA, a: int) -> RGBA:
    return (c[0], c[1], c[2], a)


class Sprite:
    def __init__(self, w: int, h: int):
        self.w, self.h = w, h
        self.px_: list[list[RGBA | None]] = [[None] * w for _ in range(h)]

    # ---- primitives (all coordinates inclusive, out-of-range pixels ignored)
    def px(self, x: int, y: int, c: RGBA | None) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px_[y][x] = c

    def get(self, x: int, y: int) -> RGBA | None:
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.px_[y][x]
        return None

    def rect(self, x0: int, y0: int, x1: int, y1: int, c: RGBA | None) -> None:
        for y in range(min(y0, y1), max(y0, y1) + 1):
            for x in range(min(x0, x1), max(x0, x1) + 1):
                self.px(x, y, c)

    def frame(self, x0: int, y0: int, x1: int, y1: int, c: RGBA) -> None:
        """Hollow rectangle."""
        self.hline(x0, x1, y0, c); self.hline(x0, x1, y1, c)
        self.vline(x0, y0, y1, c); self.vline(x1, y0, y1, c)

    def hline(self, x0: int, x1: int, y: int, c: RGBA | None) -> None:
        self.rect(x0, y, x1, y, c)

    def vline(self, x: int, y0: int, y1: int, c: RGBA | None) -> None:
        self.rect(x, y0, x, y1, c)

    def line(self, x0: int, y0: int, x1: int, y1: int, c: RGBA) -> None:
        n = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(n + 1):
            self.px(round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n), c)

    def disc(self, cx: float, cy: float, r: float, c: RGBA | None, r_in: float = -1) -> None:
        """Filled circle (or ring when r_in >= 0), centre in pixel units (use .5 for even sizes)."""
        for y in range(self.h):
            for x in range(self.w):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                if r_in < d <= r:
                    self.px(x, y, c)

    def dots(self, pts, c: RGBA | None) -> None:
        for x, y in pts:
            self.px(x, y, c)

    def blit(self, other: "Sprite", dx: int, dy: int) -> None:
        for y in range(other.h):
            for x in range(other.w):
                c = other.px_[y][x]
                if c is not None and c[3] > 0:
                    self.px(x + dx, y + dy, c)

    def flip(self) -> "Sprite":
        s = Sprite(self.w, self.h)
        for y in range(self.h):
            for x in range(self.w):
                s.px_[y][self.w - 1 - x] = self.px_[y][x]
        return s

    def outline(self, c: RGBA = OUTLINE) -> None:
        """Dark edge on every empty-or-glow pixel that touches a solid one (the house style).
        Translucent pixels (glows, glass) are not solid: they get no outline and can be outlined over."""
        edge = []
        for y in range(self.h):
            for x in range(self.w):
                here = self.px_[y][x]
                if here is not None and here[3] >= 200:
                    continue
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    n = self.get(nx, ny)
                    if n is not None and n[3] >= 200 and n != c:
                        edge.append((x, y))
                        break
        for x, y in edge:
            self.px_[y][x] = c

    def text(self, x: int, y: int, s: str, c: RGBA) -> int:
        """3x5 capitals; returns the width drawn."""
        for i, ch in enumerate(s.upper()):
            bits = FONT.get(ch, FONT[" "])
            for r in range(5):
                for k in range(3):
                    if bits[r * 3 + k] == "1":
                        self.px(x + i * 4 + k, y + r, c)
        return len(s) * 4 - 1

    def image(self) -> Image.Image:
        im = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        for y in range(self.h):
            for x in range(self.w):
                c = self.px_[y][x]
                if c is not None:
                    im.putpixel((x, y), c)
        return im


# 3x5 pixel font: each glyph is 5 rows of 3 bits
FONT = {
    "A": "010101111101101", "B": "110101110101110", "C": "011100100100011", "D": "110101101101110",
    "E": "111100110100111", "F": "111100110100100", "G": "011100101101011", "H": "101101111101101",
    "I": "111010010010111", "J": "001001001101010", "K": "101101110101101", "L": "100100100100111",
    "M": "101111111101101", "N": "110101101101101", "O": "010101101101010", "P": "110101110100100",
    "Q": "010101101110011", "R": "110101110101101", "S": "011100010001110", "T": "111010010010010",
    "U": "101101101101111", "V": "101101101101010", "W": "101101111111101", "X": "101101010101101",
    "Y": "101101010010010", "Z": "111001010100111", "&": "010101010101011", "-": "000000111000000",
    ".": "000000000000010", "!": "010010010000010", "1": "010110010010111", "2": "110001010100111",
    "3": "110001010001110", "4": "101101111001001", "5": "111100110001110", "6": "011100110101010",
    "7": "111001010010010", "8": "010101010101010", "9": "010101011001110", "0": "010101101101010",
    " ": "000000000000000",
}


def text_width(s: str) -> int:
    return len(s) * 4 - 1


def slug(text: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", text.upper()).strip("_")


# ---- manifest writing -------------------------------------------------------------------------------


def asset_manifest(asset_id: str, name: str, category: str, w: int, h: int, *, on_walls=False, on_surfaces=False,
                   background=0, orientation: str | None = None) -> dict:
    m = {
        "id": asset_id, "name": name, "category": category, "type": "asset", "file": f"{asset_id}.png",
        "width": w * TILE, "height": h * TILE, "footprintW": w, "footprintH": h,
        "canPlaceOnWalls": on_walls, "canPlaceOnSurfaces": on_surfaces, "backgroundTiles": background,
    }
    if orientation:
        m["orientation"] = orientation
    return m


def write_asset(root: Path, asset_id: str, name: str, category: str, sprite: Sprite, *, on_walls=False,
                on_surfaces=False, background=0, orientation: str | None = None) -> None:
    w, h = sprite.w // TILE, sprite.h // TILE
    assert sprite.w % TILE == 0 and sprite.h % TILE == 0, asset_id
    d = root / asset_id
    d.mkdir(parents=True, exist_ok=True)
    sprite.image().save(d / f"{asset_id}.png")
    (d / "manifest.json").write_text(json.dumps(asset_manifest(
        asset_id, name, category, w, h, on_walls=on_walls, on_surfaces=on_surfaces, background=background,
        orientation=orientation), indent=2))


def write_state_asset(root: Path, asset_id: str, name: str, category: str, off: Sprite, on_frames: list[Sprite], *,
                      on_surfaces=False, background=0) -> None:
    """An electronics item that switches to its animated ON sprites while a working agent faces it."""
    w, h = off.w // TILE, off.h // TILE
    d = root / asset_id
    d.mkdir(parents=True, exist_ok=True)
    off.image().save(d / f"{asset_id}_FRONT_OFF.png")
    members = []
    for i, f in enumerate(on_frames, 1):
        f.image().save(d / f"{asset_id}_FRONT_ON_{i}.png")
        members.append({"type": "asset", "id": f"{asset_id}_FRONT_ON_{i}", "file": f"{asset_id}_FRONT_ON_{i}.png",
                        "width": off.w, "height": off.h, "footprintW": w, "footprintH": h, "frame": i - 1})
    manifest = {
        "id": asset_id, "name": name, "category": category, "type": "group", "groupType": "rotation",
        "rotationScheme": "2-way", "canPlaceOnWalls": False, "canPlaceOnSurfaces": on_surfaces,
        "backgroundTiles": background,
        "members": [{
            "type": "group", "groupType": "state", "orientation": "front",
            "members": [
                {"type": "group", "groupType": "animation", "state": "on", "members": members},
                {"type": "asset", "id": f"{asset_id}_FRONT_OFF", "file": f"{asset_id}_FRONT_OFF.png",
                 "width": off.w, "height": off.h, "footprintW": w, "footprintH": h, "state": "off"},
            ],
        }],
    }
    (d / "manifest.json").write_text(json.dumps(manifest, indent=2))


def scaled(im: Image.Image, k: int) -> Image.Image:
    return im.resize((im.width * k, im.height * k), Image.NEAREST)
