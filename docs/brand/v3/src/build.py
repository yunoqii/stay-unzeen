"""Unzeen brand v3: every logo SVG in docs/brand/v3/svg/ is built here from code.
Run: python build.py   (needs fonttools; Geist is outlined, so the SVGs need no font)
Then: sh render.sh     (HTML/SVG -> PNG via headless system Chrome, offline)

Five directions (marks drawn in a 64x64 box):
  A  proof   - commitment brackets around a solid block: [#]. In proof papers a value in
               brackets is committed: it exists, it is bound, nobody can read it. zk direction.
  B  root    - a Merkle root: one public node on top, two hatched (hidden) leaves under it.
               The sum is public, the owners are not. zk direction, mirrors /verify.
  C  bite    - a solid yellow tile with a black disc rising over its top edge. What is left
               is a heavy lowercase u. Bold geometric, the eclipse made blunt.
  D  tape    - a slab of yellow redaction tape with a torn end. The wordmark wears it over "zee".
  E  visor   - a mascot: a black lump with a yellow censor bar where eyes would be. No face.
"""
import math, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
SVG = os.path.join(OUT, "svg")
FONTS = os.path.join(HERE, "..", "..", "..", "..", "web", "node_modules", "geist", "dist", "fonts")

INK, INK0, PAPER, FOG, FOG1, ZEC = "#0B0B0D", "#060607", "#EDEDF0", "#8B8B95", "#3A3A41", "#F4B728"
LIGHT = "#F4F4F6"


def outline(font, text, track_em=0.0):
    fam = "geist-mono" if font.startswith("GeistMono") else "geist-sans"
    f = TTFont(os.path.join(FONTS, fam, f"{font}.ttf"))
    gs, cmap, upm, hmtx = f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm, f["hmtx"]
    glyphs, x = [], 0.0
    for ch in text:
        pen = SVGPathPen(gs)
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        glyphs.append({"ch": ch, "x": x, "adv": hmtx[g][0], "d": pen.getCommands()})
        x += hmtx[g][0] + track_em * upm
    return {"glyphs": glyphs, "width": x - track_em * upm, "upm": upm, "xh": f["OS/2"].sxHeight}


def svg(w, h, body, bg=None, title="unzeen"):
    rect = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'role="img" aria-label="{title}"><title>{title}</title>{rect}{body}</svg>\n')


def hatch(pid, color, gap=4.0, width=1.6, angle=-45):
    return (f'<pattern id="{pid}" patternUnits="userSpaceOnUse" width="{gap}" height="{gap}" '
            f'patternTransform="rotate({angle})"><rect width="{width}" height="{gap}" fill="{color}"/></pattern>')


# ---------------- marks: fg = main colour, bg = the colour of the ground (for cut-outs) ----------------
def mark_proof(u, fg=ZEC, block=None, bg=None, small=False):
    t = 8 if small else 6.5
    x0, x1, y0, y1 = (4, 18, 7, 57) if small else (6, 19, 8, 56)
    lb = f"M{x0},{y0}H{x1}V{y0+t}H{x0+t}V{y1-t}H{x1}V{y1}H{x0}Z"
    rb = f"M{64-x0},{y0}H{64-x1}V{y0+t}H{64-x0-t}V{y1-t}H{64-x1}V{y1}H{64-x0}Z"
    bx = (23, 18, 18, 28) if small else (24, 18, 16, 28)
    return (f'<path d="{lb}" fill="{fg}"/><path d="{rb}" fill="{fg}"/>'
            f'<rect x="{bx[0]}" y="{bx[1]}" width="{bx[2]}" height="{bx[3]}" fill="{block or fg}"/>')


