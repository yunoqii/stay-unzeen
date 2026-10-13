"""Unzeen final brand set, v4 (owner picks 13.10.2026): folded two-layer tape (yellow masking tape with creases, crepe
ribs, light edges, curled corner and a shadow step, over a dark second piece), wordmark D2a (tape where the z is),
X avatar = the tape as a sticker slapped across the avatar, banner D with the new tape.
Geometry: ../../v4/src/tape.py (tape kit) + ../../v3/src/build.py (outlined Geist). Run: python build.py; sh render.sh.
Detail levels: "full" for >= ~64px (logo, banner, OG, avatar), "simple" for 16-48px (favicon, header mark, app icon).
"""
import os, sys, struct
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "v4", "src")); sys.path.insert(0, os.path.join(HERE, "..", "..", "v3", "src"))
from build import outline, svg, INK, PAPER, LIGHT  # noqa: E402  (v3)
from tape import tape, pair, under  # noqa: E402  (v4 tape kit)

OUT = os.path.dirname(HERE)
SVG, WEB = os.path.join(OUT, "svg"), os.path.join(OUT, "for-web")
TILE = f'<rect width="64" height="64" rx="12" fill="{INK}"/>'


def write(d, name, s): open(os.path.join(d, name), "w").write(s)


def mark(level): return pair(6, 19, 52, 24, level)
def fav(): return TILE + pair(5, 17, 54, 27, "simple")


def wordmark(level, color=PAPER, size=76, base=84, gap=15):
    """D2a: 'un' + the tape where the z was + 'een'. Extra room around the slot so the tape never bites n or e."""
    o = outline("Geist-Black", "unzeen", -0.03); s = size / o["upm"]; g = o["glyphs"]
    pb = "".join(f'<path d="{gg["d"]}"/>' for gg in g[:2]); pa = "".join(f'<path d="{gg["d"]}"/>' for gg in g[3:])
    zx0 = 10 + g[2]["x"] * s + gap; zx1 = zx0 + g[2]["adv"] * s; xh = o["xh"] * s
    body = (f'<g transform="translate(10 {base}) scale({s:.5f})" fill="{color}">{pb}</g>'
            f'<g transform="translate({10 + 2 * gap} {base}) scale({s:.5f})" fill="{color}">{pa}</g>')
    tw, th = (zx1 - zx0) * 1.75, xh * 0.9
    body += pair((zx0 + zx1) / 2 - tw / 2, base - xh / 2 - th / 2, tw, th, level=level)
    return body, o["width"] * s + 20 + 2 * gap


def lockup(light=False):
    b, W = wordmark("full", INK if light else PAPER)
    return svg(int(W + 140), 140, f'<g transform="translate(18 26) scale(1.38)">{mark("full")}</g><g transform="translate(122 8)">{b}</g>',
               bg=LIGHT if light else INK)


def avatar():
    """X avatar 400: an inner disc with a hairline ring; the tape is slapped across it and runs past the disc to the
    crop edge, so even inside X's circle it reads as a sticker stuck over the avatar."""
    disc = '<circle cx="200" cy="200" r="148" fill="#141417"/><circle cx="200" cy="200" r="148" fill="none" stroke="#26262C" stroke-width="2"/>'
    return svg(400, 400, f'<rect width="400" height="400" fill="{INK}"/>{disc}' + pair(-60, 170, 420, 96, "full", rot=-20, urot=11))


def main():
    for d in (SVG, WEB): os.makedirs(d, exist_ok=True)
    write(SVG, "unzeen-mark.svg", svg(64, 64, mark("full")))
    write(SVG, "unzeen-mark-simple.svg", svg(64, 64, mark("simple")))
    write(SVG, "unzeen-mark-on-light.svg", svg(64, 64, mark("full")))
    write(SVG, "unzeen-mark-dark.svg", svg(64, 64, mark("full"), bg=INK))
    write(SVG, "unzeen-mark-light.svg", svg(64, 64, mark("full"), bg=LIGHT))
    write(SVG, "favicon.svg", svg(64, 64, fav()))
    write(SVG, "app-icon.svg", svg(512, 512, f'<rect width="512" height="512" fill="{INK}"/><g transform="translate(96 96) scale(5)">{mark("simple")}</g>'))
    write(SVG, "unzeen-lockup-dark.svg", lockup()); write(SVG, "unzeen-lockup-light.svg", lockup(True))
    for lv, sfx in (("full", ""), ("simple", "-small")):
        for nm, col, bg in (("dark", PAPER, INK), ("light", INK, LIGHT)):
            b, W = wordmark(lv, col)
            write(SVG, f"unzeen-wordmark{sfx}-{nm}.svg", svg(int(W), 110, b, bg=bg))
            write(SVG, f"unzeen-wordmark{sfx}-on-{nm}.svg", svg(int(W), 110, b))
    write(SVG, "x-avatar.svg", avatar())
    # banner / OG strips: the dark piece under, the folded tape over (placed by banner-d.html / og.html)
    write(SVG, "strip-banner.svg", svg(940, 220, under(40, 70, 860, 96, 4, "full") + tape(30, 50, 860, 118, -3, "full")))
    # for web/
    b, W = wordmark("simple", "currentColor"); write(WEB, "logo-wordmark.svg", svg(int(W), 110, b))
    write(WEB, "logo-mark.svg", svg(64, 64, mark("simple"))); write(WEB, "logo-mark-full.svg", svg(64, 64, mark("full")))
    write(WEB, "icon.svg", svg(64, 64, fav()))
    # horizontal strips for the peel interaction (rotation is applied in CSS)
    write(WEB, "tape-strip-simple.svg", svg(120, 44, tape(4, 6, 112, 30, 0, "simple")))
    write(WEB, "tape-strip-full.svg", svg(240, 80, tape(6, 10, 228, 56, 0, "full")))
    print("ok")


def ico(pngs, out):
    data = [open(p, "rb").read() for p in pngs]
    sizes = [int(os.path.basename(p).split("-")[-1].split(".")[0]) for p in pngs]
    head = struct.pack("<HHH", 0, 1, len(data)); off = 6 + 16 * len(data); dirs, blobs = b"", b""
    for s, b in zip(sizes, data):
        dirs += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(b), off); off += len(b); blobs += b
    open(out, "wb").write(head + dirs + blobs)


if __name__ == "__main__":
    if sys.argv[1:] == ["ico"]:
        P = os.path.join(OUT, "png"); ico([os.path.join(P, f"favicon-{s}.png") for s in (16, 32, 48)], os.path.join(OUT, "favicon.ico")); print("ico")
    else:
        main()
