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


# custom furniture from art-pack/ and avengers-pack/ (signs, props): footprint read from each manifest.
# Group manifests (rotation/state/animation) are flattened to their leaf assets, which inherit the group's flags.
def _leaf_assets(node: dict, inherited: dict):
    flags = {k: node.get(k, inherited.get(k)) for k in ("category", "canPlaceOnWalls", "canPlaceOnSurfaces", "backgroundTiles")}
    if node.get("type") == "group":
        for m in node.get("members", []):
            yield from _leaf_assets(m, flags)
    else:
        yield {**flags, **node}


for _pack in ("art-pack", "avengers-pack"):
    for _m in (Path(__file__).parent / _pack / "assets" / "furniture").glob("*/manifest.json"):
        for _d in _leaf_assets(json.loads(_m.read_text()), {}):
            kind = ("wall" if _d.get("canPlaceOnWalls") else "surface" if _d.get("canPlaceOnSurfaces")
                    else {"desks": "desk", "chairs": "chair"}.get(_d.get("category"), "floor"))
            CATALOG[_d["id"]] = (_d["footprintW"], _d["footprintH"], _d.get("backgroundTiles") or 0, kind)


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
        self.theme: str | None = None
        self.agent_palettes: list[int] | None = None
        self.agent_area: str | None = None
        self.pets: list[int] = [0, 1]

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
        self.residents += [{"name": n, "area": label} if isinstance(n, str) else {**n, "area": label} for n in residents]

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
                    continue  # background rows: walkable, other furniture may sit there
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
                **({"theme": self.theme} if self.theme else {}),
                **({"agentPalettes": self.agent_palettes} if self.agent_palettes else {}),
                **({"agentArea": self.agent_area} if self.agent_area else {}),
                "pets": [{"id": f"pet-{self.name}-{i}", "petType": t} for i, t in enumerate(self.pets)]}


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


