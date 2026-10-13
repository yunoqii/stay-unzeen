"""Unzeen tape kit: redaction / masking tape as a flat vector illustration (owner brief 13.10: folds, crepe texture,
lighter edges, a curled corner, a shadow step, an expressive torn edge). Three tones of the Zcash yellow only.

tape(x, y, w, h, rot, level) -> SVG string. The strip is drawn horizontal at (x, y, w, h), then rotated about its centre.
  level "full"   - banner, OG, big logo: texture, edge light, 2 creases + a pinch, curl, step, 3 irregular teeth
  level "simple" - favicon, avatar 32-48px: step, curl, one crease line, 2 big teeth. Nothing thinner than ~1/14 h
  level "flat"   - the previous flat strip, for comparison
"""
ZEC, ZEC_LT, ZEC_DK = "#F4B728", "#F8CA5C", "#D99E17"   # base, +12% light, -12% dark
UNDER, STEP = "#B98410", "#7A560A"                         # curl underside (-25%), shadow step / tape thickness

_ID = [0]


def _uid():
    _ID[0] += 1
    return f"tp{_ID[0]}"


def outline_pts(x, y, w, h, level, curl):
    """Strip outline: torn right end (irregular), torn-ish left end, top-left corner cut where the curl folds."""
    if level == "flat":
        n, depth = 3, [1, .3, 1, .3, 1, .3]
    elif level == "simple":
        n, depth = 2, [1, .25, 1, .25]
    else:
        n, depth = 3, [1, .35, .75, .15, .95, .4]
    tear = h * (0.32 if level == "flat" else 0.42 if level == "simple" else 0.36)
    pts = [(x + curl, y), (x + w, y)]
    step = h / n
    for i in range(n):
        pts.append((x + w - tear * depth[2 * i], y + step * (i + 0.5)))
        pts.append((x + w - tear * (depth[2 * i + 1] if i < n - 1 else 0), y + step * (i + 1)))
    pts.append((x, y + h))
    if level != "flat":  # left end: a shallower tear so both ends read as torn by hand
        lt = h * 0.18
        k = [.6, .1, .9, .3] if level == "full" else [.8, .2]
        m = len(k)
        for i in range(m):
            yy = y + h - (h - curl) * (i + 1) / (m + 1)
            pts.append((x + lt * k[i], yy))
    pts.append((x, y + curl) if curl else (x, y))
    return pts


def path(pts):
    return "M" + " L".join(f"{a:.2f},{b:.2f}" for a, b in pts) + "Z"


def tape(x, y, w, h, rot=-20, level="full", ground=None, step=True):
    cx, cy = x + w / 2, y + h / 2
    if level == "flat":
        return f'<path transform="rotate({rot} {cx} {cy})" d="{path(outline_pts(x, y, w, h, "flat", 0))}" fill="{ZEC}"/>'
    curl = h * (0.42 if level == "simple" else 0.36)
    d = path(outline_pts(x, y, w, h, level, curl))
    uid = _uid()
    out = [f'<g transform="rotate({rot} {cx} {cy})">']
    if step:  # the tape lies on top: a darker step under its lower edge (reads on dark and on light grounds)
        out.append(f'<path d="{d}" fill="{STEP}" transform="translate({h*0.05:.2f} {h*0.11:.2f})"/>')
    out.append(f'<path d="{d}" fill="{ZEC}"/>')
    out.append(f'<clipPath id="{uid}"><path d="{d}"/></clipPath><g clip-path="url(#{uid})">')
    if level == "full":
        # crepe texture: fine transverse ribs
        sp = max(h * 0.085, 1.2)
        ribs = "".join(f"M{x + i * sp:.2f},{y} l{h*0.04:.2f},{h}" for i in range(int(w / sp) + 1))
        out.append(f'<path d="{ribs}" stroke="{ZEC_DK}" stroke-width="{max(h*0.012, .35):.2f}" opacity=".22" fill="none"/>')
        # translucent, lighter long edges
        e = h * 0.075
        out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{e:.2f}" fill="{ZEC_LT}" opacity=".9"/>')
        out.append(f'<rect x="{x}" y="{y + h - e:.2f}" width="{w}" height="{e:.2f}" fill="{ZEC_LT}" opacity=".9"/>')
        # two creases: a dark fold line with a light ridge beside it, plus a soft dark wedge
        for fx, sk, wd in ((0.38, -0.14, 1.0), (0.7, 0.1, 0.8)):
            x0 = x + w * fx
            out.append(f'<path d="M{x0:.2f},{y} L{x0 + h*sk*2 - h*0.05:.2f},{y+h}" stroke="{ZEC_DK}" stroke-width="{h*0.035:.2f}" fill="none"/>')
            out.append(f'<path d="M{x0 + h*0.045:.2f},{y} L{x0 + h*sk*2:.2f},{y+h}" stroke="{ZEC_LT}" stroke-width="{h*0.03:.2f}" fill="none"/>')
    else:
        # one crease, thick enough for 32px
        x0 = x + w * 0.56
        out.append(f'<path d="M{x0:.2f},{y} L{x0 - h*0.28:.2f},{y+h}" stroke="{ZEC_DK}" stroke-width="{h*0.11:.2f}" fill="none"/>')
    out.append("</g>")
    # curled corner: the top-left corner folded back over the tape, underside showing
    c = curl
    out.append(f'<path d="M{x + c:.2f},{y} L{x:.2f},{y + c:.2f} L{x + c*0.92:.2f},{y + c*0.92:.2f}Z" fill="{UNDER}"/>')
    if level == "full":
        out.append(f'<path d="M{x + c:.2f},{y} L{x + c*0.92:.2f},{y + c*0.92:.2f}" stroke="{ZEC_LT}" stroke-width="{h*0.025:.2f}"/>')
    out.append("</g>")
    return "".join(out)


DARK, DARK_LT, DARK_DK = "#34343B", "#44444C", "#232328"   # the second, dark piece (reads on #0B0B0D, never pure black)


def under(x, y, w, h, rot=14, level="full"):
    """The second piece: a dark strip under the yellow one, crossed at another angle. Same torn language, one crease."""
    cx, cy = x + w / 2, y + h / 2
    pts = outline_pts(x, y, w, h, "simple" if level != "full" else "full", 0)
    d = path(pts)
    uid = _uid()
    o = [f'<g transform="rotate({rot} {cx} {cy})"><path d="{d}" fill="{DARK}"/>',
         f'<clipPath id="{uid}"><path d="{d}"/></clipPath><g clip-path="url(#{uid})">']
    if level == "full":
        e = h * 0.08
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{e:.2f}" fill="{DARK_LT}"/>')
    x0 = x + w * 0.42
    o.append(f'<path d="M{x0:.2f},{y} L{x0 + h*0.25:.2f},{y+h}" stroke="{DARK_DK}" stroke-width="{h*0.09:.2f}" fill="none"/>')
    o.append(f'<path d="M{x0 + h*0.08:.2f},{y} L{x0 + h*0.33:.2f},{y+h}" stroke="{DARK_LT}" stroke-width="{h*0.04:.2f}" fill="none"/>')
    o.append("</g></g>")
    return "".join(o)


def pair(x, y, w, h, level="full", rot=-20, urot=12, under_scale=0.9):
    """The chosen sign: the dark piece first, then the folded yellow tape over it."""
    uh = h * under_scale
    return under(x - w * 0.02, y + (h - uh) / 2 + h * 0.08, w * 1.0, uh, urot, level) + tape(x, y, w, h, rot, level)
