// Offline renderer for brand assets: HTML/SVG -> PNG with puppeteer-core + system Chrome.
// Usage: node shoot.mjs jobs.json
//   jobs.json: [{ "url": "file:///abs/page.html#a", "w": 400, "h": 400, "scale": 1, "out": "/abs/out.png", "transparent": false }]
// puppeteer-core is not a repo dependency: `npm i puppeteer-core` anywhere and point PUPPETEER_CORE at it,
// e.g. PUPPETEER_CORE=/path/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js
// Every non-file:// request is aborted, so nothing leaves the machine (fonts are local woff2).
import { readFileSync } from "node:fs";
const mod = await import(process.env.PUPPETEER_CORE || "puppeteer-core");
const puppeteer = mod.default ?? mod;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--allow-file-access-from-files", "--disable-gpu"] });
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on("request", (r) => (r.url().startsWith("file:") || r.url().startsWith("data:") ? r.continue() : r.abort()));
for (const j of jobs) {
  await page.setViewport({ width: j.w, height: j.h, deviceScaleFactor: j.scale ?? 1 });
  await page.goto("about:blank");
  await page.goto(j.url, { waitUntil: "load" });
  await page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => setTimeout(r, 60)); });
  await page.screenshot({ path: j.out, omitBackground: !!j.transparent, clip: { x: 0, y: 0, width: j.w, height: j.h } });
  console.log(j.out.split("/").slice(-2).join("/"));
}
await browser.close();
