// Builds the extension PNG icons from assets/icon-source.webp.
// Finds the dark rounded square in the sheet, crops it, makes the corners
// transparent and writes 16, 32, 48 and 128 pixel PNGs. Uses the installed
// Chromium (canvas), so no extra packages are needed.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumPath } from "../tests/harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "assets", "icon-source.webp")).toString("base64");
const out = join(root, "extension", "icons");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage();
const result = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/webp;base64,${b64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const { data } = g.getImageData(0, 0, c.width, c.height);
  // The icon is the large dark square in the left half. Count matching pixels per
  // row and column so small dark things (the label text) do not count.
  const rows = new Array(c.height).fill(0);
  const cols = new Array(c.width).fill(0);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width * 0.5; x++) {
      const i = (y * c.width + x) * 4;
      if (data[i] < 60 && data[i + 1] < 64 && data[i + 2] < 70) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  const span = (a) => {
    const idx = a.map((v, i) => (v > 150 ? i : -1)).filter((i) => i >= 0);
    return [idx[0], idx[idx.length - 1]];
  };
  const [y0, y1] = span(rows);
  const [x0, x1] = span(cols);
  const w0 = x1 - x0 + 1;
  const h0 = y1 - y0 + 1;
  const size = Math.min(w0, h0);
  const cx = x0 + Math.floor((w0 - size) / 2);
  const cy = y0 + Math.floor((h0 - size) / 2);
  const render = (n) => {
    const o = document.createElement("canvas");
    o.width = o.height = n;
    const q = o.getContext("2d");
    q.imageSmoothingEnabled = true;
    q.imageSmoothingQuality = "high";
    const r = n * 0.225;
    q.beginPath();
    q.roundRect(0, 0, n, n, r);
    q.clip();
    // Draw in halves for a cleaner downscale.
    let cur = c, cw = size, sx = cx, sy = cy;
    let w = size;
    while (w / 2 > n) {
      const t = document.createElement("canvas");
      w = Math.round(w / 2);
      t.width = t.height = w;
      const tq = t.getContext("2d");
      tq.imageSmoothingQuality = "high";
      tq.drawImage(cur, sx, sy, cw, cw, 0, 0, w, w);
      cur = t; cw = w; sx = 0; sy = 0;
    }
    q.drawImage(cur, sx, sy, cw, cw, 0, 0, n, n);
    return o.toDataURL("image/png").split(",")[1];
  };
  return { box: [x0, y0, x1, y1], png: Object.fromEntries([16, 32, 48, 128].map((n) => [n, render(n)])) };
}, src);
await browser.close();

console.log("icon box", result.box.join(","));
for (const [n, b64] of Object.entries(result.png)) writeFileSync(join(out, `icon${n}.png`), Buffer.from(b64, "base64"));
console.log("icons written");
