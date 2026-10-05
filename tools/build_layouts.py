"""Generates Pixel Agents office layouts and checks them before they are imported.

Format (read from pixel-agents 1.4.1): tiles[] per cell = 255 void, 0 wall, 1-9 floor pattern; tileColors[] =
{h,s,b,c[,colorize]} or null; carpetTiles[] = {variant 0-2, order, color, accentColor} or null; furniture[] =
{uid,type,col,row[,color]}. Every non-background tile of a chair becomes a seat for an agent.

Run: python3 build_layouts.py  -> layouts/*.json (import them with apply.sh or Layout > Import in the UI)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

VOID, WALL = 255, 0
OUT = Path(__file__).parent / "layouts"

# footprint (w, h), background rows, kind: floor | surface (goes on a desk) | wall (bottom row on a wall tile) | chair | desk
CATALOG = {
    "BIN": (1, 1, 0, "floor"), "BOOKSHELF": (2, 1, 0, "wall"), "CACTUS": (1, 2, 1, "floor"),
    "CLOCK": (1, 2, 0, "wall"), "COFFEE": (1, 1, 0, "surface"), "COFFEE_TABLE": (2, 2, 0, "desk"),
    "CUSHIONED_BENCH": (1, 1, 0, "chair"), "CUSHIONED_CHAIR_FRONT": (1, 1, 0, "chair"),
    "CUSHIONED_CHAIR_BACK": (1, 1, 0, "chair"), "CUSHIONED_CHAIR_SIDE": (1, 1, 0, "chair"),
    "DESK_FRONT": (3, 2, 1, "desk"), "DESK_SIDE": (1, 4, 1, "desk"), "DOUBLE_BOOKSHELF": (2, 2, 0, "wall"),
    "HANGING_PLANT": (1, 2, 0, "wall"), "LARGE_PAINTING": (2, 2, 0, "wall"), "LARGE_PLANT": (2, 3, 2, "floor"),
    "PC_FRONT_OFF": (1, 2, 1, "surface"), "PC_SIDE": (1, 2, 1, "surface"), "PC_BACK": (1, 2, 1, "surface"),
    "PLANT": (1, 2, 1, "floor"), "PLANT_2": (1, 2, 1, "floor"), "POT": (1, 1, 0, "floor"),
    "SMALL_PAINTING": (1, 2, 0, "wall"), "SMALL_PAINTING_2": (1, 2, 0, "wall"),
    "SMALL_TABLE_FRONT": (2, 2, 1, "desk"), "SMALL_TABLE_SIDE": (1, 3, 1, "desk"),
    "SOFA_FRONT": (2, 1, 0, "chair"), "SOFA_BACK": (2, 1, 0, "chair"), "SOFA_SIDE": (1, 2, 0, "chair"),
    "TABLE_FRONT": (3, 4, 1, "desk"), "WHITEBOARD": (2, 2, 0, "wall"), "WOODEN_BENCH": (1, 1, 0, "chair"),
    "WOODEN_CHAIR_FRONT": (1, 2, 1, "chair"), "WOODEN_CHAIR_BACK": (1, 2, 1, "chair"),
    "WOODEN_CHAIR_SIDE": (1, 2, 1, "chair"),
}


# custom furniture from art-pack/ (room signs, your images): footprint read from each manifest
for _m in (Path(__file__).parent / "art-pack" / "assets" / "furniture").glob("*/manifest.json"):
    _d = json.loads(_m.read_text())
    CATALOG[_d["id"]] = (_d["footprintW"], _d["footprintH"], _d.get("backgroundTiles", 0),
                         "wall" if _d.get("canPlaceOnWalls") else "floor")


def tint(h: int, s: int, b: int, c: int = 0, colorize: bool = True) -> dict:
    return {"h": h, "s": s, "b": b, "c": c, **({"colorize": True} if colorize else {})}


class Office:
    def __init__(self, name: str, cols: int, rows: int, wall_color: dict):
        self.name, self.cols, self.rows = name, cols, rows
        self.tiles = [VOID] * (cols * rows)
        self.colors: list = [None] * (cols * rows)
        self.carpets: list = [None] * (cols * rows)
        self.furniture: list[dict] = []
        self.wall_color = wall_color
        self._order = 0
        self.areas: list[dict] = []
        self.area_tiles: list = [None] * (cols * rows)
        self.residents: list[dict] = []

    def _i(self, c: int, r: int) -> int:
        return r * self.cols + c

    def room(self, c0: int, r0: int, c1: int, r1: int, floor: int, color: dict, checker: tuple | None = None):
        """Walls on the border (shared walls are fine), floor inside. checker=(floor2, color2) alternates tiles."""
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                i = self._i(c, r)
                if r in (r0, r1) or c in (c0, c1):
                    if self.tiles[i] == VOID:
                        self.tiles[i], self.colors[i] = WALL, self.wall_color
                elif checker and (r + c) % 2:
                    self.tiles[i], self.colors[i] = checker
                else:
                    self.tiles[i], self.colors[i] = floor, color

    def floor(self, c0: int, r0: int, c1: int, r1: int, floor: int, color: dict):
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                self.tiles[self._i(c, r)], self.colors[self._i(c, r)] = floor, color

    def door(self, c: int, r: int, w: int = 1, h: int = 1, floor: int = 1, color: dict | None = None):
        for rr in range(r, r + h):
            for cc in range(c, c + w):
                self.tiles[self._i(cc, rr)], self.colors[self._i(cc, rr)] = floor, color or tint(0, 0, 0, 0, False)

    def carpet(self, c0: int, r0: int, c1: int, r1: int, variant: int, color: dict, accent: dict):
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                self._order += 1
                self.carpets[self._i(c, r)] = {"variant": variant, "order": self._order, "color": color, "accentColor": accent}

    def area(self, label: str, color: str, c0: int, r0: int, c1: int, r1: int, residents: tuple = ()):
        """Name the floor inside a room's walls (c0..c1 / r0..r1 are the wall coordinates) and seat its residents."""
        self.areas.append({"label": label, "color": color})
        for r in range(r0 + 1, r1):
            for c in range(c0 + 1, c1):
                if self.tiles[self._i(c, r)] not in (VOID, WALL):
                    self.area_tiles[self._i(c, r)] = label
        self.residents += [{"name": n, "area": label} for n in residents]

    def put(self, kind: str, c: int, r: int, color: dict | None = None):
        f = {"uid": f"f-{self.name}-{len(self.furniture)}", "type": kind, "col": c, "row": r}
        if color:
            f["color"] = color
        self.furniture.append(f)

    # ---- composite pieces

    def workstation(self, c: int, r: int, desk_color: dict | None = None, seat: str = "CUSHIONED_BENCH"):
        """Desk facing the viewer, PC on it, seat below: 3 wide x 3 tall from (c, r)."""
        self.put("DESK_FRONT", c, r, desk_color)
        self.put("PC_FRONT_OFF", c + 1, r)
        self.put(seat, c + 1, r + 2)

    def side_station(self, c: int, r: int, left: bool = False, desk_color: dict | None = None):
        """Side desk 1x4 at column c with PC; chair on its left (or right when left=True, facing left)."""
        sfx = ":left" if left else ""
        self.put("DESK_SIDE", c, r, desk_color)
        self.put("PC_SIDE" + sfx, c, r + 1)
        self.put("WOODEN_CHAIR_SIDE" + sfx, c + 1 if left else c - 1, r + 1)

    # ---- output + checks

    def base(self, t: str) -> str:
        return t.split(":")[0]

    def check(self) -> list[str]:
        errs, blocked, desk_cells = [], {}, set()
        for f in self.furniture:
            t = self.base(f["type"])
            if t not in CATALOG:
                errs.append(f"unknown type {t}")
                continue
            w, h, bg, kind = CATALOG[t]
            if kind == "desk":
                desk_cells |= {(f["col"] + x, f["row"] + y) for x in range(w) for y in range(h)}
        for f in self.furniture:
            t = self.base(f["type"])
            if t not in CATALOG:
                continue
            w, h, bg, kind = CATALOG[t]
            cells = [(f["col"] + x, f["row"] + y) for y in range(h) for x in range(w)]
            if any(not (0 <= c < self.cols and 0 <= r < self.rows) for c, r in cells):
                errs.append(f"{t}@{f['col']},{f['row']} out of bounds")
                continue
            tile = lambda c, r: self.tiles[self._i(c, r)]
            if kind == "wall":
                bottom = [(c, r) for c, r in cells if r == f["row"] + h - 1]
                if any(tile(c, r) != WALL for c, r in bottom):
                    errs.append(f"{t}@{f['col']},{f['row']} wall item not on a wall")
                continue
            if kind == "surface":
                if not all(cell in desk_cells for cell in cells):
                    errs.append(f"{t}@{f['col']},{f['row']} not on a desk")
                continue
            for y, (c, r) in enumerate(cells):
                if tile(c, r) in (VOID, WALL):
                    errs.append(f"{t}@{f['col']},{f['row']} on wall/void at {c},{r}")
                if (r - f["row"]) < bg:
                    continue
                if (c, r) in blocked:
                    errs.append(f"{t}@{f['col']},{f['row']} overlaps {blocked[(c, r)]} at {c},{r}")
                blocked[(c, r)] = t
        return errs

    def seats(self) -> int:
        n = 0
        for f in self.furniture:
            w, h, bg, kind = CATALOG[self.base(f["type"])]
            if kind == "chair":
                n += w * (h - bg)
        return n

    def to_json(self) -> dict:
        return {"version": 1, "cols": self.cols, "rows": self.rows, "layoutRevision": 1, "tiles": self.tiles,
                "tileColors": self.colors, "carpetTiles": self.carpets, "furniture": self.furniture,
                **({"areas": self.areas, "areaTiles": self.area_tiles} if self.areas else {}),
                **({"residents": self.residents} if self.residents else {}),
                "pets": [{"id": f"pet-{self.name}-0", "petType": 0}, {"id": f"pet-{self.name}-1", "petType": 1}]}


