"""Render jobs for ../../tools/shoot.mjs (final brand set)."""
import json, os, re
SRC = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(SRC)
SVG, PNG = os.path.join(OUT, "svg"), os.path.join(OUT, "png"); os.makedirs(PNG, exist_ok=True)
frame = "file://" + os.path.join(SRC, "frame.html")
def J(svgf, w, h, scale, out, t=False):
    return {"url": f"{frame}?src=file://{os.path.join(SVG, svgf)}&w={w}&h={h}", "w": w, "h": h, "scale": scale, "out": os.path.join(PNG, out), "transparent": t}
vb = lambda f: tuple(int(float(x)) for x in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', open(os.path.join(SVG, f)).read()).groups())
jobs = [J("favicon.svg", s, s, 1, f"favicon-{s}.png", True) for s in (16, 32, 48)]
jobs += [J("app-icon.svg", 180, 180, 1, "apple-touch-icon-180.png"), J("app-icon.svg", 512, 512, 1, "app-icon-512.png"),
         J("app-icon.svg", 512, 512, 2, "app-icon-512@2x.png"), J("app-icon.svg", 192, 192, 1, "app-icon-192.png")]
jobs += [J("unzeen-mark.svg", 512, 512, 1, "unzeen-mark-512.png", True), J("unzeen-mark-dark.svg", 512, 512, 1, "unzeen-mark-dark-512.png"),
         J("unzeen-mark-light.svg", 512, 512, 1, "unzeen-mark-light-512.png")]
for f in ("unzeen-lockup-dark", "unzeen-lockup-light", "unzeen-wordmark-dark", "unzeen-wordmark-light", "unzeen-wordmark-on-dark", "unzeen-wordmark-on-light"):
    w, h = vb(f + ".svg"); jobs.append(J(f + ".svg", w, h, 4, f + "@4x.png", "-on-" in f))
og = "file://" + os.path.join(SRC, "og.html")
jobs += [{"url": og, "w": 1200, "h": 630, "scale": 1, "out": os.path.join(OUT, "og.png")},
         {"url": og, "w": 1200, "h": 630, "scale": 1, "out": os.path.join(OUT, "og.jpg")},
         {"url": og, "w": 1200, "h": 630, "scale": 2, "out": os.path.join(OUT, "og@2x.png")},
         {"url": "file://" + os.path.join(SRC, "sheet.html"), "w": 1600, "h": 1180, "scale": 1, "out": os.path.join(OUT, "sheet.png")}]
json.dump(jobs, open(os.path.join(SRC, ".jobs.json"), "w")); print(len(jobs))
