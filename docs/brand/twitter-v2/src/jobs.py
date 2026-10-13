"""Render jobs for ../../tools/shoot.mjs."""
import json, os
SRC = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.dirname(SRC)
u = lambda f, h="": "file://" + os.path.join(SRC, f) + (("#" + h) if h else "")
jobs = []
for v in "123":
    jobs += [{"url": u("avatar.html", v), "w": 400, "h": 400, "scale": s, "out": os.path.join(OUT, f"avatar-{v}{'@2x' if s == 2 else ''}.png")} for s in (1, 2)]
    jobs += [{"url": u("banner.html", v), "w": 1500, "h": 500, "scale": s, "out": os.path.join(OUT, f"banner-{v}{'@2x' if s == 2 else ''}.png")} for s in (1, 2)]
jobs += [{"url": u("preview-avatar.html"), "w": 1560, "h": 820, "scale": 1, "out": os.path.join(OUT, "preview-avatar-circle.png")},
         {"url": u("preview-safezone.html"), "w": 1600, "h": 1760, "scale": 1, "out": os.path.join(OUT, "preview-banner-safezone.png")},
         {"url": u("preview-profile.html"), "w": 1460, "h": 1880, "scale": 1, "out": os.path.join(OUT, "preview-profile.png")}]
json.dump(jobs, open(os.path.join(SRC, ".jobs.json"), "w"))
