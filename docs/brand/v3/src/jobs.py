"""Render jobs for ../../tools/shoot.mjs (all PNG exports of brand v3). Order matters: sheets use earlier PNGs."""
import json, os, re
SRC = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(SRC)
SVG, PNG, X = (os.path.join(OUT, d) for d in ("svg", "png", "x"))
for d in (PNG, X): os.makedirs(d, exist_ok=True)
frame = "file://" + os.path.join(SRC, "frame.html")
u = lambda f, h="": "file://" + os.path.join(SRC, f) + (("#" + h) if h else "")
DIRS = [("a", "proof"), ("b", "root"), ("c", "bite"), ("d", "tape"), ("e", "visor")]
jobs = []
def J(url, w, h, scale, out, t=False): jobs.append({"url": url, "w": w, "h": h, "scale": scale, "out": out, "transparent": t})
for f in sorted(os.listdir(SVG)):
    n = f[:-4]; src = os.path.join(SVG, f)
    vw, vh = map(float, re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', open(src).read()).groups())
    fu = lambda w, h: f"{frame}?src=file://{src}&w={w}&h={h}"
    if "avatar-" in n: continue
    if "favicon" in n:
        for s in (16, 32, 48, 180): J(fu(s, s), s, s, 1, os.path.join(PNG, f"{n}-{s}.png"))
    elif "lockup" in n or "wordmark" in n:
        J(fu(int(vw), int(vh)), int(vw), int(vh), 4, os.path.join(PNG, f"{n}@4x.png"), t="wordmark" in n)
    else:
        J(fu(512, 512), 512, 512, 1, os.path.join(PNG, f"{n}-512.png"), t="transparent" in n)
for k, n in DIRS:
    for s in (1, 2):
        sfx = "@2x" if s == 2 else ""
        J(u("avatar.html", k), 400, 400, s, os.path.join(X, f"avatar-{k}{sfx}.png"))
        J(u("banner.html", k), 1500, 500, s, os.path.join(X, f"banner-{k}{sfx}.png"))
J(u("logos.html"), 1800, 1060, 1, os.path.join(OUT, "logo-sheet.png"))
J(u("preview-profile.html"), 1460, 3080, 1, os.path.join(OUT, "preview-profile.png"))
J(u("preview-safezone.html"), 1600, 2940, 1, os.path.join(OUT, "preview-banner-safezone.png"))
J(u("d2-sheet.html"), 1600, 900, 1, os.path.join(OUT, "d2-sheet.png"))
J(u("overview.html"), 2400, 1800, 1, os.path.join(OUT, "overview.png"))
only = os.environ.get("ONLY")
if only: jobs = [j for j in jobs if re.search(only, j["out"])]
json.dump(jobs, open(os.path.join(SRC, ".jobs.json"), "w"))
print(len(jobs))
