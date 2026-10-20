"""The Avengers as 16x32 Pixel Agents characters: 7 frames (walk 1-3, type 1-2, read 1-2) x 3 rows (down, up,
right) per sheet, in the exact layout of apps/pixel's bundled char_N.png files. Left is flipped at runtime.

Every hero is built from one body template (head, torso, two arms, two legs) plus a few recognisable details:
Fury's eye patch and coat, Strange's cloak and goatee, Stark's faceplate and reactor, Hulk's bulk, Widow's hair
and belt, Thor's hammer and cape, Vision's stone and cape, Spider-Man's mask. The field agents are the same
template in a black suit, white shirt, tie and sunglasses, in six skin tones. Fan art, drawn from scratch."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from pix import OUTLINE, RGBA, Sprite, rgb, shade

DOWN, UP, RIGHT = "down", "up", "right"
WALK1, WALK2, WALK3, TYPE1, TYPE2, READ1, READ2 = range(7)
FRAMES = [WALK1, WALK2, WALK3, TYPE1, TYPE2, READ1, READ2]
DIRS = [DOWN, UP, RIGHT]

EYE_DARK = rgb(38, 28, 48)
WHITE = rgb(245, 245, 250)
TABLET = rgb(58, 60, 78)
TABLET_SCREEN = rgb(190, 225, 245)

Hook = Callable[[Sprite, str, int], None]


@dataclass
class Hero:
    key: str
    name: str
    skin: RGBA
    torso: RGBA
    pants: RGBA
    boots: RGBA
    hair: RGBA | None = None
    hair_style: str = "short"  # short | long | bald | spiky | iron | spidey | vision | hulk
    arm: RGBA | None = None  # sleeves; defaults to torso
    hand: RGBA | None = None  # gloves; defaults to skin
    cape: RGBA | None = None
    collar: bool = False
    big: bool = False
    pre: Hook | None = None  # drawn before the body (behind it)
    post: Hook | None = None  # drawn after the body (in front)
    face: Hook | None = None  # extra face details in the down view
    role: str | None = None  # office role this hero plays (None for field agents)
    portrait_crop: tuple[int, int, int, int] = (0, 0, 16, 16)

    def sleeve(self) -> RGBA:
        if self.arm is None or self.arm == self.torso:
            return shade(self.torso, 0.84)
        return self.arm

    def glove(self) -> RGBA:
        return self.hand or self.skin


# ---- the body template -------------------------------------------------------------------------------


def body(h: Hero, d: str, f: int) -> Sprite:
    s = Sprite(16, 32)
    if h.pre:
        h.pre(s, d, f)
    if d == DOWN:
        _down(s, h, f)
    elif d == UP:
        _up(s, h, f)
    else:
        _right(s, h, f)
    if h.post:
        h.post(s, d, f)
    g = _geom(h)
    hx0 = g["hx0"] + (1 if d == RIGHT else 0)
    top = g["hy0"] - (0 if h.hair_style in ("bald", "iron", "vision") or not h.hair else 1)
    _round(s, hx0, top, g["hx1"], 13)
    if h.hair_style in ("hulk", "spiky"):
        _round(s, hx0, top - 1, g["hx1"], 13)
    s.outline(OUTLINE)
    return s


def _legs_front(s: Sprite, h: Hero, f: int, lx: int, rx: int, w: int) -> None:
    """Two legs seen from the front or back; the lifted one in walk frames ends a row higher."""
    for x0, lifted in ((lx, f == WALK1), (rx, f == WALK3)):
        top, bottom = 23, 27 - (1 if lifted else 0)
        s.rect(x0, top, x0 + w - 1, bottom, h.pants)
        s.rect(x0, bottom + 1, x0 + w - 1, bottom + 2, h.boots)


def _down(s: Sprite, h: Hero, f: int) -> None:
    g = _geom(h)
    # legs, torso, neck
    _legs_front(s, h, f, g["ll"], g["rl"], g["lw"])
    s.rect(g["bx0"], 15, g["bx1"], 22, h.torso)
    s.rect(g["hx0"] + 4, 14, g["hx1"] - 4, 14, h.skin)
    # arms
    ax = (g["bx0"] - g["aw"], g["bx1"] + 1)
    if f in (TYPE1, TYPE2):
        dy = 0 if f == TYPE1 else 1
        for x0 in ax:
            s.rect(x0, 15, x0 + g["aw"] - 1, 18 + dy, h.sleeve())
        s.rect(ax[0], 19 + dy, g["bx0"] + 1, 20 + dy, h.sleeve())
        s.rect(g["bx1"] - 1, 19 + dy, ax[1] + g["aw"] - 1, 20 + dy, h.sleeve())
        s.rect(g["bx0"], 19 + dy, g["bx0"] + 1, 20 + dy, h.glove())
        s.rect(g["bx1"] - 1, 19 + dy, g["bx1"], 20 + dy, h.glove())
    elif f in (READ1, READ2):
        dy = 0 if f == READ1 else -1
        for x0 in ax:
            s.rect(x0, 15, x0 + g["aw"] - 1, 20, h.sleeve())
            s.rect(x0, 21 + dy, x0 + g["aw"] - 1, 22 + dy, h.glove())
        s.rect(g["bx0"], 18 + dy, g["bx1"], 22 + dy, TABLET)
        s.rect(g["bx0"] + 1, 19 + dy, g["bx1"] - 1, 21 + dy, TABLET_SCREEN)
    else:
        swing = {WALK1: (-1, 0), WALK3: (0, -1)}.get(f, (0, 0))
        for x0, dy in zip(ax, swing):
            s.rect(x0, 15, x0 + g["aw"] - 1, 20 + dy, h.sleeve())
            s.rect(x0, 21 + dy, x0 + g["aw"] - 1, 22 + dy, h.glove())
    _head_down(s, h, g)


def _up(s: Sprite, h: Hero, f: int) -> None:
    g = _geom(h)
    _legs_front(s, h, f, g["ll"], g["rl"], g["lw"])
    s.rect(g["bx0"], 15, g["bx1"], 22, shade(h.torso, 0.92))
    s.rect(g["hx0"] + 4, 14, g["hx1"] - 4, 14, h.skin)
    ax = (g["bx0"] - g["aw"], g["bx1"] + 1)
    raised = 1 if f in (TYPE1, READ1) else 2 if f in (TYPE2, READ2) else 0
    for x0 in ax:
        s.rect(x0, 15, x0 + g["aw"] - 1, 20 - raised, h.sleeve())
        if raised == 0:
            s.rect(x0, 21, x0 + g["aw"] - 1, 22, h.glove())
    if h.cape:
        s.rect(g["bx0"] - g["aw"] + 1, 15, g["bx1"] + g["aw"] - 1, 27, h.cape)
        s.vline(7, 16, 27, shade(h.cape, 0.8))
        s.vline(8, 16, 27, shade(h.cape, 0.8))
        if h.collar:
            s.rect(g["hx0"] + 2, 13, g["hx1"] - 2, 14, h.cape)
    _head_up(s, h, g)


def _right(s: Sprite, h: Hero, f: int) -> None:
    g = _geom(h)
    bx0, bx1 = g["bx0"] + 1, g["bx1"]  # the profile torso is one column narrower
    if h.cape:
        s.rect(bx0 - 3, 15, bx0 - 1, 27, h.cape)
        s.vline(bx0 - 2, 16, 27, shade(h.cape, 0.85))
    # legs
    lw = g["lw"]
    if f == WALK1:
        s.rect(bx0, 23, bx0 + lw - 1, 27, h.pants); s.rect(bx0, 28, bx0 + lw - 1, 29, h.boots)
        s.rect(bx1 - lw + 1, 23, bx1, 26, h.pants); s.rect(bx1 - lw + 1, 27, bx1, 28, h.boots)
    elif f == WALK3:
        s.rect(bx0 + 1, 23, bx0 + lw, 26, h.pants); s.rect(bx0 + 1, 27, bx0 + lw, 28, h.boots)
        s.rect(bx1 - lw, 23, bx1 - 1, 27, h.pants); s.rect(bx1 - lw, 28, bx1 - 1, 29, h.boots)
    else:
        s.rect(bx0 + 1, 23, bx1 - 1, 27, h.pants)
        s.rect(bx0 + 1, 28, bx1 - 1, 29, h.boots)
        s.vline((bx0 + bx1) // 2 + 1, 23, 27, shade(h.pants, 0.75))
    # torso
    s.rect(bx0, 15, bx1, 22, h.torso)
    s.rect(g["hx0"] + 5, 14, g["hx1"] - 3, 14, h.skin)
    # the near arm: hangs, swings, types forward, or holds a tablet
    aw = g["aw"]
    if f in (TYPE1, TYPE2):
        dy = 0 if f == TYPE1 else 1
        s.rect(bx1 - aw, 15, bx1, 17 + dy, h.sleeve())
        s.rect(bx1 - 1, 18 + dy, bx1 + 2, 19 + dy, h.sleeve())
        s.rect(bx1 + 3, 18 + dy, bx1 + 4, 19 + dy, h.glove())
    elif f in (READ1, READ2):
        dy = 0 if f == READ1 else -1
        s.rect(bx1 - aw, 15, bx1, 19, h.sleeve())
        s.rect(bx1 + 1, 16 + dy, bx1 + 3, 21 + dy, TABLET)
        s.rect(bx1 + 2, 17 + dy, bx1 + 2, 20 + dy, TABLET_SCREEN)
        s.rect(bx1, 20 + dy, bx1 + 1, 21 + dy, h.glove())
    else:
        dx = {WALK1: 2, WALK3: -2}.get(f, 0)
        s.rect(bx1 - aw, 15, bx1, 17, h.sleeve())
        s.rect(bx1 - aw + dx, 18, bx1 + dx, 20, h.sleeve())
        s.rect(bx1 - aw + dx, 21, bx1 + dx, 22, h.glove())
    _head_right(s, h, g)


def _geom(h: Hero) -> dict:
    if h.big:
        return dict(hx0=1, hx1=14, hy0=2, bx0=4, bx1=11, aw=2, ll=4, rl=9, lw=3)
    return dict(hx0=2, hx1=13, hy0=3, bx0=5, bx1=10, aw=2, ll=5, rl=9, lw=2)


# ---- heads -------------------------------------------------------------------------------------------


def _round(s: Sprite, x0: int, y0: int, x1: int, y1: int) -> None:
    """Knock out the four corners so the outline rounds the head."""
    s.dots([(x0, y0), (x1, y0), (x0, y1), (x1, y1)], None)


def _head_down(s: Sprite, h: Hero, g: dict) -> None:
    x0, x1, y0 = g["hx0"], g["hx1"], g["hy0"]
    s.rect(x0, y0, x1, 13, h.skin)
    cx = (x0 + x1) // 2  # 7 for both geometries
    ex = (cx - 3, cx + 2)  # left pixel of each eye
    if h.hair_style == "iron":
        red, gold, slit = h.torso, h.sleeve(), rgb(190, 235, 255)
        s.rect(x0, y0, x1, 13, red)
        s.rect(x0 + 2, y0 + 4, x1 - 2, 13, gold)
        s.hline(x0 + 3, x1 - 3, y0 + 3, gold)
        for e in ex:
            s.rect(e, 9, e + 1, 9, slit)
        s.hline(cx, cx + 1, 12, shade(gold, 0.6))
        return
    if h.hair_style == "spidey":
        red = h.torso
        s.rect(x0, y0, x1, 13, red)
        web = shade(red, 0.65)
        for y in range(y0, 14):
            for x in range(x0, x1 + 1):
                if (x + y) % 3 == 0:
                    s.px(x, y, web)
        for e in ex:
            s.rect(e - 1, 7, e + 2, 10, EYE_DARK)
            s.rect(e, 8, e + 1, 9, WHITE)
            s.px(e + (1 if e < cx else 0), 10, WHITE)
        return
    if h.hair_style == "cap":
        blue = h.torso
        s.rect(x0, y0, x1, 10, blue)  # the cowl, down to just under the eyes; chin and mouth stay bare
        s.hline(cx, cx + 1, y0 + 1, WHITE)  # the A
        s.dots([(cx - 1, y0 + 2), (cx + 2, y0 + 2)], WHITE)
        s.hline(cx - 1, cx + 2, y0 + 3, WHITE)
        s.dots([(cx - 1, y0 + 4), (cx + 2, y0 + 4)], WHITE)
        s.dots([(x0, y0 + 3), (x0 + 1, y0 + 3), (x1 - 1, y0 + 3), (x1, y0 + 3)], WHITE)  # wings
        for e in ex:
            s.px(e, 8, WHITE); s.px(e + 1, 8, EYE_DARK); s.rect(e, 9, e + 1, 9, EYE_DARK)
        s.hline(cx, cx + 1, 12, shade(h.skin, 0.72))  # mouth
        return
    if h.hair_style == "vision":
        s.rect(x0, y0, x1, 13, h.skin)
        ridge = shade(h.skin, 0.72)
        s.vline(x0 + 2, y0, 10, ridge); s.vline(x1 - 2, y0, 10, ridge)
        s.hline(x0 + 3, x1 - 3, y0, ridge)
        s.rect(cx, y0 + 2, cx + 1, y0 + 3, rgb(255, 225, 70))
        s.px(cx, y0 + 2, rgb(255, 250, 200))
        for e in ex:
            s.rect(e, 8, e + 1, 9, rgb(215, 240, 255))
            s.px(e + 1, 9, EYE_DARK)
        return
    if h.hair_style == "hulk":
        s.rect(x0, y0 - 1, x1, y0 + 2, h.hair)
        s.dots([(x0 + 2, y0 - 2), (x0 + 6, y0 - 2), (x1 - 2, y0 - 2)], h.hair)
        s.vline(x0, y0 + 3, y0 + 5, h.hair); s.vline(x1, y0 + 3, y0 + 5, h.hair)
        for e in ex:
            s.hline(e - 1, e + 2, 7, h.hair)  # heavy brow
        s.hline(cx - 1, cx + 2, 12, shade(h.skin, 0.55))  # grimace
    elif h.hair_style in ("short", "long", "spiky") and h.hair:
        s.rect(x0 + 1, y0 - 1, x1 - 1, y0 - 1, h.hair)
        s.rect(x0, y0, x1, y0 + 2, h.hair)
        s.vline(x0, y0 + 3, y0 + 4, h.hair); s.vline(x1, y0 + 3, y0 + 4, h.hair)
        s.hline(x0 + 2, x0 + 4, y0, shade(h.hair, 1.25))
        if h.hair_style == "spiky":
            s.dots([(x0 + 2, y0 - 2), (x0 + 6, y0 - 2), (x1 - 2, y0 - 2)], h.hair)
        if h.hair_style == "long":
            s.rect(x0, y0 + 3, x0 + 1, 16, h.hair); s.rect(x1 - 1, y0 + 3, x1, 16, h.hair)
    # eyes
    for e in ex:
        s.px(e, 8, WHITE); s.px(e + 1, 8, EYE_DARK); s.rect(e, 9, e + 1, 9, EYE_DARK)
    if h.face:
        h.face(s, DOWN, 0)


def _head_up(s: Sprite, h: Hero, g: dict) -> None:
    x0, x1, y0 = g["hx0"], g["hx1"], g["hy0"]
    if h.hair_style == "iron":
        s.rect(x0, y0, x1, 13, h.torso)
        s.vline((x0 + x1) // 2, y0 + 1, 12, shade(h.torso, 0.7)); s.vline((x0 + x1) // 2 + 1, y0 + 1, 12, shade(h.torso, 0.7))
        return
    if h.hair_style == "spidey":
        s.rect(x0, y0, x1, 13, h.torso)
        web = shade(h.torso, 0.65)
        for y in range(y0, 14):
            for x in range(x0, x1 + 1):
                if (x + y) % 3 == 0:
                    s.px(x, y, web)
        return
    if h.hair_style == "vision":
        s.rect(x0, y0, x1, 13, h.skin)
        ridge = shade(h.skin, 0.72)
        s.vline(x0 + 2, y0, 10, ridge); s.vline(x1 - 2, y0, 10, ridge); s.hline(x0 + 3, x1 - 3, y0, ridge)
        return
    if h.hair_style == "cap":
        s.rect(x0, y0, x1, 13, h.torso)
        seam = shade(h.torso, 0.78)
        s.vline((x0 + x1) // 2, y0 + 1, 12, seam); s.vline((x0 + x1) // 2 + 1, y0 + 1, 12, seam)
        s.dots([(x0, y0 + 3), (x0 + 1, y0 + 3), (x1 - 1, y0 + 3), (x1, y0 + 3)], WHITE)
        return
    s.rect(x0, y0, x1, 13, h.skin)
    if h.hair_style == "bald" or not h.hair:
        s.hline(x0 + 3, x0 + 5, y0 + 1, shade(h.skin, 1.2))
        return
    if h.hair_style == "hulk":
        s.rect(x0, y0 - 1, x1, y0 + 5, h.hair)
        s.dots([(x0 + 2, y0 - 2), (x0 + 6, y0 - 2), (x1 - 2, y0 - 2)], h.hair)
        return
    bottom = 17 if h.hair_style == "long" else 13
    s.rect(x0 + 1, y0 - 1, x1 - 1, y0 - 1, h.hair)
    s.rect(x0, y0, x1, bottom, h.hair)
    s.hline(x0 + 2, x0 + 4, y0, shade(h.hair, 1.25))
    if h.hair_style == "spiky":
        s.dots([(x0 + 2, y0 - 2), (x0 + 6, y0 - 2), (x1 - 2, y0 - 2)], h.hair)


def _head_right(s: Sprite, h: Hero, g: dict) -> None:
    x0, x1, y0 = g["hx0"] + 1, g["hx1"], g["hy0"]
    face = x1 - 5  # first face column
    if h.hair_style == "iron":
        red, gold, slit = h.torso, h.sleeve(), rgb(190, 235, 255)
        s.rect(x0, y0, x1, 13, red)
        s.rect(face + 1, y0 + 4, x1, 13, gold)
        s.rect(x1 - 2, 9, x1 - 1, 9, slit)
        return
    if h.hair_style == "spidey":
        s.rect(x0, y0, x1, 13, h.torso)
        web = shade(h.torso, 0.65)
        for y in range(y0, 14):
            for x in range(x0, x1 + 1):
                if (x + y) % 3 == 0:
                    s.px(x, y, web)
        s.rect(x1 - 4, 7, x1 - 1, 10, EYE_DARK)
        s.rect(x1 - 3, 8, x1 - 2, 9, WHITE); s.px(x1 - 2, 10, WHITE)
        return
    s.rect(x0, y0, x1, 13, h.skin)
    s.px(x1 + 1, 10, h.skin)  # nose
    if h.hair_style == "cap":
        s.rect(x0, y0, x1, 10, h.torso)  # cowl over the top of the head
        s.rect(x0, 11, face - 1, 13, h.torso)  # and round the back
        s.dots([(face - 1, y0 + 3), (face, y0 + 3)], WHITE)  # wing
        s.px(x1 - 2, 8, WHITE); s.px(x1 - 2, 9, EYE_DARK)
        return
    if h.hair_style == "vision":
        ridge = shade(h.skin, 0.72)
        s.vline(face, y0, 10, ridge); s.hline(x0 + 1, face - 1, y0, ridge)
        s.rect(x1 - 1, y0 + 2, x1, y0 + 3, rgb(255, 225, 70))
    elif h.hair_style == "hulk":
        s.rect(x0, y0 - 1, x1 - 2, y0 + 2, h.hair)
        s.rect(x0, y0 + 3, face - 1, y0 + 6, h.hair)
        s.dots([(x0 + 2, y0 - 2), (x0 + 6, y0 - 2)], h.hair)
        s.hline(x1 - 3, x1, 7, h.hair)
        s.hline(x1 - 2, x1, 12, shade(h.skin, 0.55))
    elif h.hair and h.hair_style != "bald":
        s.rect(x0 + 1, y0 - 1, x1 - 2, y0 - 1, h.hair)
        s.rect(x0, y0, x1 - 1, y0 + 2, h.hair)
        s.rect(x0, y0 + 3, face - 1, 16 if h.hair_style == "long" else y0 + 6, h.hair)
        s.hline(x0 + 2, x0 + 4, y0, shade(h.hair, 1.25))
        if h.hair_style == "spiky":
            s.dots([(x0 + 2, y0 - 2), (x0 + 6, y0 - 2)], h.hair)
    if h.hair_style not in ("vision",):
        s.px(x1 - 2, 8, WHITE); s.px(x1 - 2, 9, EYE_DARK)
    else:
        s.px(x1 - 2, 8, rgb(215, 240, 255)); s.px(x1 - 2, 9, EYE_DARK)
    if h.face:
        h.face(s, RIGHT, 0)


# ---- hero details -------------------------------------------------------------------------------------


def fury_face(s: Sprite, d: str, f: int) -> None:
    patch, grey = rgb(18, 18, 24), rgb(175, 175, 180)
    if d == DOWN:
        s.rect(9, 8, 10, 9, patch)  # eye patch over his left eye
        s.hline(3, 12, 7, patch)  # strap
        s.px(13, 8, patch)
        s.rect(7, 12, 8, 13, grey)  # goatee
    else:
        s.rect(11, 8, 12, 9, patch); s.hline(4, 13, 7, patch)
        s.rect(12, 12, 13, 13, grey)


def fury_post(s: Sprite, d: str, f: int) -> None:
    coat, lapel, shirt = rgb(34, 34, 40), rgb(70, 70, 82), rgb(120, 120, 130)
    if d == DOWN:
        s.rect(5, 23, 6, 26, coat); s.rect(9, 23, 10, 26, coat)  # the coat hangs over the legs
        s.rect(6, 15, 6, 19, lapel); s.rect(9, 15, 9, 19, lapel)
        s.rect(7, 15, 8, 18, shirt)
    elif d == UP:
        s.rect(5, 23, 10, 26, coat)
        s.vline(7, 16, 26, shade(coat, 0.75))
    else:
        s.rect(7, 23, 9, 26, coat)


def strange_face(s: Sprite, d: str, f: int) -> None:
    grey, black = rgb(165, 165, 175), rgb(28, 28, 34)
    if d == DOWN:
        s.rect(2, 5, 3, 6, grey); s.rect(12, 5, 13, 6, grey)  # grey temples
        s.rect(7, 12, 8, 13, black)  # goatee
        s.hline(6, 9, 11, black)  # moustache
    else:
        s.rect(4, 5, 5, 6, grey); s.rect(12, 12, 13, 13, black)


def strange_post(s: Sprite, d: str, f: int) -> None:
    gold, eye = rgb(215, 175, 60), rgb(90, 220, 130)
    if d == DOWN:
        s.hline(5, 10, 21, gold)  # sash
        s.rect(7, 16, 8, 17, eye)  # Eye of Agamotto
        s.frame(6, 15, 9, 18, gold)
        s.rect(7, 16, 8, 17, eye)
        s.rect(2, 15, 2, 26, rgb(170, 30, 40)); s.rect(13, 15, 13, 26, rgb(170, 30, 40))  # cloak edges
        s.rect(3, 13, 4, 14, rgb(170, 30, 40)); s.rect(11, 13, 12, 14, rgb(170, 30, 40))  # high collar
    elif d == RIGHT:
        s.hline(6, 10, 21, gold)
        s.rect(5, 13, 6, 14, rgb(170, 30, 40))


def iron_post(s: Sprite, d: str, f: int) -> None:
    gold, core, glow = rgb(225, 175, 55), rgb(235, 250, 255), rgb(120, 215, 255)
    if d == DOWN:
        s.rect(7, 17, 8, 18, glow); s.px(7, 17, core)  # arc reactor
        s.hline(5, 10, 22, gold)
        s.hline(5, 6, 25, gold); s.hline(9, 10, 25, gold)  # knee plates
    elif d == UP:
        s.rect(6, 16, 9, 19, shade(rgb(190, 30, 40), 0.8))
        s.hline(5, 10, 22, gold)
    else:
        s.hline(6, 10, 22, gold); s.hline(7, 9, 25, gold)


def hulk_post(s: Sprite, d: str, f: int) -> None:
    dark = shade(rgb(92, 172, 72), 0.68)
    torn = rgb(110, 60, 160)
    if d == DOWN:
        s.dots([(5, 17), (6, 17), (9, 17), (10, 17)], dark)  # pecs
        s.dots([(7, 19), (8, 19), (7, 21), (8, 21)], dark)  # abs
        s.hline(4, 11, 23, torn)  # waistband joins the two legs
        for x in (4, 6, 9, 11):  # torn hems
            s.px(x, 27, rgb(92, 172, 72))
    elif d == UP:
        s.vline(7, 16, 22, dark); s.hline(4, 11, 23, torn)
    else:
        s.vline(9, 17, 21, dark)


def widow_post(s: Sprite, d: str, f: int) -> None:
    belt, buckle, bite = rgb(190, 190, 200), rgb(215, 45, 45), rgb(80, 150, 235)
    if d == DOWN:
        s.hline(5, 10, 21, belt); s.rect(7, 21, 8, 21, buckle)
        s.vline(7, 15, 20, shade(rgb(32, 32, 40), 1.8)); s.vline(8, 15, 20, shade(rgb(32, 32, 40), 1.8))  # zip
        if f in (TYPE1, TYPE2):
            dy = 0 if f == TYPE1 else 1
            s.rect(3, 18 + dy, 4, 18 + dy, bite); s.rect(11, 18 + dy, 12, 18 + dy, bite)
        elif f not in (READ1, READ2):
            s.rect(3, 20, 4, 20, bite); s.rect(11, 20, 12, 20, bite)
    elif d == UP:
        s.hline(5, 10, 21, belt)
    else:
        s.hline(6, 10, 21, belt)


def thor_face(s: Sprite, d: str, f: int) -> None:
    beard = rgb(215, 175, 80)
    if d == DOWN:
        s.rect(4, 12, 11, 13, beard); s.rect(7, 12, 8, 12, shade(beard, 0.5))
        s.rect(4, 11, 4, 11, beard); s.rect(11, 11, 11, 11, beard)
    else:
        s.rect(10, 12, 13, 13, beard)


def thor_post(s: Sprite, d: str, f: int) -> None:
    disc, black = rgb(220, 225, 235), rgb(40, 40, 52)
    handle, head, strap = rgb(110, 72, 40), rgb(95, 100, 118), rgb(70, 50, 30)
    if d == DOWN:
        s.dots([(5, 16), (8, 16), (5, 19), (8, 19), (10, 16), (10, 19)], disc)
        s.hline(5, 10, 22, black)
        if f not in (TYPE1, TYPE2, READ1, READ2):
            s.rect(12, 18, 14, 19, head); s.px(12, 18, shade(head, 1.5))  # Mjolnir in the right hand
            s.vline(13, 20, 24, handle); s.px(13, 24, strap)
    elif d == UP:
        s.rect(2, 18, 4, 19, head); s.vline(3, 20, 24, handle)
    else:
        if f not in (TYPE1, TYPE2, READ1, READ2):
            dx = {WALK1: 2, WALK3: -2}.get(f, 0)
            s.rect(10 + dx, 17, 12 + dx, 18, head); s.px(10 + dx, 17, shade(head, 1.5)); s.vline(11 + dx, 19, 23, handle)


def vision_post(s: Sprite, d: str, f: int) -> None:
    gold = rgb(240, 200, 60)
    if d == DOWN:
        s.rect(5, 15, 10, 15, gold); s.hline(5, 10, 21, gold)
        s.rect(3, 15, 4, 16, gold); s.rect(11, 15, 12, 16, gold)
        s.rect(2, 15, 2, 26, gold); s.rect(13, 15, 13, 26, gold)
        s.px(7, 18, shade(rgb(40, 130, 80), 0.75)); s.px(8, 18, shade(rgb(40, 130, 80), 0.75))
    elif d == UP:
        pass
    else:
        s.hline(6, 10, 15, gold); s.hline(6, 10, 21, gold)


def spidey_post(s: Sprite, d: str, f: int) -> None:
    red, blue, black = rgb(200, 30, 40), rgb(40, 70, 165), rgb(20, 20, 26)
    web = shade(red, 0.65)
    if d == DOWN:
        for y in range(15, 23):
            for x in range(5, 11):
                if (x + y) % 3 == 0:
                    s.px(x, y, web)
        s.rect(7, 16, 8, 18, black); s.dots([(6, 16), (9, 16), (6, 18), (9, 18)], black)  # spider
        s.rect(5, 19, 5, 22, blue); s.rect(10, 19, 10, 22, blue)  # blue sides
        s.rect(3, 19, 4, 20, blue); s.rect(11, 19, 12, 20, blue)  # forearms
    elif d == UP:
        s.rect(7, 16, 8, 19, black); s.dots([(6, 17), (9, 17), (6, 18), (9, 18)], black)
        s.rect(5, 19, 5, 22, blue); s.rect(10, 19, 10, 22, blue)
    else:
        for y in range(15, 23):
            for x in range(6, 11):
                if (x + y) % 3 == 0:
                    s.px(x, y, web)
        s.rect(6, 19, 6, 22, blue)


def loki_post(s: Sprite, d: str, f: int) -> None:
    gold, gold_l = rgb(222, 178, 58), rgb(250, 230, 150)
    if d == DOWN or d == UP:
        s.hline(3, 12, 3, gold)  # the helmet's brow band
        s.hline(4, 6, 3, gold_l)
        s.dots([(3, 1), (2, 0), (12, 1), (13, 0)], gold)  # horns
        s.dots([(3, 2), (12, 2)], gold)
    else:
        s.hline(4, 12, 3, gold)
        s.dots([(5, 1), (4, 0), (11, 1), (12, 0), (5, 2), (11, 2)], gold)
    if d == DOWN:
        s.vline(6, 15, 21, gold); s.vline(9, 15, 21, gold)  # tunic straps
        s.hline(5, 10, 22, gold)
    elif d == RIGHT:
        s.vline(8, 15, 21, gold); s.hline(6, 10, 22, gold)


def buster_post(s: Sprite, d: str, f: int) -> None:
    """Hulkbuster: the big geometry in Stark's red and gold, with pauldrons, a chest plate and a reactor."""
    gold, red = rgb(225, 175, 55), rgb(190, 30, 40)
    glow, core, seam = rgb(120, 215, 255), rgb(235, 250, 255), shade(red, 0.7)
    if d == DOWN:
        s.rect(1, 14, 4, 16, gold); s.rect(11, 14, 14, 16, gold)  # pauldrons over the shoulders
        s.rect(1, 10, 2, 13, gold); s.rect(13, 10, 14, 13, gold)  # jaw plates
        s.rect(6, 16, 9, 19, shade(gold, 0.9))  # chest plate
        s.rect(7, 17, 8, 18, glow); s.px(7, 17, core)  # arc reactor
        s.vline(5, 16, 21, seam); s.vline(10, 16, 21, seam)
        s.hline(4, 11, 22, gold)  # belt
        s.rect(4, 24, 6, 25, gold); s.rect(9, 24, 11, 25, gold)  # knee plates
    elif d == UP:
        s.rect(1, 14, 4, 16, gold); s.rect(11, 14, 14, 16, gold)
        s.rect(6, 17, 9, 19, rgb(70, 70, 82)); s.dots([(6, 18), (9, 18)], glow)  # back thrusters
        s.hline(4, 11, 22, gold)
        s.rect(4, 24, 6, 25, gold); s.rect(9, 24, 11, 25, gold)
    else:
        s.rect(8, 14, 12, 16, gold)  # the near pauldron
        s.hline(5, 11, 22, gold); s.hline(6, 10, 25, gold)
        s.vline(9, 16, 21, seam)