def mark_root(u, fg=ZEC, line=None, bg=None, small=False):
    line = line or fg
    sw = 5 if small else 3.5
    r = (22, 5, 20, 20) if small else (24, 6, 16, 16)
    lw = 18 if small else 15
    L = (4, 41) if small else (6, 42)
    R = (64 - L[0] - lw, L[1])
    rcx, rby = r[0] + r[2] / 2, r[1] + r[3]
    edges = (f'<path d="M{rcx},{rby} L{L[0]+lw/2},{L[1]} M{rcx},{rby} L{R[0]+lw/2},{R[1]}" '
             f'stroke="{line}" stroke-width="{sw}" fill="none" stroke-linecap="square"/>')
    inner = ""
    if not small:
        inner = (f'<defs>{hatch("h"+u, fg, 3.4, 1.3)}</defs>'
                 f'<rect x="{L[0]+sw/2}" y="{L[1]+sw/2}" width="{lw-sw}" height="{lw-sw}" fill="url(#h{u})"/>'
                 f'<rect x="{R[0]+sw/2}" y="{R[1]+sw/2}" width="{lw-sw}" height="{lw-sw}" fill="url(#h{u})"/>')
    leaves = "".join(f'<rect x="{x+sw/2}" y="{y+sw/2}" width="{lw-sw}" height="{lw-sw}" fill="{bg or 'none'}" stroke="{line}" stroke-width="{sw}"/>'
                     for x, y in (L, R))
    return edges + leaves + inner + f'<rect x="{r[0]}" y="{r[1]}" width="{r[2]}" height="{r[3]}" fill="{fg}"/>'


def mark_bite(u, fg=ZEC, bg=None, small=False):
    # tile minus a disc rising over its top edge (mask keeps transparent exports honest)
    m = 3 if small else 5
    rx = 7 if small else 9
    cy, r = (13, 18) if small else (14, 19.5)
    return (f'<defs><mask id="m{u}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
            f'<rect width="64" height="64" fill="#fff"/><circle cx="32" cy="{cy}" r="{r}" fill="#000"/></mask></defs>'
            f'<rect x="{m}" y="{m}" width="{64-2*m}" height="{64-2*m}" rx="{rx}" fill="{fg}" mask="url(#m{u})"/>')


def tape_path(x0, y0, w, h, teeth=4, tear=6):
    # straight left end, torn (zig-zag) right end
    pts = [(x0, y0), (x0 + w, y0)]
    step = h / teeth
    for i in range(teeth):
        pts.append((x0 + w - tear * (1 if i % 2 == 0 else 0.25), y0 + step * (i + 0.5)))
        pts.append((x0 + w - (0 if i < teeth - 1 else 0), y0 + step * (i + 1)))
    pts.append((x0, y0 + h))
    return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts) + "Z"


def mark_tape(u, fg=ZEC, bg=None, small=False):
    h = 26 if small else 22
    d = tape_path(4, 32 - h / 2, 56, h, teeth=3 if small else 4, tear=7 if small else 6)
    fray = ""
    if False:  # (dropped: the gaps read as a cigarette filter) three widening gaps ahead of the tear: the redaction runs out (as in our ▓▒░)
        fray = "".join(f'<rect x="{x}" y="{32-h/2-1}" width="{w}" height="{h+2}" fill="#000"/>'
                       for x, w in ((40, 1.6), (45, 2.4), (50, 3.4)))
    return (f'<defs><mask id="t{u}" maskUnits="userSpaceOnUse" x="-20" y="-20" width="104" height="104">'
            f'<rect x="-20" y="-20" width="104" height="104" fill="#fff"/>{fray}</mask></defs>'
            f'<g transform="rotate(-14 32 32)"><path d="{d}" fill="{fg}" mask="url(#t{u})"/></g>')


def mark_visor(u, fg=ZEC, bar=None, bg=None, small=False, crop=False):
    # a lump (wider at the base, round top, flat bottom) with a censor bar cut out where eyes would be
    if crop:  # for avatars: sits on the bottom edge, rises out of frame bottom
        body = "M8,66 C8,40 14,12 32,12 C50,12 56,40 56,66 Z"
        by = 27
    else:
        body = "M9,58 C9,36 15,8 32,8 C49,8 55,36 55,58 Z"
        by = 23
    bh = 10 if small else 8.5
    cut = f'<rect x="4" y="{by}" width="56" height="{bh}" transform="rotate(-7 32 {by+bh/2})" fill="#000"/>'
    if bar:  # coloured bar, drawn inside the body only
        return (f'<defs><clipPath id="v{u}"><path d="{body}"/></clipPath></defs><path d="{body}" fill="{fg}"/>'
                f'<g clip-path="url(#v{u})"><rect x="4" y="{by}" width="56" height="{bh}" transform="rotate(-7 32 {by+bh/2})" fill="{bar}"/></g>')
    return (f'<defs><mask id="v{u}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="70">'
            f'<rect width="64" height="70" fill="#fff"/>{cut}</mask></defs><path d="{body}" fill="{fg}" mask="url(#v{u})"/>')


