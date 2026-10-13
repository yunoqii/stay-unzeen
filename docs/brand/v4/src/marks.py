"""Unzeen brand v4: mark + wordmark iterations inside the Tape system (banner D, palette and tape language kept).
Run: python marks.py (fonttools; Geist outlined), then sh render.sh. Helpers come from ../../v3/src/build.py.

Owner brief: keep the tape, make it hit the eye. Bigger and thicker than the letters, bleeding past the word and
the tile, steeper (-20..-22 deg), louder teeth, a second dark piece, contrast flip, flat masking texture.
  1 bleed  2 double  3 slab  4 inverse  5 masking  6 label  7 torn  8 struck (see NOTES)
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "v3", "src"))
from build import outline, svg, INK, PAPER, ZEC, LIGHT  # noqa: E402

OUT = os.path.dirname(HERE); SVG = os.path.join(OUT, "svg")


def strip(x0, y0, w, h, tear_r=True, tear_l=False, teeth=3, tear=None):
    """A strip of tape as a path. Torn ends are zig-zags."""
    tear = tear if tear is not None else min(h * 0.32, w * 0.25)
    step = h / teeth
    pts = [(x0, y0), (x0 + w, y0)]
    if tear_r:
        for i in range(teeth):
            pts += [(x0 + w - tear * (1 if i % 2 == 0 else 0.3), y0 + step * (i + 0.5)), (x0 + w, y0 + step * (i + 1))]
    else:
        pts.append((x0 + w, y0 + h))
    pts.append((x0, y0 + h))
    if tear_l:
        for i in range(teeth):
            pts += [(x0 + tear * (1 if i % 2 == 0 else 0.3), y0 + h - step * (i + 0.5)), (x0, y0 + h - step * (i + 1))]
    return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts) + "Z"


def T(d, rot=0, cx=32, cy=32, fill=ZEC, gap=None):
    st = f' stroke="{gap}" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round"' if gap else ""
    return f'<path transform="rotate({rot} {cx} {cy})" d="{d}" fill="{fill}"{st}/>'


def glyph(ch, font, size, cx, base, color, gap=None):
    """One outlined glyph centred on cx, baseline at base."""
    o = outline(font, ch)
    s = size / o["upm"]; g = o["glyphs"][0]
    x = cx - g["adv"] * s / 2
    st = f' stroke="{gap}" stroke-width="{2.6 / s:.1f}" paint-order="stroke"' if gap else ""
    return f'<g transform="translate({x:.2f} {base}) scale({s:.5f})" fill="{color}"><path d="{g["d"]}"{st}/></g>'


# ------------------------------------------------------------------ marks
# Every mark is drawn for three contexts: "mark" (logo, 64 box), "fav" (16-48px, on an ink tile), "av" (X avatar:
# the tape may leave the frame - in the X circle it reads as a sticker slapped over the avatar).
FOG1, ZEC_HI, ZEC_LO = "#3A3A41", "#F9D57A", "#C9900F"
TILE = f'<rect width="64" height="64" rx="12" fill="{INK}"/>'
CLIP = '<clipPath id="tile"><rect width="64" height="64" rx="12"/></clipPath>'

def big(x0, y0, w, h, teeth=2, tear=None, l=False):
    return strip(x0, y0, w, h, teeth=teeth, tear=tear if tear is not None else h * 0.42, tear_l=l)

def v1(ctx):  # bleed: one fat strip, steep, runs off the tile on the left, big teeth on the right
    t = T(big(-14, 18, 80, 28 if ctx != "fav" else 30, teeth=2, tear=11), -22)
    if ctx == "av": return T(big(-30, 16, 98, 32, teeth=2, tear=12), -22)
    return f'<defs>{CLIP}</defs>{TILE}<g clip-path="url(#tile)">{t}</g>'

def v2(ctx):  # double: a dark second piece under a yellow one, crossed at different angles
    under = T(big(-14, 22, 84, 20, teeth=2, tear=8, l=True), 16, fill=FOG1)
    over = T(big(-14, 19, 80, 26, teeth=2, tear=10), -22, gap=INK)
    if ctx == "av":
        under = T(big(-30, 20, 110, 24, teeth=2, tear=9, l=True), 16, fill=FOG1); over = T(big(-30, 17, 98, 30, teeth=2, tear=12), -22, gap=INK)
        return under + over
    return f'<defs>{CLIP}</defs>{TILE}<g clip-path="url(#tile)">{under}{over}</g>'

def v3(ctx):  # slab: one chunky block, one loud torn edge; pill-level minimal
    return T(big(7, 15, 50, 34, teeth=2, tear=12), -12) if ctx != "av" else T(big(2, 13, 60, 38, teeth=2, tear=13), -12)

def v4(ctx):  # inverse: ink tape across a yellow tile (square, never a circle)
    tile = f'<rect x="{6 if ctx == "av" else 2}" y="{6 if ctx == "av" else 2}" width="{52 if ctx == "av" else 60}" height="{52 if ctx == "av" else 60}" rx="11" fill="{ZEC}"/>'
    cp = f'<clipPath id="yt{ctx}"><rect x="{6 if ctx == "av" else 2}" y="{6 if ctx == "av" else 2}" width="{52 if ctx == "av" else 60}" height="{52 if ctx == "av" else 60}" rx="11"/></clipPath>'
    return f'<defs>{cp}</defs>{tile}<g clip-path="url(#yt{ctx})">{T(big(-14, 20, 80, 24, teeth=2, tear=10), -22, fill=INK)}</g>'

def masking(x0, y0, w, h, rot, cx=32, cy=32, teeth=3, fine=True):
    """flat masking tape: lighter translucent edges + two creases. Fine detail only at logo size."""
    d = strip(x0, y0, w, h, teeth=teeth, tear=h * 0.3, tear_l=True)
    extra = ""
    if fine:
        e = max(1.6, h * 0.11)
        extra = (f'<clipPath id="mk{int(y0*10)}{int(rot)}"><path d="{d}"/></clipPath><g clip-path="url(#mk{int(y0*10)}{int(rot)})">'
                 f'<rect x="{x0-4}" y="{y0}" width="{w+8}" height="{e}" fill="{ZEC_HI}" opacity=".8"/>'
                 f'<rect x="{x0-4}" y="{y0+h-e}" width="{w+8}" height="{e}" fill="{ZEC_HI}" opacity=".8"/>'
                 f'<path d="M{x0+w*0.34},{y0} l{-h*0.18},{h}" stroke="{ZEC_LO}" stroke-width="{max(1, h*0.05)}" opacity=".7"/>'
                 f'<path d="M{x0+w*0.7},{y0} l{h*0.12},{h}" stroke="{ZEC_LO}" stroke-width="{max(1, h*0.05)}" opacity=".6"/></g>')
    return f'<g transform="rotate({rot} {cx} {cy})"><path d="{d}" fill="{ZEC}"/>{extra}</g>'

def v5(ctx):  # masking tape
    if ctx == "av": return masking(-14, 17, 92, 30, -20)
    return masking(2, 20, 60, 24 if ctx != "fav" else 28, -20, fine=ctx != "fav")

def v6(ctx):  # label: the u knocked out of a strip
    u = glyph("u", "Geist-Black", 56 if ctx != "fav" else 60, 32, 48 if ctx != "fav" else 50, INK)
    sw = (-6, 10, 76, 42) if ctx == "av" else (1, 11, 62, 42)
    return f'<g transform="rotate(-16 32 32)">{T(strip(sw[0], sw[1], sw[2], sw[3], tear_l=True, teeth=3, tear=7))}{u}</g>'

def v7(ctx):  # torn: one strip torn in two, a clear gap
    h = 24 if ctx == "mark" else 28
    x0, W = (-6, 76) if ctx == "av" else (1, 62)
    a = W * 0.46
    l = strip(x0, 32 - h / 2, a, h, teeth=2, tear=h * 0.4)
    r = strip(x0 + a + 4, 32 - h / 2, W - a - 4, h, tear_r=False, tear_l=True, teeth=2, tear=h * 0.4)
    return f'<g transform="rotate(-20 32 32)"><path d="{l}" fill="{ZEC}"/><path d="{r}" fill="{ZEC}" transform="translate(5 6)"/></g>'

def v8(ctx):  # struck: a heavy u, a fat steep strip over it that leaves the u on both sides
    u = glyph("u", "Geist-Black", 72 if ctx != "av" else 66, 32, 54 if ctx != "av" else 52, PAPER)
    t = T(big(-10, 25, 84, 18 if ctx != "fav" else 20, teeth=2, tear=8), -22, gap=INK)
    return u + t


MARKS = [v1, v2, v3, v4, v5, v6, v7, v8]
NAMES = ["bleed", "double", "slab", "inverse", "masking", "label", "torn", "struck"]
NOTES = ["one fat strip, -22°, runs off the tile, big teeth", "yellow strip over a dark second piece", "chunky block, one loud torn edge",
         "ink tape across a yellow square tile", "flat masking tape: light edges, creases", "the u knocked out of a strip",
         "one strip torn in two", "a heavy u with a fat steep strip over it"]


# ------------------------------------------------------------------ wordmarks: the tape is big, steep and leaves the word
def word(font, size, color, x=10, base=82, tr=-0.03, skip=()):
    o = outline(font, "unzeen", tr); s = size / o["upm"]
    paths = "".join(f'<path d="{g["d"]}"/>' for k, g in enumerate(o["glyphs"]) if k not in skip)
    return o, s, f'<g transform="translate({x} {base}) scale({s:.5f})" fill="{color}">{paths}</g>'

def zbox(o, s, x, i0=2, i1=2):
    g = o["glyphs"]; return g[i0]["x"] * s + x, (g[i1]["x"] + g[i1]["adv"]) * s + x, o["xh"] * s

def wordmark(i, color=PAPER):
    H, base = 120, 82
    if i in (1, 2, 5, 7):  # tape over the z only, oversized: taller than the letters, steep
        o, s, b = word("Geist-Black", 76, color, base=base, skip=(2,))
        x0, x1, xh = zbox(o, s, 10); cx, cy = (x0 + x1) / 2, base - xh / 2
        w, h = (x1 - x0) * 1.9, xh * 1.55
        if i == 2:
            b += T(strip(cx - w * 0.55, cy - h * 0.35, w * 1.1, h * 0.7, teeth=2, tear=h * 0.25, tear_l=True), 18, cx, cy, fill=FOG1)
        if i == 5:
            b += masking(cx - w / 2, cy - h / 2, w, h, -20, cx, cy, teeth=2)
        elif i == 7:
            a = w * 0.48
            l = strip(cx - w / 2, cy - h / 2, a, h, teeth=2, tear=h * 0.3)
            r = strip(cx - w / 2 + a + 3, cy - h / 2, w - a - 3, h, tear_r=False, tear_l=True, teeth=2, tear=h * 0.3)
            b += f'<g transform="rotate(-20 {cx} {cy})"><path d="{l}" fill="{ZEC}"/><path d="{r}" fill="{ZEC}" transform="translate(4 5)"/></g>'
        else:
            b += T(strip(cx - w / 2, cy - h / 2, w, h, teeth=2, tear=h * 0.32), -20, cx, cy, gap=INK)
        return b, o["width"] * s + 20, H
    if i == 3:  # clean word, the slab sits in front as the mark (lockup only)
        o, s, b = word("Geist-Black", 78, color, base=base); return b, o["width"] * s + 20, H
    if i == 4:  # the z becomes the mark: a yellow tile with ink tape, set as a letter
        o, s, b = word("Geist-Black", 76, color, base=base, skip=(2,))
        x0, x1, xh = zbox(o, s, 10); sz = xh * 1.08; tx = (x0 + x1) / 2 - sz / 2
        b += f'<g transform="translate({tx} {base - sz}) scale({sz / 64})">{v4("mark")}</g>'
        return b, o["width"] * s + 20, H
    if i == 6:  # label-maker strip, word knocked out, torn both ends
        o, s, b0 = word("Geist-Black", 64, INK, x=36, base=80)
        W = o["width"] * s + 72
        return T(strip(4, 28, W - 8, 70, tear_l=True, teeth=3, tear=10), -4, W / 2, 63) + f'<g transform="rotate(-4 {W/2} 63)">{b0}</g>', W, H
    if i == 8:  # mono, the tape covers z-e-e and runs past it above and below
        o, s, b = word("GeistMono-Bold", 74, color, tr=0, base=base, skip=(2, 3, 4))
        x0, x1, xh = zbox(o, s, 10, 2, 4); cx, cy = (x0 + x1) / 2, base - xh / 2
        b += T(strip(x0 - 6, cy - xh * 0.8, x1 - x0 + 12, xh * 1.6, teeth=3, tear=10), -8, cx, cy, gap=INK)
        return b, o["width"] * s + 20, H


def write(name, s): open(os.path.join(SVG, name), "w").write(s)


def main():
    os.makedirs(SVG, exist_ok=True)
    for i, (m, n) in enumerate(zip(MARKS, NAMES), 1):
        k = f"{i}-{n}"
        write(f"{k}-mark.svg", svg(64, 64, m("mark")))
        fav = m("fav"); fav = fav if fav.count(TILE) else TILE + fav
        write(f"{k}-favicon.svg", svg(64, 64, fav))
        write(f"{k}-avatar.svg", svg(64, 64, f'<rect width="64" height="64" fill="{INK}"/>' + m("av")))
        wb, ww, wh = wordmark(i)
        write(f"{k}-wordmark.svg", svg(int(ww), wh, wb))
        if i in (6,):
            write(f"{k}-lockup.svg", svg(int(ww + 30), 140, f'<g transform="translate(15 10)">{wb}</g>', bg=INK))
        else:
            write(f"{k}-lockup.svg", svg(int(20 + 92 + 18 + ww + 10), 140,
                  f'<g transform="translate(20 24) scale({92 / 64})">{m("mark")}</g><g transform="translate({20 + 92 + 18 - 10} 10)">{wb}</g>', bg=INK))
    import json; json.dump([{"k": f"{i}-{n}", "t": f"{i} · {n}", "note": nt} for i, (n, nt) in enumerate(zip(NAMES, NOTES), 1)],
                           open(os.path.join(HERE, "dirs.json"), "w"))
    print("ok")


if __name__ == "__main__":
    main()
