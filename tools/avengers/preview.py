"""Contact sheets of the pack at 6x, for eyeballing: python preview.py heroes|props <out.png>"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from heroes import hero_list, sheet  # noqa: E402
from pix import scaled  # noqa: E402

BG = (44, 46, 66, 255)


def heroes_sheet(out: str, k: int = 6) -> None:
    hs = hero_list()
    im = Image.new("RGBA", ((112 + 4) * k * 2, (96 + 4) * k * ((len(hs) + 1) // 2)), BG)
    for i, h in enumerate(hs):
        im.alpha_composite(scaled(sheet(h).image(), k), ((i % 2) * (112 + 4) * k, (i // 2) * (96 + 4) * k))
    im.save(out)


def props_sheet(out: str, root: Path, k: int = 4) -> None:
    pngs = sorted(p for p in root.glob("furniture/*/*.png"))
    cols, x, y, row_h = 7, 0, 0, 0
    tiles: list[tuple[Image.Image, int, int]] = []
    for p in pngs:
        im = Image.open(p).convert("RGBA")
        if x + im.width * k > cols * 64 * k:
            x, y, row_h = 0, y + row_h + 8, 0
        tiles.append((scaled(im, k), x, y))
        x += im.width * k + 8
        row_h = max(row_h, im.height * k)
    sheet_im = Image.new("RGBA", (cols * 64 * k, y + row_h + 8), BG)
    for im, tx, ty in tiles:
        sheet_im.alpha_composite(im, (tx, ty))
    sheet_im.save(out)


if __name__ == "__main__":
    kind, out = sys.argv[1], sys.argv[2]
    if kind == "heroes":
        heroes_sheet(out)
    else:
        props_sheet(out, Path(__file__).parent.parent / "avengers-pack" / "assets")
