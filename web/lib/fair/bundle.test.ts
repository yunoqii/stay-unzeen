// The sealed-bid launch must not ship in the code every visitor loads (CLAUDE.md: no fair-launch
// details public before 28.10; the public deploy runs with the server flag off). Checks a finished
// `next build` in .next:
//   - initial chunks of every route (client reference manifests + root main files) carry no marker;
//   - markers appear only in lazy chunks (react-loadable manifests), i.e. code requested only when
//     the server reports the feature on;
//   - with NEXT_PUBLIC_FAIR_LAUNCH_BUILD=0 at build time and CHECK_SEALED_STRICT=1 here: no chunk at all.
// Run after a build: `pnpm test:bundle`. Skipped when there is no build. Run it with the same
// NEXT_PUBLIC_MOCK_FAIR_LAUNCH as the build.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const NEXT = path.resolve(import.meta.dirname, "../../.next");
const built = existsSync(path.join(NEXT, "build-manifest.json")) && existsSync(path.join(NEXT, "server/app"));

const MARKERS = ["drand", "tlock", "age-encryption", "/api/launches", "fl_create", "fl_bid", "fl_cancel", "launch_closed", "already_bid", "bad_ciphertext", "Fair launch", "Sealed-bid", "sealed bid", "Seal bid", "UZFL"];

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, match, out);
    else if (match(n)) out.push(p);
  }
  return out;
}

const chunkRe = /static\/chunks\/[A-Za-z0-9_.~-]+\.js/g;
const chunksIn = (text: string) => new Set([...text.matchAll(chunkRe)].map((m) => m[0]));
const read = (rel: string) => readFileSync(path.join(NEXT, rel), "utf8");
// A mock build with NEXT_PUBLIC_MOCK_FAIR_LAUNCH=1 (never a public deploy) routes /api/launches and
// fl_* in the in-browser mock itself; only those two route strings are tolerated there.
const MOCK_ON = process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH === "1";
const ROUTER_ONLY = new Set(["/api/launches", "fl_create", "fl_bid", "fl_cancel"]);
const markersIn = (rel: string, initialChunk = false) => {
  const s = read(rel);
  return MARKERS.filter((m) => s.includes(m) && !(initialChunk && MOCK_ON && ROUTER_ONLY.has(m)));
};

describe.skipIf(!built)("sealed-bid launch stays out of the main bundle (.next)", () => {
  const manifests = built ? walk(path.join(NEXT, "server/app"), (f) => f === "page_client-reference-manifest.js") : [];
  const initial = new Set<string>();
  if (built) {
    const bm = JSON.parse(read("build-manifest.json")) as { rootMainFiles: string[]; polyfillFiles: string[] };
    for (const f of [...bm.rootMainFiles, ...bm.polyfillFiles]) initial.add(f);
    for (const m of manifests) for (const c of chunksIn(readFileSync(m, "utf8"))) initial.add(c);
  }

  it("found the routes", () => {
    expect(manifests.some((m) => m.includes(`${path.sep}launch${path.sep}`))).toBe(true);
    expect(initial.size).toBeGreaterThan(5);
  });

  it("no initial chunk of any route mentions it", () => {
    const hits = [...initial].filter((c) => existsSync(path.join(NEXT, c))).map((c) => [c, markersIn(c, true)] as const).filter(([, m]) => m.length);
    expect(hits).toEqual([]);
  });

  it("prerendered HTML does not mention it", () => {
    const html = walk(path.join(NEXT, "server/app"), (f) => f.endsWith(".html"));
    const hits = html.map((h) => [path.relative(NEXT, h), MARKERS.filter((m) => readFileSync(h, "utf8").includes(m))] as const).filter(([, m]) => m.length);
    expect(hits).toEqual([]);
  });

  it("any chunk that does mention it is lazy (react-loadable manifest only)", () => {
    const all = readdirSync(path.join(NEXT, "static/chunks")).filter((f) => f.endsWith(".js")).map((f) => `static/chunks/${f}`);
    const marked = all.filter((c) => markersIn(c, initial.has(c)).length > 0);
    const lazy = new Set<string>();
    for (const m of walk(path.join(NEXT, "server/app"), (f) => f === "react-loadable-manifest.json")) for (const c of chunksIn(readFileSync(m, "utf8"))) lazy.add(c);
    // Chunks reached only through import() inside a lazy chunk are not in any manifest: they must at
    // least not be initial.
    for (const c of marked) expect(initial.has(c), c).toBe(false);
    if (process.env.CHECK_SEALED_STRICT === "1") expect(marked).toEqual([]);
    else expect(marked.some((c) => lazy.has(c)) || marked.length === 0).toBe(true);
  });
});
