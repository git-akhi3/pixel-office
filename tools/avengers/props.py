"""Furniture for the Helicarrier: one drawing function per prop, registered with its catalog metadata.

Sizes are in tiles (16 px). Pixel Agents' rules, as read from apps/pixel/core/src/assets/manifestUtils.ts and
webview-ui/src/office/layout/layoutSerializer.ts:
  - category "desks" items are surfaces other items can sit on; "chairs" items give every non-background tile a seat;
  - "wall" items need their bottom row on a wall tile and are drawn in the wall band above it;
  - backgroundTiles = N makes the top N rows walkable (N = full height means a rug: floor decoration);
  - canPlaceOnSurfaces items go on desks.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from pix import OUTLINE, RGBA, Sprite, alpha, rgb, shade, text_width

# ---- palette
STEEL = rgb(96, 104, 124)
STEEL_D = shade(STEEL, 0.7)
STEEL_L = shade(STEEL, 1.35)
STEEL_XL = rgb(190, 198, 215)
HOLO = rgb(84, 200, 255)
HOLO_D = rgb(36, 110, 190)
HOLO_L = rgb(200, 240, 255)
GOLD = rgb(222, 178, 58)
GOLD_D = shade(GOLD, 0.7)
GOLD_L = rgb(250, 230, 150)
RED = rgb(190, 34, 44)
RED_D = shade(RED, 0.65)
WOOD = rgb(128, 82, 44)
WOOD_D = shade(WOOD, 0.7)
WOOD_L = shade(WOOD, 1.3)
BLACK = rgb(28, 28, 36)
GREY = rgb(70, 72, 86)
WHITE = rgb(240, 242, 248)
GREEN = rgb(80, 220, 110)
GREEN_D = rgb(30, 120, 60)
YELLOW = rgb(250, 210, 60)
ORANGE = rgb(255, 140, 40)
PURPLE = rgb(120, 70, 180)
SKY = rgb(120, 180, 240)
SKY_D = rgb(70, 130, 210)
CLOUD = rgb(245, 248, 255)
GLASS = alpha(rgb(200, 235, 255), 150)


@dataclass
class Prop:
    id: str
    name: str
    category: str
    draw: Callable[[], Sprite]
    on_walls: bool = False
    on_surfaces: bool = False
    background: int = 0
    orientation: str | None = None


PROPS: list[Prop] = []


def prop(id: str, name: str, category: str = "decor", **kw):
    def deco(fn):
        PROPS.append(Prop(id, name, category, fn, **kw))
        return fn
    return deco


def new(w: int, h: int) -> Sprite:
    return Sprite(w * 16, h * 16)


def slab(s: Sprite, x0, y0, x1, y1, top: RGBA, side: RGBA, depth: int = 3) -> None:
    """A box seen from the front-top: a top face and a darker front face."""
    s.rect(x0, y0, x1, y1 - depth, top)
    s.rect(x0, y1 - depth + 1, x1, y1, side)
    s.hline(x0 + 1, x1 - 1, y0, shade(top, 1.2))


def legs(s: Sprite, xs, y0, y1, c: RGBA) -> None:
    for x in xs:
        s.vline(x, y0, y1, c)


def glow(s: Sprite, cx, cy, r, c: RGBA, a: int = 70) -> None:
    """A translucent halo on the empty pixels around something bright; never over the thing itself."""
    import math
    for y in range(s.h):
        for x in range(s.w):
            if s.px_[y][x] is None and math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r:
                s.px(x, y, alpha(c, a))


# =============================================================== bridge =================================


@prop("STEEL_DESK", "Steel desk", "desks", background=1)
def steel_desk():
    s = new(3, 2)
    slab(s, 1, 14, 46, 24, STEEL, STEEL_D, 3)
    s.hline(2, 45, 23, HOLO_D)
    legs(s, (3, 4, 43, 44), 25, 30, STEEL_D)
    s.rect(5, 25, 42, 27, shade(STEEL_D, 0.8))
    s.outline()
    return s


@prop("HOLO_TABLE", "Holo table", "desks", background=1)
def holo_table():
    s = new(3, 2)
    slab(s, 2, 16, 45, 26, STEEL, STEEL_D, 3)
    s.rect(6, 17, 41, 22, shade(HOLO_D, 0.7))
    legs(s, (4, 5, 42, 43), 27, 30, STEEL_D)
    glow(s, 24, 12, 10, HOLO, 45)
    s.disc(24, 11, 5, alpha(HOLO, 170))
    s.disc(24, 11, 5, HOLO_L, 4)
    s.dots([(21, 9), (26, 13), (23, 12)], HOLO_L)
    for x in range(8, 40, 6):
        s.px(x, 19, HOLO)
    s.outline()
    return s


def _holo_screen(on: bool, frame: int = 0) -> Sprite:
    s = new(1, 2)
    s.rect(6, 27, 9, 30, STEEL_D)  # stand
    s.rect(7, 22, 8, 27, STEEL)
    s.rect(1, 8, 14, 21, STEEL_D if not on else HOLO_D)
    s.rect(2, 9, 13, 20, BLACK if not on else HOLO)
    if on:
        for i, y in enumerate(range(10, 20, 2)):
            c = HOLO_L if (i + frame) % 3 == 0 else shade(HOLO, 0.8)
            s.hline(3, 3 + 3 + ((i * 5 + frame * 3) % 7), y, c)
        s.px(12, 10, HOLO_L)
    else:
        s.px(12, 19, rgb(200, 40, 40))
    s.outline()
    return s


@prop("SHIELD_EMBLEM", "S.H.I.E.L.D. floor emblem", "decor", background=4)
def shield_emblem():
    s = new(4, 4)
    dark, light, mid = rgb(40, 44, 60), rgb(200, 205, 220), rgb(90, 96, 118)
    s.disc(32, 32, 30, dark)
    s.disc(32, 32, 30, mid, 27)
    s.disc(32, 32, 24, mid, 23)
    # eagle: head, body, two wings
    s.disc(32, 22, 4, light)
    s.rect(30, 24, 33, 40, light)
    for i in range(12):
        y = 26 + i
        s.hline(29 - i * 1 - (i // 2), y, 29 - i // 2, light)
        s.hline(34 + i // 2, 34 + i + i // 2, y, light)
    s.rect(28, 40, 35, 43, light); s.rect(26, 44, 37, 45, light)
    s.px(35, 21, dark)  # eye
    s.hline(36, 38, 22, GOLD)  # beak
    return s


@prop("SKY_WINDOW", "Sky window", "wall", on_walls=True)
def sky_window():
    s = new(3, 2)
    s.rect(1, 2, 46, 27, STEEL)
    s.rect(3, 4, 44, 25, SKY)
    s.rect(3, 4, 44, 10, SKY_D)
    for cx, cy, r in ((12, 14, 4), (17, 13, 3), (33, 19, 4), (38, 18, 3), (26, 9, 2)):
        s.disc(cx, cy, r, CLOUD)
        s.disc(cx + 1, cy + 1, r - 1, shade(CLOUD, 0.9))
    s.vline(23, 4, 25, STEEL); s.vline(24, 4, 25, STEEL)
    s.dots([(2, 3), (45, 3), (2, 26), (45, 26)], STEEL_L)
    s.outline()
    return s


@prop("BRIDGE_SCREEN", "Mission screen", "wall", on_walls=True)
def bridge_screen():
    s = new(2, 2)
    s.rect(1, 3, 30, 28, STEEL_D)
    s.rect(2, 4, 29, 27, BLACK)
    land = rgb(50, 130, 90)
    for x0, y0, x1, y1 in ((4, 7, 10, 13), (12, 6, 20, 12), (22, 8, 27, 14), (6, 16, 12, 22), (16, 15, 24, 24)):
        s.rect(x0, y0, x1, y1, land)
        s.dots([(x0, y0), (x1, y0), (x0, y1), (x1, y1)], BLACK)
    for x, y in ((8, 10), (17, 9), (24, 11), (9, 19), (20, 20)):
        s.px(x, y, rgb(255, 70, 70))
    for y in range(5, 27, 4):
        s.hline(2, 29, y, alpha(HOLO, 60))
    s.outline()
    return s


@prop("CAP_SHIELD", "Captain's shield", "wall", on_walls=True)
def cap_shield():
    s = new(1, 2)
    s.disc(8, 13, 7.5, RED)
    s.disc(8, 13, 5.5, WHITE)
    s.disc(8, 13, 3.5, RED)
    s.disc(8, 13, 2.5, rgb(40, 80, 180))
    s.dots([(7, 12), (8, 12), (7, 13), (8, 13), (6, 13), (9, 13), (7, 14), (8, 14)], WHITE)
    s.dots([(6, 13), (9, 13)], rgb(40, 80, 180))
    s.rect(7, 21, 8, 22, STEEL_D)  # hook
    s.outline()
    return s


@prop("COMMAND_CHAIR", "Command chair", "chairs")
def command_chair():
    s = new(1, 1)
    s.rect(2, 0, 13, 6, STEEL_D)
    s.rect(3, 1, 12, 5, GREY)
    s.rect(2, 7, 13, 12, STEEL)
    s.rect(3, 8, 12, 11, shade(GREY, 1.2))
    s.rect(3, 13, 4, 14, STEEL_D); s.rect(11, 13, 12, 14, STEEL_D)
    s.outline()
    return s


@prop("STEEL_BENCH", "Steel bench", "chairs")
def steel_bench():
    s = new(1, 1)
    s.rect(1, 5, 14, 10, STEEL)
    s.hline(2, 13, 5, STEEL_L)
    s.rect(1, 11, 14, 12, STEEL_D)
    s.rect(2, 13, 3, 14, STEEL_D); s.rect(12, 13, 13, 14, STEEL_D)
    s.outline()
    return s


# =============================================================== sanctum ================================


@prop("MANDALA_RUG", "Mandala rug", "decor", background=3)
def mandala_rug():
    s = new(3, 3)
    base, ring, line = rgb(140, 36, 40), rgb(200, 80, 50), GOLD
    s.rect(1, 1, 46, 46, base)
    s.disc(24, 24, 22, ring, 20)
    s.disc(24, 24, 15, line, 14)
    s.disc(24, 24, 9, ring, 7)
    s.disc(24, 24, 3, GOLD_L)
    for a in range(0, 360, 45):
        import math
        x, y = 24 + 12 * math.cos(math.radians(a)), 24 + 12 * math.sin(math.radians(a))
        s.disc(x, y, 2, line)
    s.frame(1, 1, 46, 46, GOLD_D)
    return s


@prop("SPELL_CIRCLE", "Spell circle", "decor", background=2)
def spell_circle():
    s = new(2, 2)
    s.disc(16, 16, 14, alpha(ORANGE, 60))
    s.disc(16, 16, 13.5, ORANGE, 12.3)
    s.disc(16, 16, 9.5, YELLOW, 8.6)
    for x, y in ((16, 4), (28, 16), (16, 28), (4, 16), (8, 8), (24, 8), (24, 24), (8, 24)):
        s.px(x, y, GOLD_L)
    s.line(8, 8, 24, 24, alpha(YELLOW, 160)); s.line(24, 8, 8, 24, alpha(YELLOW, 160))
    return s


@prop("AGAMOTTO_STAND", "Eye of Agamotto", "decor")
def agamotto_stand():
    s = new(1, 2)
    s.rect(5, 24, 10, 30, WOOD_D)
    s.rect(6, 18, 9, 23, WOOD)
    s.rect(3, 29, 12, 30, WOOD_D)
    s.disc(8, 12, 5.5, GOLD)
    s.disc(8, 12, 3.5, GOLD_D)
    s.disc(8, 12, 2.5, GREEN)
    s.px(7, 11, rgb(220, 255, 230))
    glow(s, 8, 12, 7, GREEN, 50)
    s.outline()
    return s


@prop("SANCTUM_WINDOW", "Sanctum window", "wall", on_walls=True)
def sanctum_window():
    s = new(2, 2)
    s.disc(16, 14, 13.5, WOOD_D)
    s.disc(16, 14, 11.5, rgb(30, 40, 70))
    s.disc(16, 14, 11.5, GOLD, 10.5)
    for cx, cy in ((16, 7), (10, 17), (22, 17)):
        s.disc(cx, cy, 4.5, GOLD, 3.5)
    s.disc(16, 14, 1.5, GOLD_L)
    s.rect(3, 27, 28, 29, WOOD)
    s.outline()
    return s


@prop("BOOK_PILE", "Pile of tomes", "decor")
def book_pile():
    s = new(1, 1)
    for i, (c, w) in enumerate(((rgb(90, 40, 110), 10), (rgb(40, 90, 110), 9), (rgb(150, 50, 40), 11), (rgb(60, 100, 50), 8))):
        y = 13 - i * 3
        x0 = 8 - w // 2 + (i % 2)
        s.rect(x0, y - 2, x0 + w - 1, y, c)
        s.hline(x0 + 1, x0 + w - 2, y - 2, shade(c, 1.3))
    s.outline()
    return s


@prop("CANDELABRA", "Candelabra", "decor")
def candelabra():
    s = new(1, 2)
    s.rect(7, 18, 8, 29, GOLD_D)
    s.rect(4, 29, 11, 30, GOLD_D)
    s.hline(3, 12, 17, GOLD)
    for x in (3, 7, 12):
        s.rect(x, 12, x, 16, WHITE)
        s.px(x, 10, YELLOW); s.px(x, 11, ORANGE)
        glow(s, x + 0.5, 10, 2.5, YELLOW, 70)
    s.outline()
    return s


# =============================================================== workshop ===============================


@prop("ARMOR_RACK", "Armor rack", "decor")
def armor_rack():
    import heroes
    s = new(1, 2)
    s.rect(2, 28, 13, 30, STEEL_D)
    s.rect(3, 27, 12, 27, STEEL)
    suit = heroes.body(next(h for h in heroes.hero_list() if h.key == "ironman"), heroes.DOWN, heroes.WALK2)
    s.blit(suit, 0, -3)
    s.rect(6, 1, 9, 2, STEEL_D)  # hanger bar
    glow(s, 8, 15, 8, HOLO, 35)
    s.outline()
    return s


@prop("ARC_REACTOR", "Arc reactor", "decor")
def arc_reactor():
    s = new(2, 2)
    s.rect(9, 24, 22, 30, STEEL_D)
    s.rect(11, 20, 20, 24, STEEL)
    s.disc(16, 12, 10.5, STEEL)
    s.disc(16, 12, 8.5, STEEL_D)
    s.disc(16, 12, 6.5, HOLO_D)
    s.disc(16, 12, 4.5, HOLO)
    s.disc(16, 12, 2, HOLO_L)
    for a in (0, 60, 120, 180, 240, 300):
        import math
        s.px(round(16 + 9 * math.cos(math.radians(a)) - 0.5), round(12 + 9 * math.sin(math.radians(a)) - 0.5), HOLO_L)
    glow(s, 16, 12, 14, HOLO, 50)
    s.outline()
    return s


@prop("TOOL_WALL", "Tool wall", "wall", on_walls=True)
def tool_wall():
    s = new(2, 2)
    s.rect(1, 3, 30, 27, rgb(110, 90, 60))
    for y in range(5, 27, 3):
        for x in range(3, 30, 3):
            s.px(x, y, rgb(80, 65, 45))
    s.rect(5, 6, 6, 18, STEEL_L); s.rect(4, 6, 7, 8, STEEL_L)  # wrench
    s.rect(11, 7, 12, 17, rgb(220, 60, 60)); s.rect(11, 18, 12, 22, STEEL_L)  # screwdriver
    s.rect(17, 6, 22, 9, STEEL_L); s.rect(19, 10, 20, 20, WOOD)  # hammer
    s.rect(25, 8, 27, 20, rgb(240, 200, 60)); s.rect(24, 8, 28, 10, shade(rgb(240, 200, 60), 0.7))  # drill
    s.outline()
    return s


@prop("ROBOT_ARM", "Dum-E", "decor")
def robot_arm():
    s = new(1, 2)
    y_ = rgb(230, 170, 40)
    s.rect(3, 26, 12, 30, STEEL_D)
    s.rect(6, 18, 9, 25, y_)
    s.rect(6, 10, 13, 13, y_)
    s.rect(11, 13, 13, 17, y_)
    s.rect(10, 6, 14, 9, shade(y_, 0.8))
    s.dots([(7, 12), (12, 14)], STEEL_D)
    s.px(12, 7, rgb(255, 80, 80))
    s.outline()
    return s


@prop("IRON_HELMET", "Iron helmet", "decor", on_surfaces=True)
def iron_helmet():
    s = new(1, 1)
    s.rect(4, 3, 11, 12, RED)
    s.rect(5, 5, 10, 11, GOLD)
    s.rect(6, 7, 6, 7, HOLO_L); s.rect(9, 7, 9, 7, HOLO_L)
    s.hline(7, 8, 10, GOLD_D)
    s.dots([(4, 3), (11, 3)], None)
    s.outline()
    return s


@prop("WORKBENCH", "Workbench", "desks", background=1)
def workbench():
    s = new(2, 2)
    slab(s, 1, 14, 30, 24, rgb(150, 110, 70), rgb(110, 80, 50), 3)
    legs(s, (3, 4, 27, 28), 25, 30, STEEL_D)
    s.rect(6, 16, 9, 18, STEEL_L); s.rect(14, 15, 15, 19, rgb(220, 60, 60)); s.rect(20, 17, 25, 18, GOLD)
    s.outline()
    return s


# =============================================================== smash lab ==============================


@prop("CRACKED_FLOOR", "Cracked floor", "decor", background=2)
def cracked_floor():
    s = new(2, 2)
    crack = alpha(rgb(20, 20, 30), 200)
    s.line(16, 16, 4, 6, crack); s.line(16, 16, 27, 8, crack); s.line(16, 16, 20, 29, crack)
    s.line(16, 16, 6, 24, crack); s.line(10, 11, 7, 14, crack); s.line(22, 12, 25, 16, crack)
    s.line(18, 23, 23, 25, crack)
    s.disc(16, 16, 2.5, alpha(rgb(20, 20, 30), 160))
    return s


@prop("CRASH_DUMMY", "Crash dummy", "decor")
def crash_dummy():
    s = new(1, 2)
    y_, k = rgb(235, 200, 60), BLACK
    s.rect(4, 28, 11, 30, STEEL_D)
    s.rect(7, 24, 8, 27, STEEL)
    s.rect(5, 15, 10, 23, y_)
    s.rect(5, 15, 7, 17, k); s.rect(8, 21, 10, 23, k)
    s.rect(3, 15, 4, 20, y_); s.rect(11, 15, 12, 20, y_)
    s.disc(8, 10, 3.5, y_)
    s.rect(7, 9, 8, 10, k); s.px(8, 9, y_); s.px(7, 10, y_)
    s.outline()
    return s


@prop("GAMMA_TANK", "Gamma tank", "decor")
def gamma_tank():
    s = new(1, 2)
    s.rect(3, 2, 12, 5, STEEL)
    s.rect(3, 26, 12, 30, STEEL)
    s.rect(4, 6, 11, 25, GREEN_D)
    s.rect(5, 7, 10, 24, GREEN)
    s.dots([(6, 10), (9, 14), (7, 19), (9, 22), (6, 23)], rgb(200, 255, 210))
    s.rect(4, 6, 4, 25, alpha(WHITE, 90))
    glow(s, 8, 16, 9, GREEN, 40)
    s.outline()
    return s


@prop("HAZARD_SIGN", "Hazard sign", "wall", on_walls=True)
def hazard_sign():
    s = new(1, 1)
    for i in range(7):
        s.hline(8 - i, 7 + i, 3 + i * 1 + i // 2, YELLOW)
    s.rect(1, 12, 14, 13, YELLOW)
    s.rect(2, 4, 13, 13, YELLOW)
    s.dots([(2, 4), (13, 4), (1, 12), (14, 12)], None)
    s.disc(8, 9, 1.2, BLACK)
    for x, y in ((5, 6), (10, 6), (8, 12), (5, 7), (10, 7), (7, 12), (8, 11)):
        s.px(x, y, BLACK)
    s.outline()
    return s


@prop("DENTED_PANEL", "Dented panel", "wall", on_walls=True)
def dented_panel():
    s = new(2, 2)
    s.rect(1, 2, 30, 29, STEEL)
    s.frame(1, 2, 30, 29, STEEL_D)
    s.dots([(3, 4), (28, 4), (3, 27), (28, 27)], STEEL_L)
    s.disc(16, 15, 7, STEEL_D)
    s.disc(16, 15, 5, shade(STEEL_D, 0.7))
    for x0, y0, x1, y1 in ((9, 8, 13, 12), (19, 7, 24, 11), (10, 19, 12, 23), (21, 20, 25, 23)):
        s.rect(x0, y0, x1, y1, shade(STEEL_D, 0.75))
    s.line(16, 8, 15, 3, BLACK); s.line(23, 15, 29, 14, BLACK); s.line(16, 22, 17, 28, BLACK); s.line(9, 15, 3, 17, BLACK)
    s.outline()
    return s


@prop("LAB_STOOL", "Lab stool", "chairs")
def lab_stool():
    s = new(1, 1)
    s.disc(8, 7, 5.5, STEEL)
    s.disc(8, 7, 4, GREY)
    s.rect(7, 12, 8, 14, STEEL_D)
    s.rect(4, 14, 11, 14, STEEL_D)
    s.outline()
    return s


@prop("PUNCH_BAG", "Heavy bag", "decor")
def punch_bag():
    s = new(1, 2)
    s.rect(2, 28, 13, 30, STEEL_D)
    s.rect(7, 2, 8, 29, STEEL)
    s.rect(3, 1, 12, 2, STEEL)
    s.rect(4, 6, 11, 24, RED)
    s.rect(4, 6, 11, 7, RED_D); s.rect(4, 23, 11, 24, RED_D)
    s.vline(5, 8, 22, shade(RED, 1.25))
    s.dots([(8, 14), (9, 15), (7, 15)], RED_D)
    s.outline()
    return s


# =============================================================== red room ===============================


@prop("EVIDENCE_BOARD", "Evidence board", "wall", on_walls=True)
def evidence_board():
    s = new(2, 2)
    s.rect(1, 2, 30, 27, rgb(170, 130, 80))
    s.frame(1, 2, 30, 27, rgb(110, 80, 50))
    pins = []
    for x0, y0, w, h in ((4, 5, 5, 6), (13, 6, 6, 5), (22, 4, 5, 6), (6, 15, 6, 6), (17, 16, 7, 6), (25, 15, 3, 7)):
        s.rect(x0, y0, x0 + w - 1, y0 + h - 1, WHITE)
        s.rect(x0 + 1, y0 + 1, x0 + w - 2, y0 + h - 3, rgb(150, 150, 170))
        pins.append((x0 + w // 2, y0))
    for i in range(len(pins) - 1):
        s.line(*pins[i], *pins[i + 1], rgb(230, 40, 40))
    s.line(pins[0][0], pins[0][1], pins[4][0], pins[4][1], rgb(230, 40, 40))
    for x, y in pins:
        s.px(x, y, rgb(255, 60, 60))
    s.outline()
    return s


@prop("INTERROGATION_TABLE", "Interrogation table", "desks", background=1)
def interrogation_table():
    s = new(2, 2)
    slab(s, 2, 15, 29, 25, STEEL, STEEL_D, 3)
    legs(s, (4, 27), 26, 30, STEEL_D)
    s.rect(14, 2, 17, 3, STEEL_D)  # lamp from above
    s.rect(12, 4, 19, 6, STEEL)
    s.rect(11, 7, 20, 7, YELLOW)
    s.rect(9, 8, 22, 14, alpha(YELLOW, 70))
    s.rect(6, 15, 25, 17, alpha(YELLOW, 50))
    s.outline()
    return s


@prop("RED_LEDGER", "Red ledger", "decor", on_surfaces=True)
def red_ledger():
    s = new(1, 1)
    s.rect(3, 4, 12, 12, RED)
    s.rect(4, 5, 11, 11, shade(RED, 1.15))
    s.vline(5, 4, 12, RED_D)
    s.rect(7, 7, 9, 9, BLACK)
    s.outline()
    return s


@prop("SPOTLIGHT", "Spotlight", "decor")
def spotlight():
    s = new(1, 2)
    s.rect(7, 12, 8, 28, STEEL_D)
    s.line(7, 28, 3, 30, STEEL_D); s.line(8, 28, 12, 30, STEEL_D)
    s.rect(3, 6, 12, 11, STEEL)
    s.rect(4, 7, 11, 10, YELLOW)
    s.rect(2, 12, 13, 12, alpha(YELLOW, 90))
    glow(s, 8, 9, 7, YELLOW, 45)
    s.outline()
    return s


@prop("WEAPON_CASE", "Weapon case", "decor")
def weapon_case():
    s = new(1, 2)
    s.rect(2, 20, 13, 29, BLACK)
    s.rect(3, 21, 12, 28, GREY)
    s.rect(2, 8, 13, 19, BLACK)
    s.rect(3, 9, 12, 18, shade(GREY, 1.15))
    s.rect(5, 11, 6, 17, STEEL_L); s.rect(9, 11, 10, 17, STEEL_L)  # batons
    s.rect(5, 23, 10, 26, rgb(60, 110, 220)); s.dots([(6, 24), (9, 25)], HOLO_L)  # widow bites
    s.outline()
    return s


# =============================================================== asgard =================================


@prop("THRONE", "Throne", "chairs", background=1, orientation="front")
def throne():
    s = new(1, 2)
    s.rect(2, 2, 13, 20, GOLD_D)
    s.rect(3, 3, 12, 19, GOLD)
    s.rect(4, 6, 11, 17, RED)
    s.dots([(2, 2), (13, 2)], None)
    s.px(7, 0, GOLD); s.px(8, 0, GOLD); s.rect(6, 1, 9, 1, GOLD)
    s.rect(2, 21, 13, 26, GOLD)
    s.rect(3, 22, 12, 25, RED)
    s.rect(2, 27, 3, 29, GOLD_D); s.rect(12, 27, 13, 29, GOLD_D)
    s.outline()
    return s


@prop("MJOLNIR_PEDESTAL", "Mjolnir", "decor")
def mjolnir_pedestal():
    s = new(1, 2)
    stone = rgb(120, 118, 130)
    s.rect(3, 20, 12, 30, stone)
    s.rect(2, 19, 13, 20, shade(stone, 1.2))
    s.rect(3, 29, 12, 30, shade(stone, 0.7))
    head = rgb(95, 100, 118)
    s.rect(4, 11, 11, 15, head)
    s.hline(5, 10, 11, shade(head, 1.5))
    s.rect(7, 16, 8, 19, WOOD)
    s.rect(7, 4, 8, 10, WOOD); s.px(7, 4, rgb(70, 50, 30))
    s.dots([(5, 13), (10, 13)], shade(head, 1.3))
    for x, y in ((2, 9), (13, 8), (1, 14), (14, 15)):
        s.px(x, y, alpha(HOLO_L, 200))
    s.outline()
    return s


@prop("ASGARD_PILLAR", "Asgard pillar", "decor")
def asgard_pillar():
    s = new(1, 3)
    s.rect(2, 2, 13, 5, GOLD)
    s.rect(4, 6, 11, 42, rgb(230, 225, 215))
    s.vline(5, 6, 42, WHITE); s.vline(10, 6, 42, rgb(190, 185, 175))
    s.rect(2, 43, 13, 46, GOLD)
    s.hline(3, 12, 3, GOLD_L); s.hline(3, 12, 44, GOLD_L)
    s.outline()
    return s


@prop("GOLD_BANNER", "Asgard banner", "wall", on_walls=True)
def gold_banner():
    s = new(1, 2)
    s.rect(2, 1, 13, 1, GOLD)
    s.rect(3, 2, 12, 24, RED)
    s.rect(3, 25, 7, 27, RED); s.rect(8, 25, 12, 27, RED); s.rect(5, 26, 10, 29, None)
    s.rect(3, 25, 5, 28, RED); s.rect(10, 25, 12, 28, RED)
    s.disc(8, 10, 4, GOLD, 2.8)
    s.rect(7, 6, 8, 16, GOLD)
    s.hline(5, 10, 16, GOLD)
    s.outline()
    return s


@prop("BIFROST_RUNE", "Bifrost rune", "decor", background=2)
def bifrost_rune():
    s = new(2, 2)
    colors = [rgb(255, 80, 80), rgb(255, 170, 60), rgb(250, 230, 80), rgb(90, 220, 120), rgb(80, 170, 255), rgb(170, 90, 230)]
    for i, c in enumerate(colors):
        s.disc(16, 16, 14 - i * 1.6, alpha(c, 150), 14 - (i + 1) * 1.6)
    s.disc(16, 16, 4, alpha(WHITE, 200))
    for x, y in ((16, 2), (30, 16), (16, 30), (2, 16)):
        s.px(x, y, WHITE)
    return s


@prop("BRAZIER", "Brazier", "decor")
def brazier():
    s = new(1, 2)
    s.rect(6, 22, 9, 28, GOLD_D)
    s.rect(3, 28, 12, 30, GOLD_D)
    s.rect(2, 16, 13, 21, GOLD)
    s.hline(3, 12, 16, GOLD_L)
    s.rect(4, 10, 11, 15, ORANGE)
    s.rect(5, 6, 10, 10, ORANGE); s.rect(6, 3, 9, 6, YELLOW); s.dots([(7, 1), (8, 2), (5, 11), (10, 12)], YELLOW)
    s.rect(6, 9, 9, 13, YELLOW)
    glow(s, 8, 9, 8, ORANGE, 50)
    s.outline()
    return s


# =============================================================== archive ================================


@prop("DATA_WALL", "Data wall", "wall", on_walls=True)
def data_wall():
    s = new(2, 2)
    s.rect(1, 2, 30, 29, STEEL_D)
    s.rect(2, 3, 29, 28, BLACK)
    import random
    rnd = random.Random(7)
    for y in range(5, 28, 2):
        x = 4
        while x < 27:
            w = rnd.randint(2, 6)
            s.hline(x, min(27, x + w), y, HOLO if rnd.random() < 0.7 else HOLO_L)
            x += w + 2
    s.rect(2, 3, 29, 3, HOLO_D)
    s.outline()
    return s


@prop("FLOATING_BOOKS", "Floating books", "decor")
def floating_books():
    s = new(1, 2)
    glow(s, 8, 18, 8, YELLOW, 35)
    for i, (c, x0, y) in enumerate(((rgb(60, 90, 150), 4, 24), (rgb(150, 60, 50), 6, 17), (rgb(60, 130, 80), 3, 10))):
        s.rect(x0, y, x0 + 7, y + 3, c)
        s.hline(x0 + 1, x0 + 6, y, shade(c, 1.3))
        s.rect(x0 + 1, y + 1, x0 + 6, y + 2, WHITE)
        s.px(x0 + 2, y + 1, c)
    s.dots([(12, 8), (3, 21), (13, 27)], YELLOW)
    s.outline()
    return s


@prop("MIND_STONE_CASE", "Mind stone", "decor", on_surfaces=True)
def mind_stone_case():
    s = new(1, 1)
    s.rect(3, 12, 12, 14, STEEL_D)
    s.rect(4, 4, 11, 11, GLASS)
    s.rect(6, 7, 9, 10, YELLOW)
    s.dots([(7, 6), (8, 6), (7, 11), (8, 11), (5, 8), (5, 9), (10, 8), (10, 9)], YELLOW)
    s.px(7, 7, WHITE)
    glow(s, 8, 8, 5, YELLOW, 60)
    s.outline()
    return s


@prop("SERVER_RACK", "Server rack", "decor")
def server_rack():
    s = new(1, 2)
    s.rect(2, 2, 13, 30, BLACK)
    s.rect(3, 3, 12, 29, GREY)
    for i, y in enumerate(range(4, 28, 4)):
        s.rect(4, y, 11, y + 2, shade(GREY, 0.7))
        s.px(10, y + 1, GREEN if i % 3 else rgb(255, 90, 90))
        s.px(8, y + 1, HOLO if i % 2 else shade(GREY, 0.5))
    s.outline()
    return s


# =============================================================== daily bugle ============================


@prop("NEWSPAPER_STACK", "Newspapers", "decor")
def newspaper_stack():
    s = new(1, 1)
    for i in range(4):
        y = 13 - i * 2
        s.rect(2 + (i % 2), y - 1, 12 + (i % 2), y, rgb(225, 222, 210))
        s.hline(4 + (i % 2), 10 + (i % 2), y - 1, rgb(120, 120, 120))
    s.rect(3, 5, 12, 6, rgb(235, 232, 220)); s.hline(4, 11, 5, BLACK)
    s.outline()
    return s


@prop("CAMERA_TRIPOD", "Camera", "decor")
def camera_tripod():
    s = new(1, 2)
    s.rect(7, 16, 8, 24, STEEL_D)
    s.line(7, 24, 3, 30, STEEL_D); s.line(8, 24, 12, 30, STEEL_D); s.rect(7, 25, 8, 30, STEEL_D)
    s.rect(3, 9, 12, 15, BLACK)
    s.rect(4, 10, 11, 14, GREY)
    s.disc(10, 12, 2, STEEL_L); s.px(10, 12, HOLO)
    s.rect(4, 7, 7, 8, BLACK); s.px(5, 6, WHITE)
    s.outline()
    return s


@prop("WEB_CORNER", "Cobweb", "wall", on_walls=True)
def web_corner():
    s = new(1, 1)
    w = alpha(WHITE, 200)
    for i in range(1, 5):
        s.line(0, 0, 15, i * 4 - 1, w)
    s.line(0, 0, 15, 15, w)
    for r in (5, 10, 14):
        s.disc(0, 0, r + 0.5, w, r - 0.5)
    return s


@prop("SPIDEY_POSTER", "Bugle poster", "wall", on_walls=True)
def spidey_poster():
    s = new(1, 2)
    s.rect(2, 2, 13, 26, rgb(235, 232, 220))
    s.rect(3, 3, 12, 6, RED)
    s.text(4, 8, "MEN", BLACK)
    s.text(4, 14, "ACE", BLACK)
    s.disc(8, 22, 2, BLACK)
    for x, y in ((5, 20), (11, 20), (5, 24), (11, 24), (4, 22), (12, 22)):
        s.line(8, 22, x, y, BLACK)
    s.outline()
    return s


@prop("TYPEWRITER", "Typewriter", "decor", on_surfaces=True)
def typewriter():
    s = new(1, 1)
    s.rect(3, 7, 12, 13, BLACK)
    s.rect(4, 8, 11, 12, GREY)
    s.rect(2, 3, 13, 6, rgb(235, 232, 220))
    s.hline(4, 11, 4, rgb(120, 120, 120))
    for x in range(5, 12, 2):
        s.px(x, 10, WHITE); s.px(x - 1, 12, WHITE)
    s.outline()
    return s


# =============================================================== quinjet bay ============================


@prop("QUINJET", "Quinjet", "decor")
def quinjet():
    s = new(6, 3)
    body, body_d, body_l = rgb(78, 84, 100), rgb(50, 54, 68), rgb(120, 128, 148)
    # wings
    s.rect(2, 24, 93, 33, body_d)
    s.rect(4, 25, 91, 31, body)
    s.hline(6, 89, 25, body_l)
    # engines at the wing tips
    for x0 in (4, 84):
        s.rect(x0, 20, x0 + 7, 36, body)
        s.rect(x0 + 1, 34, x0 + 6, 36, HOLO)
        s.rect(x0 + 2, 35, x0 + 5, 36, HOLO_L)
    # fuselage
    s.rect(38, 6, 57, 42, body)
    s.rect(40, 4, 55, 6, body); s.rect(42, 2, 53, 4, body)
    s.vline(39, 8, 40, body_l)
    s.rect(42, 8, 53, 16, HOLO_D)  # cockpit glass
    s.rect(43, 9, 52, 13, HOLO)
    s.rect(44, 10, 48, 11, HOLO_L)
    s.rect(36, 40, 59, 46, body_d)
    s.rect(40, 44, 55, 46, body_d)
    s.rect(45, 20, 50, 32, body_d)  # hatch
    s.rect(46, 21, 49, 31, body_l)
    # tail fins
    s.rect(30, 36, 37, 40, body); s.rect(58, 36, 65, 40, body)
    s.dots([(5, 21), (90, 21), (31, 37), (64, 37)], rgb(255, 90, 90))
    s.outline()
    return s


@prop("SHAWARMA_COUNTER", "Shawarma counter", "desks", background=1)
def shawarma_counter():
    s = new(3, 2)
    slab(s, 1, 14, 46, 26, rgb(200, 60, 60), rgb(150, 40, 40), 4)
    s.rect(1, 23, 46, 23, WHITE)
    legs(s, (2, 3, 44, 45), 27, 30, STEEL_D)
    # rotisserie
    s.rect(9, 1, 10, 14, STEEL_L)
    s.rect(5, 3, 14, 12, rgb(170, 110, 60))
    s.rect(6, 2, 13, 3, rgb(200, 140, 80)); s.rect(6, 12, 13, 13, rgb(140, 80, 40))
    s.dots([(7, 5), (11, 7), (8, 10), (12, 4)], rgb(220, 170, 100))
    s.rect(3, 12, 16, 13, STEEL)
    # plates with wraps
    for x0 in (22, 32):
        s.disc(x0 + 3.5, 17.5, 3.5, WHITE)
        s.rect(x0 + 1, 16, x0 + 6, 18, rgb(230, 190, 120))
        s.dots([(x0 + 2, 17), (x0 + 5, 17)], rgb(90, 160, 60))
    s.rect(40, 9, 44, 18, rgb(220, 60, 60)); s.rect(41, 7, 43, 9, WHITE)  # sauce bottle
    s.outline()
    return s


@prop("HAWKEYE_BOW", "Hawkeye's bow", "wall", on_walls=True)
def hawkeye_bow():
    s = new(1, 2)
    bow = rgb(120, 70, 190)
    s.line(4, 2, 4, 26, alpha(WHITE, 160))  # string
    for y in range(2, 27):
        x = 4 + round(5 * (1 - abs((y - 14) / 12) ** 1.5))
        s.px(x, y, bow)
    s.rect(8, 12, 10, 16, shade(bow, 0.7))
    s.rect(12, 6, 13, 24, rgb(150, 110, 60))  # quiver
    s.dots([(12, 4), (13, 5), (12, 5)], rgb(240, 240, 250))
    s.outline()
    return s


@prop("LANDING_LIGHT", "Landing light", "decor", background=1)
def landing_light():
    s = new(1, 1)
    s.disc(8, 8, 3.5, STEEL_D)
    s.disc(8, 8, 2.5, YELLOW)
    s.px(7, 7, WHITE)
    glow(s, 8, 8, 6, YELLOW, 50)
    return s


@prop("HANGAR_DOOR", "Hangar door", "wall", on_walls=True)
def hangar_door():
    s = new(4, 2)
    s.rect(1, 1, 62, 29, STEEL_D)
    s.rect(2, 2, 61, 28, STEEL)
    s.vline(31, 2, 28, STEEL_D); s.vline(32, 2, 28, STEEL_D)
    for y in range(4, 28, 6):
        s.hline(3, 60, y, shade(STEEL, 1.15))
    for x in range(3, 61, 6):
        for dy in range(3):
            s.hline(x + dy, min(60, x + dy + 2), 25 + dy, YELLOW if (x // 6) % 2 == 0 else BLACK)
    s.rect(26, 10, 37, 16, BLACK); s.text(28, 11, "01", YELLOW)
    s.outline()
    return s


@prop("CRATE", "Supply crate", "decor")
def crate():
    s = new(1, 1)
    s.rect(1, 3, 14, 14, STEEL)
    s.frame(1, 3, 14, 14, STEEL_D)
    s.hline(2, 13, 4, STEEL_L)
    s.disc(7.5, 9, 3, STEEL_XL, 2.2)
    s.rect(6, 8, 9, 10, STEEL_XL)
    s.outline()
    return s


@prop("SHAWARMA_TABLE", "Shawarma table", "desks", background=1)
def shawarma_table():
    s = new(2, 2)
    slab(s, 2, 15, 29, 25, rgb(230, 225, 210), rgb(190, 180, 160), 3)
    s.rect(4, 16, 27, 17, rgb(220, 70, 70))
    legs(s, (4, 27), 26, 30, STEEL_D)
    s.outline()
    return s


# =============================================================== signs ==================================

SIGNS = {
    "THE BRIDGE": ((28, 32, 50), (120, 200, 255)),
    "SANCTUM": ((60, 18, 30), (255, 150, 60)),
    "STARK WORKSHOP": ((70, 20, 20), (255, 200, 70)),
    "SMASH LAB": ((20, 50, 20), (150, 255, 110)),
    "RED ROOM": ((60, 10, 20), (255, 90, 110)),
    "HALL OF ASGARD": ((60, 45, 10), (255, 220, 120)),
    "THE ARCHIVE": ((40, 20, 50), (255, 230, 90)),
    "DAILY BUGLE": ((50, 10, 10), (255, 240, 220)),
    "QUINJET BAY": ((30, 32, 40), (255, 210, 60)),
    "SHAWARMA": ((80, 30, 20), (255, 230, 120)),
}


def sign(text: str, plate: tuple, accent: tuple) -> Sprite:
    import math
    tw = text_width(text)
    tiles_w = max(2, math.ceil((tw + 6) / 16))
    s = Sprite(tiles_w * 16, 16)
    w = s.w
    s.rect(0, 3, w - 1, 12, rgb(*accent))
    s.rect(1, 4, w - 2, 11, rgb(*plate))
    s.dots([(2, 5), (w - 3, 5), (2, 10), (w - 3, 10)], rgb(*accent))
    s.text((w - tw) // 2, 5, text, rgb(255, 255, 255))
    return s
