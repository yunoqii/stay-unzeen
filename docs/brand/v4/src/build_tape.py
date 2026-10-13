"""v4 tape kit exports: flat vs full vs simple tape, on the mark, favicon, avatar, wordmark (D2a), banner D and OG.
Run: python build_tape.py (needs fonttools), then the HTML sheets via render_tape.sh."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "..", "v3", "src"))
from build import outline, svg, INK, PAPER, LIGHT  # noqa: E402
from tape import tape, pair  # noqa: E402
SVG = os.path.join(os.path.dirname(HERE), "svg", "tape"); os.makedirs(SVG, exist_ok=True)
TILE = f'<rect width="64" height="64" rx="12" fill="{INK}"/>'


def w(name, s): open(os.path.join(SVG, name), "w").write(s)


def wordmark(level, color=PAPER, size=76, base=84, gap=15, two=False):
    """D2a: 'un' + tape where the z was + 'een'. Extra room around the z slot so the tape never bites n or e."""
    o = outline("Geist-Black", "unzeen", -0.03); s = size / o["upm"]; g = o["glyphs"]
    p_before = "".join(f'<path d="{gg["d"]}"/>' for gg in g[:2])
    p_after = "".join(f'<path d="{gg["d"]}"/>' for gg in g[3:])
    zx0 = 10 + g[2]["x"] * s + gap; zx1 = zx0 + g[2]["adv"] * s; xh = o["xh"] * s
    body = (f'<g transform="translate(10 {base}) scale({s:.5f})" fill="{color}">{p_before}</g>'
            f'<g transform="translate({10 + 2*gap} {base}) scale({s:.5f})" fill="{color}">{p_after}</g>')
    tw, th = (zx1 - zx0) * 1.75, xh * 0.9
    cx, cy = (zx0 + zx1) / 2, base - xh / 2
    body += (pair(cx - tw / 2, cy - th / 2, tw, th, level=level) if two else tape(cx - tw / 2, cy - th / 2, tw, th, rot=-20, level=level))
    W = o["width"] * s + 20 + 2 * gap
    return body, W


for lv in ("flat", "full", "simple"):
    if lv != "flat":  # the chosen two-layer sign
        w(f"pair-mark-{lv}.svg", svg(64, 64, pair(6, 19, 52, 24, lv)))
        w(f"pair-mark-{lv}-tile.svg", svg(64, 64, TILE + pair(5, 17, 54, 27 if lv == "simple" else 25, lv)))
        b, W = wordmark(lv, two=True); w(f"pair-wordmark-{lv}.svg", svg(int(W), 110, b))
    w(f"mark-{lv}.svg", svg(64, 64, tape(5, 20, 54, 24, -20, lv)))
    w(f"mark-{lv}-tile.svg", svg(64, 64, TILE + tape(4, 18, 56, 28 if lv != "full" else 25, -20, lv)))
    w(f"avatar-{lv}.svg", svg(64, 64, f'<rect width="64" height="64" fill="{INK}"/>' + tape(-12, 16, 86, 30, -20, lv)))
    b, W = wordmark(lv)
    w(f"wordmark-{lv}.svg", svg(int(W), 110, b))
    w(f"lockup-{lv}.svg", svg(int(W + 140), 140, f'<g transform="translate(18 26) scale(1.38)">{tape(5, 20, 54, 24, -20, lv)}</g>'
                                                    f'<g transform="translate(122 8)">{b}</g>', bg=INK))
    b2, W2 = wordmark(lv, color=INK)
    w(f"lockup-{lv}-light.svg", svg(int(W2 + 140), 140, f'<g transform="translate(18 26) scale(1.38)">{tape(5, 20, 54, 24, -20, lv)}</g>'
                                                         f'<g transform="translate(122 8)">{b2}</g>', bg=LIGHT))
    # the big strip from banner D / OG (strip only, placed by the HTML)
    w(f"banner-strip-{lv}.svg", svg(940, 200, tape(30, 46, 860, 118, -3, lv)))
print("ok")