# ------------------------------------------------------------------------------------------------ layouts


def agent_hq() -> Office:
    """Symmetric HQ, 10 | 20 | 10 on both floors: Design | Manager | Research & Docs over QA | Development | Review.
    Every agent is a resident of its team's room (needs the residents patch)."""
    o = Office("agent-hq", 41, 30, tint(250, 30, -60, 10))
    wood, pink, ink, navy = tint(28, 55, -20), tint(300, 70, -35), tint(40, 35, -45), tint(225, 60, -50)
    teal, teal2, lime = tint(180, 75, -45), tint(190, 80, -60), tint(110, 55, -30)
    o.room(0, 1, 10, 13, 4, pink, (4, tint(320, 80, -50)))        # design
    o.room(10, 1, 30, 13, 2, wood)                                # manager (+ lounge)
    o.room(30, 1, 40, 13, 3, ink)                                 # research & docs
    o.room(0, 13, 10, 29, 7, lime)                                # QA
    o.room(10, 13, 30, 29, 5, teal, (5, teal2))                   # development
    o.room(30, 13, 40, 29, 6, navy)                               # review
    door = tint(0, 0, -30, 0, False)
    for c, r, w, h in [(10, 6, 1, 2), (30, 6, 1, 2), (10, 20, 1, 2), (30, 20, 1, 2),
                       (5, 13, 1, 1), (19, 13, 3, 1), (35, 13, 1, 1)]:
        o.door(c, r, w, h, 1, door)

    o.area("Design", "#ff9ff3", 0, 1, 10, 13, ("designer",))
    o.area("Manager", "#feca57", 10, 1, 30, 13, ("manager",))
    o.area("Research & Docs", "#ffa502", 30, 1, 40, 13, ("researcher", "pr-writer"))
    o.area("QA", "#1dd1a1", 0, 13, 10, 29, ("tester",))
    o.area("Development", "#48dbfb", 10, 13, 30, 29, ("coder", "debugger"))
    o.area("Review", "#54a0ff", 30, 13, 40, 29, ("reviewer",))

    for sign, c, r in [("SIGN_DESIGN_LAB", 4, 1), ("SIGN_MANAGER", 19, 1), ("SIGN_RESEARCH_DOCS", 33, 1),
                       ("SIGN_QA_LAB", 2, 13), ("SIGN_DEVELOPMENT", 23, 13), ("SIGN_REVIEW", 37, 13)]:
        if sign in CATALOG:
            o.put(sign, c, r)

    # design (mirror of research)
    o.put("WHITEBOARD", 1, 0); o.put("WHITEBOARD", 8, 0)
    o.workstation(4, 4, tint(300, 50, -10))
    o.carpet(2, 8, 8, 11, 1, tint(190, 90, -10), tint(300, 90, 10))
    o.put("COFFEE_TABLE", 4, 9); o.put("CUSHIONED_CHAIR_SIDE", 3, 9); o.put("CUSHIONED_CHAIR_SIDE:left", 6, 9)
    o.put("CACTUS", 1, 10); o.put("CACTUS", 9, 10)

    # manager: command desk on the axis, paintings either side, lounge below
    o.put("LARGE_PAINTING", 14, 0); o.put("LARGE_PAINTING", 25, 0); o.put("CLOCK", 12, 0); o.put("CLOCK", 28, 0)
    o.workstation(19, 4, tint(25, 60, -25))
    o.put("LARGE_PLANT", 11, 2); o.put("LARGE_PLANT", 28, 2)
    o.carpet(14, 8, 26, 12, 0, tint(0, 75, -30), tint(45, 80, 10))
    o.put("SOFA_FRONT", 19, 8); o.put("COFFEE_TABLE", 19, 9); o.put("COFFEE", 19, 9); o.put("SOFA_BACK", 19, 11)
    o.put("SOFA_SIDE", 18, 9); o.put("SOFA_SIDE:left", 21, 9)
    o.put("CUSHIONED_CHAIR_FRONT", 15, 9); o.put("CUSHIONED_CHAIR_FRONT", 24, 9)
    o.put("PLANT", 11, 10); o.put("PLANT", 29, 10)

    # research & docs: two reading desks under the shelves
    o.put("DOUBLE_BOOKSHELF", 31, 0); o.put("DOUBLE_BOOKSHELF", 38, 0)
    o.workstation(32, 4, tint(30, 40, -40)); o.workstation(36, 4, tint(30, 40, -40))
    o.carpet(32, 8, 38, 11, 2, tint(35, 60, -25), tint(10, 70, -10))
    o.put("SOFA_FRONT", 34, 9); o.put("COFFEE_TABLE", 34, 10)
    o.put("PLANT_2", 31, 10); o.put("PLANT_2", 39, 10)

    # QA (mirror of review)
    o.workstation(4, 15, tint(110, 50, -35))
    o.carpet(2, 20, 8, 25, 1, tint(110, 80, -25), tint(80, 90, 10))
    o.put("SMALL_TABLE_FRONT", 4, 21, tint(110, 50, -35)); o.put("COFFEE", 4, 21)
    o.put("CUSHIONED_BENCH", 4, 23); o.put("CUSHIONED_BENCH", 5, 23)
    o.put("PLANT", 1, 26); o.put("PLANT", 9, 26); o.put("CACTUS", 1, 15); o.put("CACTUS", 9, 15)

    # development: four desks split around the axis, war-room table in the middle
    for c in (11, 15, 23, 27):
        o.workstation(c, 15, tint(180, 60, -40))
    o.carpet(15, 20, 25, 26, 1, tint(175, 90, -30), tint(160, 100, 10))
    o.put("TABLE_FRONT", 19, 21, tint(180, 50, -45))
    o.put("PC_SIDE", 19, 22); o.put("PC_SIDE:left", 21, 22)
    o.put("WOODEN_CHAIR_SIDE", 18, 21); o.put("WOODEN_CHAIR_SIDE", 18, 23)
    o.put("WOODEN_CHAIR_SIDE:left", 22, 21); o.put("WOODEN_CHAIR_SIDE:left", 22, 23)
    for c in (11, 29):
        o.put("LARGE_PLANT" if c == 11 else "PLANT", c, 25 if c == 11 else 26)
    o.put("PLANT_2", 15, 27); o.put("PLANT_2", 25, 27); o.put("BIN", 11, 28); o.put("BIN", 29, 28)

    # review (mirror of QA)
    o.workstation(34, 15, tint(220, 60, -40))
    o.carpet(32, 20, 38, 25, 0, tint(220, 80, -35), tint(190, 90, 0))
    o.put("SMALL_TABLE_FRONT", 34, 21, tint(220, 60, -40)); o.put("COFFEE", 34, 21)
    o.put("CUSHIONED_BENCH", 34, 23); o.put("CUSHIONED_BENCH", 35, 23)
    o.put("PLANT", 31, 26); o.put("PLANT", 39, 26); o.put("CACTUS", 31, 15); o.put("CACTUS", 39, 15)
    return o