def _shield(s: Sprite, cx: float, cy: float, r: float) -> None:
    """The round shield: red, white, red rings round a blue centre with a white star."""
    red, blue = rgb(200, 30, 40), rgb(40, 70, 165)
    s.disc(cx, cy, r, red)
    s.disc(cx, cy, r - 1, WHITE)
    s.disc(cx, cy, r - 2, red)
    s.disc(cx, cy, r - 3, blue)
    s.px(int(cx), int(cy), WHITE)


def cap_pre(s: Sprite, d: str, f: int) -> None:
    """Drawn behind the body: the shield on his back (seated or in profile)."""
    if d == DOWN and f in (TYPE1, TYPE2, READ1, READ2):
        _shield(s, 7.5, 19.0, 4.6)
    elif d == RIGHT:
        _shield(s, 4.5, 18.5, 3.6)


def cap_post(s: Sprite, d: str, f: int) -> None:
    red, white, belt = rgb(200, 30, 40), WHITE, rgb(110, 70, 40)
    if d == DOWN:
        s.dots([(7, 16), (8, 16), (7, 18), (8, 18)], white); s.hline(6, 9, 17, white)  # the star
        s.hline(5, 10, 20, white); s.hline(5, 10, 21, red)  # stripes
        s.hline(5, 10, 22, belt)
        if f in (WALK1, WALK2, WALK3):
            _shield(s, 3.5, 19.5, 3.5)  # on the left arm while walking
    elif d == UP:
        _shield(s, 7.5, 18.5, 4.2)  # slung on his back
        s.hline(5, 10, 22, belt)
    else:
        s.hline(6, 10, 20, white); s.hline(6, 10, 21, red)
        s.hline(6, 10, 22, belt)


