"""Emit render jobs for ../tools/shoot.mjs (all PNG exports of the logo system)."""
import json, os, re
SRC = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(SRC)
SVG, PNG = os.path.join(OUT, "svg"), os.path.join(OUT, "png")
os.makedirs(PNG, exist_ok=True)
frame = "file://" + os.path.join(SRC, "frame.html")
jobs = []
def j(svg, w, h, scale, out, t=False):
    jobs.append({"url": f"{frame}?src=file://{os.path.join(SVG, svg)}&w={w}&h={h}", "w": w, "h": h, "scale": scale, "out": os.path.join(PNG, out), "transparent": t})
for f in sorted(os.listdir(SVG)):
    n = f[:-4]
    vw, vh = map(float, re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', open(os.path.join(SVG, f)).read()).groups())
    if "favicon" in n:
        for s in (16, 32, 48, 180): j(f, s, s, 1, f"{n}-{s}.png", t=(s != 180))
    elif "app-512" in n:
        j(f, 512, 512, 1, f"{n}.png"); j(f, 512, 512, 2, f"{n}@2x.png")
    elif "transparent" in n:
        j(f, 512, 512, 1, f"{n}-512.png", t=True)
    elif "lockup" in n:
        j(f, int(vw), int(vh), 4, f"{n}@4x.png")
    else:
        j(f, 512, 512, 1, f"{n}-512.png")
jobs.append({"url": "file://" + os.path.join(SRC, "sheet.html"), "w": 1600, "h": 1080, "scale": 1, "out": os.path.join(OUT, "logo-sheet.png")})
json.dump(jobs, open(os.path.join(SRC, ".jobs.json"), "w"))
print(len(jobs))