def neon_arcade() -> Office:
    """Dark open-plan floor with a magenta/cyan checkerboard, a ring of 8 desks around a glowing core."""
    o = Office("neon-arcade", 30, 24, tint(260, 60, -70, 20))
    o.room(0, 1, 29, 23, 5, tint(290, 90, -45), (5, tint(185, 90, -45)))
    o.carpet(11, 9, 18, 15, 1, tint(300, 100, -10), tint(185, 100, 10))     # glowing core
    o.put("TABLE_FRONT", 13, 10, tint(280, 80, -40))
    o.put("PC_SIDE", 13, 11); o.put("PC_SIDE:left", 15, 11)
    o.put("WOODEN_CHAIR_SIDE", 12, 10); o.put("WOODEN_CHAIR_SIDE", 12, 12)
    o.put("WOODEN_CHAIR_SIDE:left", 16, 10); o.put("WOODEN_CHAIR_SIDE:left", 16, 12)
    for c in (2, 7, 19, 24):                                               # top row of stations
        o.workstation(c, 3, tint(185, 80, -30))
    for c in (2, 7, 19, 24):                                               # bottom row
        o.workstation(c, 17, tint(300, 80, -30))
    for c in (1, 6, 11, 17, 22, 27):
        o.put("SMALL_PAINTING" if c % 2 else "SMALL_PAINTING_2", c, 0)
    o.put("WHITEBOARD", 13, 0); o.put("CLOCK", 16, 0)
    for c, r in [(1, 9), (28, 9), (1, 14), (28, 14)]:
        o.put("CACTUS", c, r)
    o.put("LARGE_PLANT", 1, 20); o.put("LARGE_PLANT", 27, 20)
    o.put("SOFA_FRONT", 13, 20); o.put("SOFA_FRONT", 15, 20)
    return o