def agent_post(s: Sprite, d: str, f: int) -> None:
    shirt, tie, shades, wire = rgb(238, 238, 244), rgb(28, 28, 34), rgb(16, 16, 20), rgb(220, 220, 230)
    if d == DOWN:
        s.rect(6, 15, 9, 16, shirt); s.rect(7, 17, 8, 19, shirt)
        s.rect(7, 15, 8, 20, tie); s.px(7, 15, shirt); s.px(8, 15, shirt)
        s.rect(4, 8, 6, 9, shades); s.rect(9, 8, 11, 9, shades); s.hline(7, 8, 8, shades)
        s.px(13, 9, wire); s.px(13, 10, wire)  # earpiece
    elif d == RIGHT:
        s.rect(10, 8, 13, 9, shades); s.px(8, 10, wire)


def hero_list() -> list[Hero]:
    cloak = rgb(170, 30, 40)
    heroes = [
        Hero("fury", "Fury", role="manager", skin=rgb(112, 72, 46), hair=None, hair_style="bald",
             torso=rgb(34, 34, 40), pants=rgb(30, 30, 36), boots=rgb(60, 60, 70), face=fury_face, post=fury_post),
        Hero("strange", "Strange", role="architect", skin=rgb(236, 190, 160), hair=rgb(30, 30, 36), hair_style="short",
             torso=rgb(42, 72, 142), pants=rgb(32, 46, 92), boots=rgb(70, 45, 30), cape=cloak, collar=True,
             face=strange_face, post=strange_post),
        Hero("ironman", "Stark", role="coder", skin=rgb(225, 175, 55), hair_style="iron",
             torso=rgb(190, 30, 40), arm=rgb(225, 175, 55), hand=rgb(225, 175, 55), pants=rgb(190, 30, 40),
             boots=rgb(225, 175, 55), post=iron_post),
        Hero("hulk", "Hulk", role="tester", skin=rgb(92, 172, 72), hair=rgb(30, 70, 36), hair_style="hulk", big=True,
             torso=rgb(92, 172, 72), pants=rgb(110, 60, 160), boots=rgb(92, 172, 72), post=hulk_post),
        Hero("widow", "Widow", role="debugger", skin=rgb(240, 200, 176), hair=rgb(195, 62, 40), hair_style="long",
             torso=rgb(32, 32, 40), pants=rgb(32, 32, 40), boots=rgb(20, 20, 26), post=widow_post),
        Hero("thor", "Thor", role="reviewer", skin=rgb(236, 196, 166), hair=rgb(222, 182, 82), hair_style="long",
             torso=rgb(168, 174, 190), arm=rgb(40, 40, 52), pants=rgb(40, 40, 52), boots=rgb(70, 70, 84), cape=cloak,
             face=thor_face, post=thor_post),
        Hero("vision", "Vision", role="researcher", skin=rgb(192, 42, 72), hair_style="vision",
             torso=rgb(40, 130, 80), pants=rgb(40, 130, 80), boots=rgb(240, 200, 60), cape=rgb(240, 200, 60),
             hand=rgb(192, 42, 72), post=vision_post),
        Hero("spidey", "Spidey", role="pr-writer", skin=rgb(200, 30, 40), hair_style="spidey",
             torso=rgb(200, 30, 40), arm=rgb(200, 30, 40), hand=rgb(200, 30, 40), pants=rgb(40, 70, 165),
             boots=rgb(200, 30, 40), post=spidey_post),
        Hero("loki", "Loki", role="ui-coder", skin=rgb(236, 220, 205), hair=rgb(26, 26, 30), hair_style="short",
             torso=rgb(30, 110, 60), arm=rgb(24, 24, 30), pants=rgb(24, 24, 30), boots=rgb(70, 50, 30),
             cape=rgb(22, 84, 46), collar=True, post=loki_post),
    ]
    skins = [rgb(255, 222, 192), rgb(236, 192, 160), rgb(204, 152, 110), rgb(160, 110, 75), rgb(122, 82, 56), rgb(92, 62, 42)]
    hairs = [(rgb(50, 36, 28), "short"), (rgb(205, 172, 110), "short"), (rgb(26, 26, 30), "spiky"), (None, "bald"),
             (rgb(70, 44, 30), "long"), (rgb(130, 34, 24), "short")]
    for i, (skin, (hair, style)) in enumerate(zip(skins, hairs)):
        heroes.append(Hero(f"agent{i}", "Agent", skin=skin, hair=hair, hair_style=style, torso=rgb(30, 30, 38),
                           pants=rgb(30, 30, 38), boots=rgb(22, 22, 28), post=agent_post))
    # Appended after the field agents so every earlier palette index stays put.
    heroes.append(Hero("hulkbuster", "Hulkbuster", skin=rgb(225, 175, 55), hair_style="iron", big=True,
                       torso=rgb(190, 30, 40), arm=rgb(225, 175, 55), hand=rgb(225, 175, 55), pants=rgb(190, 30, 40),
                       boots=rgb(225, 175, 55), post=buster_post))
    heroes.append(Hero("cap", "Captain America", skin=rgb(236, 196, 166), hair_style="cap",
                       torso=rgb(40, 70, 165), arm=rgb(40, 70, 165), hand=rgb(200, 30, 40), pants=rgb(40, 70, 165),
                       boots=rgb(140, 45, 40), pre=cap_pre, post=cap_post))
    return heroes


def sheet(h: Hero) -> Sprite:
    s = Sprite(16 * 7, 32 * 3)
    for r, d in enumerate(DIRS):
        for f in FRAMES:
            s.blit(body(h, d, f), f * 16, r * 32)
    return s


def portrait(h: Hero) -> Sprite:
    """The head of the standing front frame, 16x16, for the board's crew list."""
    full = body(h, DOWN, WALK2)
    p = Sprite(16, 16)
    for y in range(16):
        for x in range(16):
            p.px_[y][x] = full.px_[y][x]
    return p
