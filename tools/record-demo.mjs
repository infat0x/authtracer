// Builds the README demo GIF from a scripted walkthrough against a local
// fixture page, using only synthetic, clearly fake credentials. A synthetic
// cursor glides to each control and clicks it, so the GIF reads as a real
// interaction instead of a slideshow of static states.
// Run with: node tools/record-demo.mjs
import { PNG } from "pngjs";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { launch, stageExtension } from "../tests/harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "assets", "demo.gif");

// A believable but obviously fake site, for a clean looking demo.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Acme Portal</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="%23314b6e"/></svg>'
)}">
</head><body><h1>Acme Portal</h1><p>Demo fixture for the AuthTracer README.</p></body></html>`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const DEMO_JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
  sub: "demo_user",
  role: "admin",
  exp: Math.floor(Date.now() / 1000) + 3600
})}.demo_signature_not_real`;

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api")) {
      res.setHeader("Set-Cookie", "session_id=demo_8f2a1c9d3b7e; Path=/; HttpOnly");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

// ---- Synthetic cursor -----------------------------------------------------

async function injectCursor(pop, startX, startY) {
  await pop.evaluate(
    ({ x, y }) => {
      const cur = document.createElement("div");
      cur.id = "__demo_cursor__";
      cur.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:22px;height:22px;z-index:999999;pointer-events:none;margin:0;`;
      cur.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 18 L6.5 14.3 L9.5 20.3 L12.8 18.7 L9.8 12.8 L17 12.4 Z" fill="#f3f4f6" stroke="#15161a" stroke-width="1.2" stroke-linejoin="round"/></svg>';
      document.body.appendChild(cur);

      const ripple = document.createElement("div");
      ripple.id = "__demo_ripple__";
      ripple.style.cssText =
        "position:fixed;left:0;top:0;width:30px;height:30px;border-radius:999px;background:rgba(148,209,171,0.55);border:1px solid rgba(148,209,171,0.9);z-index:999998;pointer-events:none;opacity:0;transform:translate(-50%,-50%) scale(0.4);";
      document.body.appendChild(ripple);
    },
    { x: startX, y: startY }
  );
}

async function setCursor(pop, x, y) {
  await pop.evaluate(
    ({ x, y }) => {
      const cur = document.getElementById("__demo_cursor__");
      if (cur) {
        cur.style.left = `${x}px`;
        cur.style.top = `${y}px`;
      }
    },
    { x, y }
  );
}

async function setRipple(pop, x, y, visible) {
  await pop.evaluate(
    ({ x, y, visible }) => {
      const r = document.getElementById("__demo_ripple__");
      if (!r) return;
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      r.style.opacity = visible ? "1" : "0";
      r.style.transform = `translate(-50%,-50%) scale(${visible ? 1 : 0.4})`;
    },
    { x, y, visible }
  );
}

// Glides the cursor toward a target, taking a frame at every step, with an
// ease-out curve so the motion feels natural rather than linear.
async function glideTo(pop, shot, from, to, steps = 10, holdMs = 35) {
  for (let i = 1; i <= steps; i++) {
    const t = 1 - Math.pow(1 - i / steps, 3);
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    await setCursor(pop, x, y);
    await shot(holdMs);
  }
  return to;
}

// Moves to a locator's center, shows a click ripple, performs the real click,
// then settles. Returns the point clicked, so the next move can start there.
async function clickAt(pop, shot, cursorAt, locator, { settleMs = 90, afterMs = 1100 } = {}) {
  const box = await locator.boundingBox();
  const target = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 14) };
  const at = await glideTo(pop, shot, cursorAt, target);

  await setRipple(pop, at.x, at.y, true);
  await shot(settleMs);
  await locator.click();
  await pop.waitForTimeout(80);
  await setRipple(pop, at.x, at.y, false);
  await shot(afterMs);
  return at;
}

// ---- The walkthrough -------------------------------------------------------

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;

  const { ctx, sw, id } = await launch(stageExtension(true));
  await sw.evaluate(() => chrome.storage.local.set({ capture: true, onboarded: true }));

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 820, height: 560 });
  await page.goto(`${origin}/`);
  const tabId = await sw.evaluate(
    async (p) => (await chrome.tabs.query({})).find((t) => (t.url || "").startsWith(p))?.id,
    origin
  );

  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 540, height: 940 }); // popup body is 520px wide
  await pop.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
  await pop.waitForSelector("#enable");

  const frames = [];
  const shot = async (holdMs) => frames.push({ buf: await pop.screenshot({ type: "png" }), holdMs });

  let cursorAt = { x: 490, y: 30 };
  await injectCursor(pop, cursorAt.x, cursorAt.y);
  await shot(700); // idle, cursor resting in the corner

  cursorAt = await clickAt(pop, shot, cursorAt, pop.locator("#enable"), { afterMs: 650 });

  await page.evaluate(
    (u) =>
      fetch(u, {
        headers: {
          Authorization: `Bearer ${"demo_access_token_7f3a91c2d4e5b8c1d2e3f4a5b6c7d8e9"}`,
          "X-API-Key": "demo_api_key_55aa66bb77cc"
        }
      }),
    `${origin}/api`
  );
  await pop.waitForTimeout(600);
  await shot(900); // signals start appearing

  await page.evaluate(
    ({ u, jwt }) => fetch(u, { headers: { "X-Id-Token": jwt, "X-CSRF-Token": "demo_csrf_99ee88dd77" } }),
    { u: `${origin}/api`, jwt: DEMO_JWT }
  );
  await pop.waitForTimeout(700);
  await shot(900); // full set of signals, quick read visible

  const authRow = pop.locator("summary.rowhead").filter({ hasText: "Authorization" }).first();
  if (await authRow.count()) {
    cursorAt = await clickAt(pop, shot, cursorAt, authRow, { afterMs: 850 });
    const copyBtn = pop.locator('button[aria-label="Copy value of Authorization"]').first();
    if (await copyBtn.count()) {
      cursorAt = await clickAt(pop, shot, cursorAt, copyBtn, { afterMs: 900 }); // shows the "Copied." toast
    }
  }

  const menuBtn = pop.locator("#export-menu");
  if (await menuBtn.count()) {
    cursorAt = await clickAt(pop, shot, cursorAt, menuBtn, { afterMs: 1000 });
    const jsonItem = pop.locator("#copy-json");
    if (await jsonItem.count()) {
      cursorAt = await clickAt(pop, shot, cursorAt, jsonItem, { afterMs: 1300 }); // "Copied as JSON" toast, menu closes
    }
  }

  await ctx.close();
  server.close();

  await encodeGif(frames, OUT);
  console.log(`Wrote ${OUT} (${frames.length} frames)`);
}

async function encodeGif(frames, outPath) {
  const first = PNG.sync.read(frames[0].buf);
  const { width, height } = first;
  const gif = GIFEncoder();
  for (const { buf, holdMs } of frames) {
    const png = PNG.sync.read(buf);
    const palette = quantize(png.data, 256);
    const index = applyPalette(png.data, palette);
    gif.writeFrame(index, width, height, { palette, delay: holdMs, transparent: false });
  }
  gif.finish();
  writeFileSync(outPath, Buffer.from(gif.bytes()));
}

main();