def zen_garden() -> Office:
    """Calm green studio: wood paths, a carpet 'pond', plants everywhere, 6 desks under hanging plants."""
    o = Office("zen-garden", 32, 22, tint(120, 25, -55))
    o.room(0, 1, 31, 21, 7, tint(115, 45, -35), (7, tint(105, 50, -42)))
    o.floor(1, 10, 30, 11, 2, tint(30, 50, -15))                           # wooden walkway
    o.floor(15, 2, 16, 20, 2, tint(30, 50, -15))
    o.carpet(19, 13, 27, 18, 2, tint(195, 80, -20), tint(170, 70, 10))     # pond
    for c in range(2, 31, 3):
        o.put("HANGING_PLANT", c, 0)
    for c in (2, 7):
        o.workstation(c, 3, tint(30, 45, -20)); o.workstation(c, 13, tint(30, 45, -20))
    for c in (19, 24):
        o.workstation(c, 3, tint(30, 45, -20))
    o.put("LARGE_PLANT", 12, 2); o.put("LARGE_PLANT", 28, 6); o.put("LARGE_PLANT", 12, 15)
    for c, r in [(1, 8), (13, 8), (18, 8), (30, 8), (1, 18), (29, 19), (18, 19)]:
        o.put("PLANT" if (c + r) % 2 else "PLANT_2", c, r)
    o.put("SOFA_FRONT", 22, 13); o.put("WOODEN_BENCH", 20, 17); o.put("WOODEN_BENCH", 26, 17)
    o.put("POT", 21, 15); o.put("POT", 25, 15)
    return o


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    ok = True
    for build in (agent_hq, neon_arcade, zen_garden):
        o = build()
        errs = o.check()
        print(f"{o.name:12} {o.cols}x{o.rows}  {len(o.furniture)} items  {o.seats()} seats  {'OK' if not errs else 'ERRORS'}")
        for e in errs:
            print("   ", e)
        ok &= not errs
        (OUT / f"{o.name}.json").write_text(json.dumps(o.to_json()))
    sys.exit(0 if ok else 1)
