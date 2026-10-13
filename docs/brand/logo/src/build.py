"""Unzeen logo system: builds every SVG in docs/brand/logo/ from code.
Run: python build.py   (needs fonttools; outlines Geist, so the SVGs need no font)
Then: sh render.sh     (SVG -> PNG via headless system Chrome, offline)

Three directions:
  A  crescent  - an eclipse seen low: the occulting disc sits high, the lit rim
                 survives only as a bowl. Bowl = a lowercase u. On dark the disc
                 vanishes into the page (only the rim is seen); on light it shows.
  B  redacted  - the wordmark with its z blacked out by a hatched redaction block.
                 Mark = the block itself.
  C  bead      - totality with one Baily's bead: full hairline corona + a single
                 bright point where the last light leaks out.
"""
import json, math, os, subprocess, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
GEIST = os.path.join(HERE, "..", "..", "..", "..", "web", "node_modules", "geist", "dist", "fonts", "geist-sans")

INK, INK_X, PAPER, FOG, ZEC = "#0B0B0D", "#060607", "#EDEDF0", "#8B8B95", "#F4B728"
LIGHT_BG, LIGHT_INK = "#F4F4F6", "#0B0B0D"
ZEC_ON_LIGHT = "#C98F0A"  # darker cut of the yellow for thin strokes on light paper (3:1 on #F4F4F6)


def outline(weight, text, track_em):
    f = TTFont(os.path.join(GEIST, f"Geist-{weight}.ttf"))
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


# ---------- marks (all drawn in a 64x64 box) ----------
def hatch_pattern(pid, color, gap=3.2, width=1.25, angle=-45):
    return (f'<pattern id="{pid}" patternUnits="userSpaceOnUse" width="{gap}" height="{gap}" '
            f'patternTransform="rotate({angle})"><rect width="{width}" height="{gap}" fill="{color}"/></pattern>')


def mark_crescent(uid, disc, rim=ZEC, small=False, disc_edge=None):
    # lit disc centre lower than the occulter -> bowl-shaped crescent (a "u")
    cy_lit, r_lit = 34.5, 23.0
    cy_occ, r_occ = (27.0, 22.0) if small else (30.0, 22.4)
    edge = f'<circle cx="32" cy="{cy_occ}" r="{r_occ - 0.4}" fill="none" stroke="{disc_edge}" stroke-width="0.8"/>' if disc_edge else ""
    disc_el = f'<circle cx="32" cy="{cy_occ}" r="{r_occ}" fill="{disc}"/>' if disc else ""
    return (f'<defs><mask id="m{uid}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
            f'<rect width="64" height="64" fill="#fff"/><circle cx="32" cy="{cy_occ}" r="{r_occ}" fill="#000"/></mask></defs>'
            f'<circle cx="32" cy="{cy_lit}" r="{r_lit}" fill="{rim}" mask="url(#m{uid})"/>{disc_el}{edge}')


def mark_redacted(uid, block=ZEC, cut=INK, small=False):
    # a lowercase-letter-sized block, struck through with fine 45deg yellow hatch: a redacted glyph.
    # Fine lines (not fat stripes) so it reads as redaction, not as hazard tape.
    x, y, w, h = (10, 17, 44, 30) if not small else (5, 12, 54, 40)
    gap, lw = (4.2, 1.3) if not small else (8.0, 3.0)
    fill = "#1A1405" if cut == INK else "#FBE7B5"
    return (f'<defs><clipPath id="c{uid}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="1.5"/></clipPath>'
            f'{hatch_pattern("h" + uid, block, gap, lw)}</defs>'
            f'<g clip-path="url(#c{uid})"><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"/>'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="url(#h{uid})"/></g>'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="1.5" fill="none" stroke="{block}" stroke-width="{1.2 if not small else 2.6}"/>')


def mark_bead(uid, disc, ring=ZEC, small=False, glow=True):
    r = 21.5
    sw = 2.0 if not small else 3.6
    a = math.radians(-38)
    bx, by = 32 + r * math.cos(a), 32 + r * math.sin(a)
    br = 4.2 if not small else 6.0
    glow_el = ""
    if glow and not small:
        glow_el = (f'<defs><radialGradient id="g{uid}"><stop offset="0" stop-color="{ring}" stop-opacity=".55"/>'
                   f'<stop offset="1" stop-color="{ring}" stop-opacity="0"/></radialGradient></defs>'
                   f'<circle cx="{bx:.2f}" cy="{by:.2f}" r="11" fill="url(#g{uid})"/>')
    disc_el = f'<circle cx="32" cy="32" r="{r - sw / 2:.2f}" fill="{disc}"/>' if disc else ""
    return (f'{glow_el}<circle cx="32" cy="32" r="{r}" fill="none" stroke="{ring}" stroke-width="{sw}"/>{disc_el}'
            f'<circle cx="{bx:.2f}" cy="{by:.2f}" r="{br}" fill="{ring}"/>')


MARKS = {"a": mark_crescent, "b": mark_redacted, "c": mark_bead}


def mark_for(v, theme, uid, small=False):
    dark = theme == "dark"
    if v == "a":
        m = mark_crescent(uid, disc=(None if dark else LIGHT_INK), rim=ZEC, small=small,
                          disc_edge=("rgb(255 255 255 / .07)" if dark and not small else None))
        # small sizes: lift + enlarge so the bowl, not empty space, fills the favicon
        return f'<g transform="translate(-4.8 -17) scale(1.15)">{m}</g>' if small else m
    if v == "b":
        return mark_redacted(uid, block=ZEC, cut=(INK if dark else LIGHT_BG), small=small)
    return mark_bead(uid, disc=(None if dark else LIGHT_INK), ring=ZEC, small=small, glow=dark)


