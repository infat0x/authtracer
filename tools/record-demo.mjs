// Builds the README demo GIF: a fake Mac style browser window opens, a
// synthetic cursor clicks the AuthTracer toolbar icon, the camera zooms in
// on the popup that drops down, and the rest is the same scripted
// walkthrough as before (clicks, scrolling, toasts), against a local
// fixture page and using only synthetic, clearly fake credentials.
// Run with: node tools/record-demo.mjs
import { PNG } from "pngjs";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { launch, stageExtension } from "../tests/harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "assets", "demo.gif");
const ICON_DATA_URL = `data:image/png;base64,${readFileSync(join(root, "extension", "icons", "icon32.png")).toString("base64")}`;

// The captured canvas, the fake browser window on it, and the popup that
// drops down from the toolbar icon once clicked.
const STAGE = { width: 1180, height: 700 };
const BROWSER = { width: 1080, height: 620, top: 36, toolbar: 46 };
const WINDOW = { width: 460, height: 520, titlebar: 32 };
const ZOOM_SCALE = 1.32;

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

// ---- The fake browser window, toolbar and popup dropdown -------------------

// Builds, on the popup's own page, a wide "camera" scene: a Mac style browser
// window with an address bar and a toolbar icon, and (hidden at first) the
// popup's real content staged as a dropdown under that icon. Nothing in the
// extension's own CSS or markup is touched, it is only relocated on screen.
async function buildScene(pop, origin) {
  await pop.addStyleTag({
    content: `
      html { background: transparent !important; }
      body {
        box-sizing: border-box !important;
        width: ${STAGE.width}px !important;
        min-width: 0 !important;
        max-width: none !important;
        height: ${STAGE.height}px !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: radial-gradient(ellipse at 50% 42%, #343a46 0%, #15161a 68%) !important;
        font: 14px/1.5 system-ui, sans-serif !important;
      }
      #__demo_zoom__ { position: absolute; inset: 0; transform-origin: 0 0; }
      #__demo_browser__ {
        position: absolute;
        left: ${(STAGE.width - BROWSER.width) / 2}px;
        top: ${BROWSER.top}px;
        width: ${BROWSER.width}px;
        height: ${BROWSER.height}px;
        border-radius: 12px;
        overflow: hidden;
        background: #f4f5f7;
        box-shadow: 0 26px 54px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05);
        transition: opacity 260ms ease;
      }
      #__demo_toolbar__ {
        height: ${BROWSER.toolbar}px;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 0 14px;
        background: #24272c;
        border-bottom: 1px solid #31353c;
      }
      #__demo_toolbar__ .dots { display: flex; gap: 8px; flex: none; }
      #__demo_toolbar__ .dots i { width: 12px; height: 12px; border-radius: 50%; display: block; }
      #__demo_addr {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        padding: 0 12px;
        border-radius: 999px;
        background: #1b1d21;
        color: #9aa0a8;
        font-size: 12px;
        font-family: ui-monospace, Consolas, monospace;
      }
      #__demo_icons { flex: none; display: flex; align-items: center; gap: 10px; }
      #__demo_icons .ph { width: 20px; height: 20px; border-radius: 5px; background: #3a3e45; }
      #__demo_icons .ext { width: 24px; height: 24px; border-radius: 6px; display: block; cursor: pointer; }
      #__demo_page { padding: 40px 48px; color: #1c1f24; }
      #__demo_page h1 { font-size: 26px; margin: 0 0 10px; }
      #__demo_page p { margin: 0; color: #5b6269; font-size: 14px; }

      #__demo_window__ {
        position: absolute;
        width: ${WINDOW.width}px;
        height: ${WINDOW.height}px;
        border-radius: 10px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        background: #1b1d21;
        box-shadow: 0 20px 44px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
        opacity: 0;
        transform: translateY(-6px);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      #__demo_window__.open { opacity: 1; transform: translateY(0); }
      #__demo_titlebar__ {
        flex: none;
        height: ${WINDOW.titlebar}px;
        display: flex;
        align-items: center;
        padding: 0 12px;
        background: #24272c;
        border-bottom: 1px solid #31353c;
        font: 600 11px system-ui, sans-serif;
        color: #8a8f98;
      }
      #__demo_content__ {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        width: 100%;
      }
      #__demo_content__ > * { width: 100% !important; }
    `
  });

  await pop.evaluate(
    ({ host, iconUrl, win, browser }) => {
      const zoom = document.createElement("div");
      zoom.id = "__demo_zoom__";

      const browserEl = document.createElement("div");
      browserEl.id = "__demo_browser__";
      const toolbar = document.createElement("div");
      toolbar.id = "__demo_toolbar__";
      toolbar.innerHTML = `
        <div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
        <div id="__demo_addr">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
          <span>${host}</span>
        </div>
        <div id="__demo_icons">
          <span class="ph"></span><span class="ph"></span>
          <img class="ext" id="__demo_ext_icon__" src="${iconUrl}" alt="">
        </div>`;
      const pageEl = document.createElement("div");
      pageEl.id = "__demo_page";
      pageEl.innerHTML = "<h1>Acme Portal</h1><p>Demo fixture for the AuthTracer README.</p>";
      browserEl.append(toolbar, pageEl);

      // The popup's own content, moved here wholesale, anchored like a real
      // dropdown just under the toolbar icon.
      const kids = [...document.body.children].filter((k) => k !== zoom);
      const winEl = document.createElement("div");
      winEl.id = "__demo_window__";
      const iconRect = { top: browser.top + browser.toolbar, right: (window.innerWidth - browser.left - browser.width) + 16 };
      winEl.style.top = `${iconRect.top + 8}px`;
      winEl.style.right = `${iconRect.right}px`;
      const bar = document.createElement("div");
      bar.id = "__demo_titlebar__";
      bar.textContent = "AuthTracer";
      const content = document.createElement("div");
      content.id = "__demo_content__";
      for (const k of kids) content.appendChild(k);
      winEl.append(bar, content);

      zoom.append(browserEl, winEl);
      document.body.appendChild(zoom);
    },
    {
      host: new URL(origin).host,
      iconUrl: ICON_DATA_URL,
      win: WINDOW,
      browser: { top: BROWSER.top, left: (STAGE.width - BROWSER.width) / 2, width: BROWSER.width, toolbar: BROWSER.toolbar }
    }
  );
}