def helicarrier() -> Office:
    """The Avengers deck of the S.H.I.E.L.D. Helicarrier: Fury's Bridge in the centre, a hero room on every side,
    and a mission walking clockwise around him. Needs tools/avengers-pack (build it with tools/avengers/build_pack.py);
    the heroes are the pack's characters, appended after the 6 bundled skins (palette 6 + N)."""
    pal = json.loads((Path(__file__).parent / "avengers-pack" / "pack.json").read_text())["palettes"]
    o = Office("helicarrier", 49, 35, tint(220, 20, -55, 10))
    o.theme = "avengers"
    o.agent_palettes = [pal[f"agent{i}"] for i in range(6)]
    o.pets = [0]  # Goose
    o.agent_area = "Quinjet Bay"
    steel, walk = tint(212, 30, -72), tint(210, 32, -60)
    # rooms: walls on the shared borders. Row 0 is void so 2-tall wall items fit over the top wall.
    o.room(0, 1, 14, 12, 7, tint(195, 35, -74))                    # archive
    o.room(14, 1, 34, 12, 6, tint(22, 45, -70))                    # sanctum
    o.room(34, 1, 48, 12, 4, tint(220, 25, -76))                   # workshop
    o.room(0, 12, 14, 23, 1, tint(350, 45, -76))                   # red room
    o.room(14, 12, 34, 23, 4, steel)                               # bridge
    o.room(34, 12, 48, 23, 5, tint(95, 22, -70), (5, tint(95, 22, -75)))  # smash lab
    o.room(0, 23, 14, 34, 9, tint(220, 25, -78), (9, tint(220, 25, -72)))  # quinjet bay
    o.room(14, 23, 34, 34, 5, tint(40, 15, -66))                   # daily bugle
    o.room(34, 23, 48, 34, 3, tint(44, 55, -58))                   # hall of asgard
    o.floor(20, 16, 27, 21, 3, walk)                               # the bridge's walkway ring
    o.floor(2, 28, 12, 28, 1, tint(45, 80, -40))                   # landing stripe
    door = tint(0, 0, -30, 0, False)
    for c, r, w, h in [(23, 12, 2, 1), (23, 23, 2, 1), (14, 17, 1, 2), (34, 17, 1, 2),      # around the bridge
                       (14, 6, 1, 2), (34, 6, 1, 2), (7, 12, 1, 1), (41, 12, 1, 1),         # the ring
                       (7, 23, 1, 1), (41, 23, 1, 1), (14, 28, 1, 2), (34, 28, 1, 2)]:
        o.door(c, r, w, h, 1, door)

    def hero(name, label, key, aliases=()):
        return {"name": name, "label": label, "palette": pal[key], **({"aliases": list(aliases)} if aliases else {})}

    o.area("The Archive", "#4fb0a0", 0, 1, 14, 12, (hero("researcher", "Vision", "vision"),))
    o.area("Sanctum", "#e08a3c", 14, 1, 34, 12, (hero("architect", "Strange", "strange", ("designer",)),))
    o.area("Stark Workshop", "#8ea0c8", 34, 1, 48, 12, (hero("coder", "Stark", "ironman"),))
    o.area("Red Room", "#e05a6e", 0, 12, 14, 23, (hero("debugger", "Widow", "widow"),))
    o.area("The Bridge", "#5aa8e8", 14, 12, 34, 23, (hero("manager", "Fury", "fury"),))
    o.area("Smash Lab", "#8ccc64", 34, 12, 48, 23, (hero("tester", "Hulk", "hulk"),))
    o.area("Quinjet Bay", "#9aa6be", 0, 23, 14, 34)
    o.area("Daily Bugle", "#d8c8a8", 14, 23, 34, 34, (hero("pr-writer", "Spidey", "spidey"),))
    o.area("Hall of Asgard", "#e8c060", 34, 23, 48, 34, (hero("reviewer", "Thor", "thor"),))

    def station(c, r, desk="STEEL_DESK", seat="COMMAND_CHAIR", color=None, screen=None):
        """Desk facing the viewer, holo screen on it, seat below: 3 wide x 3 tall from (c, r)."""
        o.put(desk, c, r, color)
        o.put("HOLO_SCREEN_FRONT_OFF", c + 1, r, screen)
        o.put(seat, c + 1, r + 2, color)

    # archive (Vision): data wall, racks, a reading corner with the mind stone
    o.put("SIGN_THE_ARCHIVE", 5, 1); o.put("DATA_WALL", 1, 0); o.put("DOUBLE_BOOKSHELF", 11, 0)
    station(5, 3, screen=tint(45, 0, 0, 0, False))
    o.put("SERVER_RACK", 1, 3); o.put("SERVER_RACK", 2, 3); o.put("FLOATING_BOOKS", 12, 4)
    o.carpet(3, 7, 10, 10, 2, tint(45, 40, -58), tint(50, 70, -25))
    o.put("SMALL_TABLE_FRONT", 4, 8, tint(200, 20, -40)); o.put("MIND_STONE_CASE", 4, 8)
    o.put("SOFA_FRONT", 7, 8, tint(45, 60, -20)); o.put("BOOK_PILE", 12, 10); o.put("BOOK_PILE", 1, 10)

    # sanctum (Strange): round windows, mandala rug, candles, a spell circle
    o.put("SIGN_SANCTUM", 22, 1); o.put("SANCTUM_WINDOW", 17, 0); o.put("SANCTUM_WINDOW", 29, 0)
    station(23, 3, desk="DESK_FRONT", color=tint(20, 50, -30), screen=tint(-90, 0, 0, 0, False))
    o.put("CANDELABRA", 16, 3); o.put("CANDELABRA", 32, 3); o.put("AGAMOTTO_STAND", 18, 8)
    o.put("MANDALA_RUG", 22, 7); o.put("SPELL_CIRCLE", 28, 8)
    o.put("BOOK_PILE", 15, 10); o.put("BOOK_PILE", 33, 10); o.put("BOOK_PILE", 16, 10)

    # stark workshop (Iron Man): his desk, two spare benches, armour racks, the reactor
    o.put("SIGN_STARK_WORKSHOP", 38, 1); o.put("TOOL_WALL", 35, 0); o.put("DATA_WALL", 45, 0)
    station(40, 3, color=tint(0, 40, -10, 0, False)); o.put("IRON_HELMET", 42, 3)
    o.put("ARMOR_RACK", 36, 3); o.put("ARMOR_RACK", 45, 3)
    station(35, 7, color=tint(0, 40, -10, 0, False)); station(44, 7, color=tint(0, 40, -10, 0, False))
    o.put("ARC_REACTOR", 40, 7); o.put("WORKBENCH", 39, 10); o.put("ROBOT_ARM", 47, 10)

    # red room (Widow): evidence boards, spotlights, the interrogation table
    o.put("SIGN_RED_ROOM", 4, 12); o.put("EVIDENCE_BOARD", 1, 11); o.put("EVIDENCE_BOARD", 11, 11)
    station(5, 14, color=tint(350, 30, -20, 0, False), screen=tint(150, 0, 0, 0, False))
    o.put("SPOTLIGHT", 1, 14); o.put("SPOTLIGHT", 12, 14)
    o.put("INTERROGATION_TABLE", 5, 18); o.put("RED_LEDGER", 6, 18)
    o.put("WEAPON_CASE", 12, 19); o.put("CRATE", 1, 21)

    # the bridge (Fury): sky windows, mission screens, the eagle on the floor, holo tables
    o.put("SKY_WINDOW", 15, 11); o.put("BRIDGE_SCREEN", 18, 11); o.put("SIGN_THE_BRIDGE", 20, 12)
    o.put("CAP_SHIELD", 25, 11); o.put("BRIDGE_SCREEN", 27, 11); o.put("SKY_WINDOW", 30, 11)
    station(23, 14)
    o.put("SHIELD_EMBLEM", 22, 17)
    o.put("HOLO_TABLE", 16, 18); o.put("HOLO_TABLE", 29, 18)
    o.put("CRATE", 15, 21); o.put("CRATE", 33, 21); o.put("CRATE", 15, 13); o.put("CRATE", 33, 13)

    # smash lab (Hulk): dented panels, gamma tanks, cracked floor
    o.put("DENTED_PANEL", 35, 11); o.put("SIGN_SMASH_LAB", 38, 12); o.put("HAZARD_SIGN", 42, 12); o.put("DENTED_PANEL", 45, 11)
    station(40, 14, seat="LAB_STOOL", color=tint(100, 20, -20, 0, False), screen=tint(-80, 0, 0, 0, False))
    o.put("GAMMA_TANK", 35, 14); o.put("GAMMA_TANK", 47, 14)
    o.put("CRACKED_FLOOR", 37, 17); o.put("CRACKED_FLOOR", 42, 19); o.put("CRACKED_FLOOR", 39, 20)
    o.put("CRASH_DUMMY", 35, 19); o.put("PUNCH_BAG", 47, 19)

    # quinjet bay (field agents): the jet, hangar door, shawarma
    o.put("SIGN_QUINJET_BAY", 2, 23); o.put("HANGAR_DOOR", 8, 22); o.put("HAWKEYE_BOW", 1, 22)
    o.put("QUINJET", 4, 24)
    for c, r in [(2, 25), (11, 25), (2, 27), (11, 27)]:
        o.put("LANDING_LIGHT", c, r)
    o.put("SHAWARMA_COUNTER", 1, 29); o.put("SHAWARMA_TABLE", 7, 29)
    for c, r in [(6, 29), (6, 30), (9, 29), (9, 30), (7, 31), (8, 31)]:
        o.put("STEEL_BENCH", c, r)
    o.put("CRATE", 13, 24); o.put("CRATE", 13, 25); o.put("CRATE", 12, 24); o.put("CRATE", 1, 32)

    # daily bugle (Spider-Man): the desk with a typewriter, newsroom desks, camera, cobwebs
    o.put("SIGN_DAILY_BUGLE", 16, 23); o.put("SPIDEY_POSTER", 27, 22); o.put("WEB_CORNER", 15, 23); o.put("WEB_CORNER", 33, 23)
    station(23, 25, color=tint(0, 20, 0, 0, False), screen=tint(160, 0, 0, 0, False)); o.put("TYPEWRITER", 25, 25)
    o.put("NEWSPAPER_STACK", 16, 25); o.put("NEWSPAPER_STACK", 17, 25); o.put("NEWSPAPER_STACK", 16, 26)
    o.put("CAMERA_TRIPOD", 31, 25)
    o.carpet(19, 29, 28, 32, 1, tint(40, 10, -52), tint(0, 60, -20))
    o.put("DESK_FRONT", 16, 29, tint(30, 30, -20)); o.put("PC_FRONT_OFF", 17, 29)
    o.put("DESK_FRONT", 30, 29, tint(30, 30, -20)); o.put("PC_FRONT_OFF", 31, 29)
    o.put("NEWSPAPER_STACK", 32, 32); o.put("BIN", 15, 32)

    # hall of asgard (Thor): throne, pillars, braziers, Mjolnir on its pedestal
    o.put("SIGN_HALL_OF_ASGARD", 36, 23); o.put("GOLD_BANNER", 44, 22); o.put("GOLD_BANNER", 46, 22)
    o.put("STEEL_DESK", 40, 25, tint(45, 60, 10, 0, False)); o.put("HOLO_SCREEN_FRONT_OFF", 41, 25, tint(170, 0, 0, 0, False))
    o.put("THRONE", 41, 27)
    o.put("MJOLNIR_PEDESTAL", 36, 25); o.put("ASGARD_PILLAR", 35, 28); o.put("ASGARD_PILLAR", 47, 28)
    o.put("BRAZIER", 36, 31); o.put("BRAZIER", 46, 31); o.put("BIFROST_RUNE", 43, 30)
    return o


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    ok = True
    for build in (agent_hq, neon_arcade, zen_garden, helicarrier):
        o = build()
        errs = o.check()
        print(f"{o.name:12} {o.cols}x{o.rows}  {len(o.furniture)} items  {o.seats()} seats  {'OK' if not errs else 'ERRORS'}")
        for e in errs:
            print("   ", e)
        ok &= not errs
        (OUT / f"{o.name}.json").write_text(json.dumps(o.to_json()))
    sys.exit(0 if ok else 1)