# ---------- wordmark ----------
WM = None


def wordmark(fill, scale, x0, baseline, redact=None):
    out = []
    for g in WM["glyphs"]:
        if redact and g["ch"] == "z" and not out.count("zdone"):
            gx = x0 + g["x"] * scale
            xh = WM["xh"] * scale
            w = g["adv"] * scale * 0.94
            gap, lw = 0.105 * xh, 0.032 * xh
            out.append(f'<defs><clipPath id="wz{redact}"><rect x="{gx:.2f}" y="{baseline - xh:.2f}" width="{w:.2f}" height="{xh:.2f}" rx="{xh * 0.06:.2f}"/></clipPath>'
                       f'{hatch_pattern("wh" + redact, ZEC, gap, lw)}</defs>'
                       f'<g clip-path="url(#wz{redact})"><rect x="{gx:.2f}" y="{baseline - xh:.2f}" width="{w:.2f}" height="{xh:.2f}" fill="{"#1A1405" if fill == PAPER else "#FBE7B5"}"/>'
                       f'<rect x="{gx:.2f}" y="{baseline - xh:.2f}" width="{w:.2f}" height="{xh:.2f}" fill="url(#wh{redact})"/></g>'
                       f'<rect x="{gx:.2f}" y="{baseline - xh:.2f}" width="{w:.2f}" height="{xh:.2f}" rx="{xh * 0.06:.2f}" fill="none" stroke="{ZEC}" stroke-width="{xh * 0.045:.2f}"/>')
            out.append("zdone")
            continue
        out.append(f'<path d="{g["d"]}" fill="{fill}" transform="translate({x0:.2f} {baseline:.2f}) scale({scale})"/>')
    return "".join(o for o in out if o != "zdone")


def lockup(v, theme):
    """Horizontal lockup: mark + wordmark. Height 64 units of mark; canvas padded."""
    fg = PAPER if theme == "dark" else LIGHT_INK
    bg = INK if theme == "dark" else LIGHT_BG
    s = 64 / 1000 * 1.0  # 1000 upm -> x-height ~ 34 units at scale .064*... tuned below
    scale = 0.072        # wordmark x-height ~ 0.53*1000*0.072 = 38 units
    xh = WM["xh"] * scale
    pad = 40
    mark_box = 64
    gap = 18
    baseline = pad + 32 + xh / 2  # x-height centred on the mark's centre
    if v == "b":
        # B is the wordmark itself (z redacted); no separate mark in the lockup
        w = WM["width"] * scale + pad * 2
        h = 64 + pad * 2
        return svg(round(w), h, wordmark(fg, scale, pad, baseline, redact=f"l{theme}"), bg=bg)
    w = pad + mark_box + gap + WM["width"] * scale + pad
    h = 64 + pad * 2
    if v == "a":
        k = 1.3
        oy = baseline + 1.5 - 57.5 * k
        body = f'<g transform="translate({pad} {oy:.2f}) scale({k})">{mark_for(v, theme, "L" + v + theme)}</g>'
        mark_w = 64 * k
    else:
        body = f'<g transform="translate({pad} {pad})">{mark_for(v, theme, "L" + v + theme)}</g>'
        mark_w = mark_box
    body += wordmark(fg, scale, pad + mark_w + gap, baseline)
    w = pad + mark_w + gap + WM["width"] * scale + pad
    return svg(round(w), h, body, bg=bg)


def mark_file(v, theme, size=64, small=False, bg=True, pad_ratio=0.0):
    b = INK if theme == "dark" else LIGHT_BG
    inner = mark_for(v, theme, f"M{v}{theme}{size}{int(small)}", small=small)
    if pad_ratio:
        k = 1 - 2 * pad_ratio
        inner = f'<g transform="translate({64 * pad_ratio} {64 * pad_ratio}) scale({k})">{inner}</g>'
    return svg(64, 64, inner, bg=(b if bg else None)).replace('width="64" height="64"', f'width="{size}" height="{size}"', 1)


def app_icon(v):
    # 512 full-bleed square; platform masks round it. Mark at ~58% for safe area.
    inner = mark_for(v, "dark", f"I{v}", small=False)
    k = 0.58
    off = 64 * (1 - k) / 2
    grain = ""
    body = (f'<defs><radialGradient id="vig{v}" cx=".5" cy=".42" r=".75"><stop offset="0" stop-color="#16161A"/>'
            f'<stop offset="1" stop-color="{INK_X}"/></radialGradient></defs><rect width="64" height="64" fill="url(#vig{v})"/>'
            f'<g transform="translate({off} {off + (2 if v == "a" else 0)}) scale({k})">{inner}</g>{grain}')
    return svg(64, 64, body).replace('width="64" height="64"', 'width="512" height="512"', 1)


def main():
    global WM
    WM = outline("Medium", "unzeen", -0.035)
    os.makedirs(os.path.join(OUT, "svg"), exist_ok=True)
    files = {}
    for v in "abc":
        for t in ("dark", "light"):
            files[f"logo-{v}-lockup-{t}.svg"] = lockup(v, t)
            files[f"logo-{v}-mark-{t}.svg"] = mark_file(v, t, 256)
            files[f"logo-{v}-mark-{t}-transparent.svg"] = mark_file(v, t, 256, bg=False)
        files[f"logo-{v}-favicon.svg"] = mark_file(v, "dark", 32, small=True, pad_ratio=0.02)
        files[f"logo-{v}-app-512.svg"] = app_icon(v)
    for name, s in files.items():
        with open(os.path.join(OUT, "svg", name), "w") as fh:
            fh.write(s)
    print("\n".join(sorted(files)))


if __name__ == "__main__":
    main()
