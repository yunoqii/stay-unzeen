"""Render jobs for ../../tools/shoot.mjs (brand v4)."""
import json, os
SRC = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(SRC)
SVG, PNG, X = (os.path.join(OUT, d) for d in ("svg", "png", "x"))
for d in (PNG, X): os.makedirs(d, exist_ok=True)
dirs = json.load(open(os.path.join(SRC, "dirs.json")))
open(os.path.join(SRC, "dirs.js"), "w").write("window.DIRS = " + json.dumps(dirs) + ";\n")
frame = "file://" + os.path.join(SRC, "frame.html")
u = lambda f: "file://" + os.path.join(SRC, f)
def J(f, w, h, scale, out, t=False):
    return {"url": f"{frame}?src=file://{os.path.join(SVG, f)}&w={w}&h={h}", "w": w, "h": h, "scale": scale, "out": out, "transparent": t}
import re
jobs = []
for d in dirs:
    k = d["k"]
    jobs += [J(f"{k}-favicon.svg", s, s, 1, os.path.join(PNG, f"{k}-favicon-{s}.png"), True) for s in (16, 32, 48)]
    jobs += [J(f"{k}-mark.svg", 512, 512, 1, os.path.join(PNG, f"{k}-mark-512.png"), True)]
    for f in (f"{k}-lockup.svg", f"{k}-wordmark.svg"):
        w, h = (int(float(v)) for v in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', open(os.path.join(SVG, f)).read()).groups())
        jobs.append(J(f, w, h, 3, os.path.join(PNG, f[:-4] + "@3x.png"), "wordmark" in f))
    jobs += [J(f"{k}-avatar.svg", 400, 400, s, os.path.join(X, f"avatar-{k}{'@2x' if s == 2 else ''}.png")) for s in (1, 2)]
jobs += [{"url": u("overview.html"), "w": 2200, "h": 1640, "scale": 1, "out": os.path.join(OUT, "overview.png")},
         {"url": u("with-banner.html"), "w": 2000, "h": 1720, "scale": 1, "out": os.path.join(OUT, "with-banner.png")},
         {"url": u("peel.html") + "#still", "w": 1200, "h": 520, "scale": 1, "out": os.path.join(OUT, "peel-still.png")}]
json.dump(jobs, open(os.path.join(SRC, ".jobs.json"), "w")); print(len(jobs))
