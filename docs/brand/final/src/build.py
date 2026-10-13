"""Unzeen final brand set (owner pick 13.10.2026): mark = D tape, wordmark = D2a (tape over the z only: un▬een).
Geometry comes from ../../v3/src/build.py (single source of truth). Run: python build.py, then sh render.sh.
"""
import os, sys, struct
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "v3", "src"))
import build as v3  # noqa: E402
from build import svg, tape_path, wordmark, INK, PAPER, ZEC, LIGHT  # noqa: E402

OUT = os.path.dirname(HERE)
SVG, WEB = os.path.join(OUT, "svg"), os.path.join(OUT, "for-web")


def tape(fill=ZEC, small=False, stroke=None):
    h = 31 if small else 22
    d = tape_path(2, 32 - h / 2, 60, h, teeth=3 if small else 4, tear=8 if small else 6)
    st = f' stroke="{stroke}" stroke-width="1.2" stroke-linejoin="round"' if stroke else ""
    return f'<path transform="rotate(-14 32 32)" d="{d}" fill="{fill}"{st}/>'


def write(d, name, s):
    open(os.path.join(d, name), "w").write(s)


def main():
    for d in (SVG, WEB): os.makedirs(d, exist_ok=True)
    # mark
    write(SVG, "unzeen-mark.svg", svg(64, 64, tape()))                                   # transparent, for dark UI
    write(SVG, "unzeen-mark-on-light.svg", svg(64, 64, tape(stroke=INK)))               # transparent, for light UI
    write(SVG, "unzeen-mark-dark.svg", svg(64, 64, tape(), bg=INK))
    write(SVG, "unzeen-mark-light.svg", svg(64, 64, tape(stroke=INK), bg=LIGHT))
    # favicon: rounded ink tile so the yellow reads on light and dark browser tabs; heavier small-size tape
    fav = svg(64, 64, f'<rect width="64" height="64" rx="12" fill="{INK}"/>' + tape(small=True))
    write(SVG, "favicon.svg", fav)
    # app icon: full-bleed ink square (iOS/Android apply their own mask), mark inside the 80% safe circle
    write(SVG, "app-icon.svg", svg(512, 512, f'<rect width="512" height="512" fill="{INK}"/><g transform="translate(96 96) scale(5)">{tape(small=True)}</g>'))
    # lockup + wordmark (D2a)
    write(SVG, "unzeen-lockup-dark.svg", v3.lockup("d", tv="z"))
    write(SVG, "unzeen-lockup-light.svg", v3.lockup("d", light=True, tv="z"))
    for nm, col, bg in (("unzeen-wordmark-dark", PAPER, INK), ("unzeen-wordmark-light", INK, LIGHT)):
        wm, ww = wordmark("d", 6, 70, 76, col, nm, tv="z")
        write(SVG, nm + ".svg", svg(int(ww + 12), 88, wm, bg=bg))
        write(SVG, nm.replace("-dark", "-on-dark").replace("-light", "-on-light") + ".svg", svg(int(ww + 12), 88, wm))
    # for web/: currentColor letters (follow the theme), yellow tape stays brand yellow
    wm, ww = wordmark("d", 6, 70, 76, "currentColor", "web", tv="z")
    write(WEB, "logo-wordmark.svg", svg(int(ww + 12), 88, wm))
    write(WEB, "logo-mark.svg", svg(64, 64, tape()))
    write(WEB, "icon.svg", fav)
    print("ok")


def ico(pngs, out):
    """Pack PNG files into one .ico (PNG-in-ICO, supported by all current browsers)."""
    data = [open(p, "rb").read() for p in pngs]
    sizes = [int(os.path.basename(p).split("-")[-1].split(".")[0]) for p in pngs]
    head = struct.pack("<HHH", 0, 1, len(data))
    off = 6 + 16 * len(data)
    dirs, blobs = b"", b""
    for s, b in zip(sizes, data):
        dirs += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(b), off)
        off += len(b); blobs += b
    open(out, "wb").write(head + dirs + blobs)


if __name__ == "__main__":
    if sys.argv[1:] == ["ico"]:
        P = os.path.join(OUT, "png")
        ico([os.path.join(P, f"favicon-{s}.png") for s in (16, 32, 48)], os.path.join(OUT, "favicon.ico"))
        print("ico")
    else:
        main()