MARKS = {"a": mark_proof, "b": mark_root, "c": mark_bite, "d": mark_tape, "e": mark_visor}
NAMES = {"a": "proof", "b": "root", "c": "bite", "d": "tape", "e": "visor"}
WORD = {  # wordmark font + tracking + colour (dark)
    "a": ("GeistMono-Medium", -0.02),
    "b": ("Geist-Light", -0.01),
    "c": ("Geist-Bold", -0.035),
    "d": ("Geist-Black", -0.04),
    "e": ("Geist-Black", -0.03),
}


def mark_g(k, u, light=False, small=False):
    f = MARKS[k]
    if not light:
        return f(u, small=small)
    if k == "a": return f(u, fg=INK, block=ZEC, bg=LIGHT, small=small)
    if k == "b": return f(u, fg=INK, bg=LIGHT, small=small)
    if k == "c": return f(u, fg=INK, bg=LIGHT, small=small)
    if k == "d": return f(u, fg=ZEC, bg=LIGHT, small=small).replace(f'<path d', f'<path stroke="{INK}" stroke-width="1.2" d', 1)
    if k == "e": return f(u, fg=INK, bar=ZEC, bg=LIGHT, small=small)


def wordmark(k, x, base, size, color, u, light=False):
    font, tr = WORD[k]
    o = outline(font, "unzeen", tr)
    s = size / o["upm"]
    paths = "".join(f'<path d="{g["d"]}"/>' for g in o["glyphs"])
    out = f'<g transform="translate({x} {base}) scale({s})" fill="{color}">{paths}</g>'
    extra = ""
    if k == "d":  # the tape over "zee": covers the middle band of the x-height, letters still read
        g = o["glyphs"]
        zx0, zx1 = g[2]["x"] * s + x - 4, (g[4]["x"] + g[4]["adv"]) * s + x + 2
        xh = o["xh"] * s
        h = xh * 0.5
        y0 = base - xh * 0.42 - h / 2
        d = tape_path(zx0, y0, zx1 - zx0, h, teeth=3, tear=h * 0.32)
        extra = f'<g transform="rotate(-4 {(zx0+zx1)/2} {y0+h/2})"><path d="{d}" fill="{ZEC}"/></g>'
    return out + extra, o["width"] * s


def lockup(k, light=False):
    H = 120
    msize = 84
    body = f'<g transform="translate(18 18) scale({msize/64})">{mark_g(k, "L"+k+("l" if light else "d"), light)}</g>'
    size = 76 if k != "a" else 68
    color = INK if light else PAPER
    wm, ww = wordmark(k, 18 + msize + 26, 87, size, color, k, light)
    W = int(18 + msize + 26 + ww + 26)
    return svg(W, H, body + wm, bg=LIGHT if light else INK, title="unzeen")


def write(name, s):
    open(os.path.join(SVG, name), "w").write(s)


def main():
    os.makedirs(SVG, exist_ok=True)
    for k in MARKS:
        n = f"{k}-{NAMES[k]}"
        write(f"{n}-mark-dark.svg", svg(64, 64, mark_g(k, k + "1"), bg=INK))
        write(f"{n}-mark-transparent.svg", svg(64, 64, MARKS[k](k + "2", bg=None)))
        write(f"{n}-mark-light.svg", svg(64, 64, mark_g(k, k + "3", light=True), bg=LIGHT))
        write(f"{n}-favicon.svg", svg(64, 64, mark_g(k, k + "4", small=True), bg=INK))
        write(f"{n}-lockup-dark.svg", lockup(k))
        write(f"{n}-lockup-light.svg", lockup(k, light=True))
        # wordmark only (for the header): outlined text, no mark
        font, tr = WORD[k]
        wm, ww = wordmark(k, 4, 60, 76 if k != "a" else 68, PAPER, k + "w")
        write(f"{n}-wordmark-dark.svg", svg(int(ww + 8), 80, wm))
    # avatar marks (no ground): visor rising from the bottom edge
    write("e-visor-avatar-body.svg", svg(64, 64, mark_visor("av", fg=INK0, bar="#F4B728", crop=True)))
    write("e-visor-avatar-yellow.svg", svg(64, 64, mark_visor("ay", crop=True)))
    print("ok")


if __name__ == "__main__":
    main()