async function openDropdown(pop) {
  await pop.evaluate(() => document.getElementById("__demo_window__")?.classList.add("open"));
  await pop.waitForTimeout(200); // real time for the CSS entrance transition to finish
}

async function fadeBrowser(pop) {
  await pop.evaluate(() => {
    const b = document.getElementById("__demo_browser__");
    if (b) b.style.opacity = "0";
  });
  await pop.waitForTimeout(300); // real time for the CSS fade to finish
}

async function scrollContentTo(pop, locator) {
  if (await locator.count()) {
    await locator.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await pop.waitForTimeout(60);
  }
}

async function scrollContentToBottom(pop) {
  await pop.evaluate(() => {
    const c = document.getElementById("__demo_content__");
    if (c) c.scrollTop = c.scrollHeight;
  });
  await pop.waitForTimeout(60);
}

// ---- Camera: zooms the whole scene toward a fixed content space point -----

async function setZoom(pop, scale, point) {
  await pop.evaluate(
    ({ scale, point, center }) => {
      const z = document.getElementById("__demo_zoom__");
      if (!z) return;
      const tx = center.x - point.x * scale;
      const ty = center.y - point.y * scale;
      z.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    },
    { scale, point, center: { x: STAGE.width / 2, y: STAGE.height / 2 } }
  );
}

async function zoomTo(pop, shot, point, fromScale, toScale, steps = 16, holdMs = 45) {
  for (let i = 1; i <= steps; i++) {
    const t = 1 - Math.pow(1 - i / steps, 2);
    await setZoom(pop, fromScale + (toScale - fromScale) * t, point);
    await shot(holdMs);
  }
}

// ---- Synthetic cursor -------------------------------------------------------
// Kept as a direct child of <body>, outside the zoom wrapper, so it always
// stays in real viewport coordinates while the scene underneath it zooms.

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
  await pop.evaluate(({ x, y }) => {
    const cur = document.getElementById("__demo_cursor__");
    if (cur) {
      cur.style.left = `${x}px`;
      cur.style.top = `${y}px`;
    }
  }, { x, y });
}

async function setRipple(pop, x, y, visible) {
  await pop.evaluate(({ x, y, visible }) => {
    const r = document.getElementById("__demo_ripple__");
    if (!r) return;
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    r.style.opacity = visible ? "1" : "0";
    r.style.transform = `translate(-50%,-50%) scale(${visible ? 1 : 0.4})`;
  }, { x, y, visible });
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

// Scrolls the target into view, moves to it, shows a click ripple, performs
// the real click, then settles. Returns the point clicked, so the next move
// can start there.
async function clickAt(pop, shot, cursorAt, locator, { settleMs = 90, afterMs = 1100, scroll = true } = {}) {
  if (scroll) await scrollContentTo(pop, locator);
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
  await pop.setViewportSize(STAGE);
  await pop.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
  await pop.waitForSelector("#enable");
  await buildScene(pop, origin);

  const frames = [];
  const shot = async (holdMs) => frames.push({ buf: await pop.screenshot({ type: "png" }), holdMs });

  // Establishing shot: the browser window, nothing happening yet.
  let cursorAt = { x: STAGE.width * 0.18, y: STAGE.height * 0.82 };
  await injectCursor(pop, cursorAt.x, cursorAt.y);
  await shot(900);

  // Glide to the toolbar icon and click it.
  const extIcon = pop.locator("#__demo_ext_icon__");
  cursorAt = await clickAt(pop, shot, cursorAt, extIcon, { scroll: false, settleMs: 90, afterMs: 60 });
  await openDropdown(pop);
  await shot(500); // the dropdown appears under the icon

  // Zoom the camera in on the dropdown, then fade the browser away so the
  // rest of the walkthrough is a clean, focused view of just the popup.
  const winBox = await pop.locator("#__demo_window__").boundingBox();
  const zoomPoint = { x: winBox.x + winBox.width / 2, y: winBox.y + winBox.height / 2 };
  await zoomTo(pop, shot, zoomPoint, 1, ZOOM_SCALE);
  await shot(400);
  await fadeBrowser(pop);
  await shot(500);

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
      cursorAt = await clickAt(pop, shot, cursorAt, copyBtn, { afterMs: 300 });
      await scrollContentToBottom(pop);
      await shot(900); // the "Copied." toast, scrolled into view
    }
  }

  const menuBtn = pop.locator("#export-menu");
  if (await menuBtn.count()) {
    cursorAt = await clickAt(pop, shot, cursorAt, menuBtn, { afterMs: 1000 });
    const jsonItem = pop.locator("#copy-json");
    if (await jsonItem.count()) {
      cursorAt = await clickAt(pop, shot, cursorAt, jsonItem, { afterMs: 300 });
      await scrollContentToBottom(pop);
      await shot(1400); // "Copied as JSON" toast, scrolled into view
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
