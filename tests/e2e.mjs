// End to end verification in real Chromium with the extension loaded.
// Uses a local fixture site and synthetic credentials only.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, stageExtension } from "./harness.mjs";
import { startFixture, SYN } from "./fixture-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* retry */
    }
    await sleep(step);
  }
  return false;
}

const A = await startFixture();
const B = await startFixture(); // same host, different port
const oA = `http://localhost:${A.port}`;
const oOther = `http://127.0.0.1:${A.port}`;
const oB = `http://localhost:${B.port}`;

const { ctx, id, userDataDir } = await launch(stageExtension(true));
const sw = () => ctx.serviceWorkers()[0];
const consoleLines = [];
ctx.on("console", (m) => consoleLines.push(m.text()));
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: oA });
await sw().evaluate(() => chrome.storage.local.set({ capture: false })); // manual flows run without values

const store = async () => {
  const s = sw();
  const r = await s.evaluate(async () => ({
    session: await chrome.storage.session.get(null),
    local: await chrome.storage.local.get(null),
    sync: await chrome.storage.sync.get(null)
  }));
  const k = Object.keys(r.session).find((x) => x.startsWith("insp:"));
  if (k) r.session.inspection = r.session[k];
  return r;
};
const tabIdOf = (prefix) =>
  sw().evaluate(
    async (p) => (await chrome.tabs.query({})).find((t) => (t.url || "").startsWith(p))?.id ?? null,
    prefix
  );
async function openPopup(tabId, viewport) {
  const p = await ctx.newPage();
  if (viewport) await p.setViewportSize(viewport);
  p.on("console", (m) => consoleLines.push(m.text()));
  await p.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
  await p.waitForSelector("main > *");
  return p;
}
const mainText = (p) => p.locator("main").innerText();
// Rows are one line each; opening a row shows its value, actions and details.
const rowOf = (p, name) => p.locator("summary.rowhead").filter({ has: p.locator(".sig-name", { hasText: new RegExp(`^${name}$`) }) }).first();
const toggleRow = (p, name) => rowOf(p, name).click();
// Every copy/export action now lives behind one "Export" button and panel.
const openMenu = (p) => p.click("#export-menu");
async function traffic(page, list) {
  await page.evaluate(async (items) => {
    for (const [url, init] of items) {
      try { await fetch(url, init); } catch { /* cross origin failures are fine */ }
    }
  }, list);
}

// ---------------------------------------------------------------- pages
const pageA = await ctx.newPage();
await pageA.goto(`${oA}/`);
const tabA = await tabIdOf(oA);

// ---- Unsupported pages -------------------------------------------------
{
  const chromePage = await ctx.newPage();
  await chromePage.goto("chrome://version/");
  const t = await tabIdOf("chrome://version");
  const p = await openPopup(t);
  check("unsupported: chrome:// page explained", /Can't inspect/.test(await mainText(p)), await mainText(p));
  check("unsupported: no start buttons offered", (await p.locator("#start").count()) === 0);
  await p.close();
  await chromePage.close();
  const blank = await ctx.newPage();
  await blank.goto("about:blank");
  const tb = await tabIdOf("about:blank");
  const p2 = await openPopup(tb);
  check("unsupported: about:blank explained", /Can't inspect/.test(await mainText(p2)));
  await p2.close();
  await blank.close();
}

// ---- Onboarding, header, idle ------------------------------------------
await sw().evaluate(async () => { await chrome.storage.local.clear(); await chrome.storage.local.set({ capture: false }); });
let pop = await openPopup(tabA, { width: 520, height: 760 });
check("first open: one button enables all sites", /Enable for all sites/.test(await mainText(pop)) && (await pop.locator("#enable").count()) === 1);
check("first open: starts idle", /Idle/.test(await mainText(pop)));
check("header: site name from tab title", (await pop.locator("#site-title").innerText()) === "Fixture Home");
check("header: origin shown", (await pop.locator("#site-origin").innerText()) === oA);
const favOk = await until(async () => (await pop.locator("#favicon").isVisible()) && (await pop.locator("#favicon").getAttribute("src")).endsWith("/favicon.svg"), 6000);
check("header: browser provided favicon displayed", favOk, `src=${await pop.locator("#favicon").getAttribute("src")}`);
{
  const fp = await ctx.newPage();
  await fp.route("**/favicon.svg", (r) => r.abort());
  await fp.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabA}`);
  await fp.waitForSelector("main > *");
  check("favicon: falls back to the browser's cached copy when the direct icon fails", await until(async () => (await fp.locator("#favicon").isVisible()) && ((await fp.locator("#favicon").getAttribute("src")) || "").includes("/_favicon/"), 6000));
  await fp.close();
}
check("header: fallback icon hidden while favicon is shown", !(await pop.locator("#favicon-fallback").isVisible()));
check("no inspection state before start", !(await store()).session.inspection);
await pop.screenshot({ path: join(OUT, "01-idle.png") });

// ---- Keyboard navigation ------------------------------------------------
await pop.reload();
await pop.waitForSelector("#start");
await pop.evaluate(() => document.activeElement && document.activeElement.blur());
let reached = false;
for (let i = 0; i < 6 && !reached; i++) {
  await pop.keyboard.press("Tab");
  reached = await pop.evaluate(() => document.activeElement && document.activeElement.id === "start");
}
check("keyboard: Tab reaches Inspect this site", reached);
const outline = await pop.evaluate(() => {
  const cs = getComputedStyle(document.activeElement);
  return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
});
check("keyboard: visible focus outline", outline.style !== "none" && outline.width >= 2, JSON.stringify(outline));

// ---- Permission denied then retry --------------------------------------
await pop.evaluate(() => {
  chrome.permissions.request = () => Promise.resolve(false);
});
await pop.keyboard.press("Enter");
const deniedShown = await until(async () => /Access not granted/.test(await mainText(pop)), 4000);
check("permission denied: short explanation shown", deniedShown, await mainText(pop));
check("permission denied: nothing observed or stored", !(await store()).session.inspection);
await pop.screenshot({ path: join(OUT, "02-denied.png") });
await pop.reload(); // drops the stub, real request path again (already granted in this build)
await pop.waitForSelector("#start");

// ---- Start with keyboard, empty state -----------------------------------
await pop.focus("#start");
await pop.keyboard.press("Enter");
const started = await until(async () => /Inspecting: 0 signals/.test(await mainText(pop)), 8000);
check("permission granted: inspection starts via keyboard", started, await mainText(pop));
check("active with no signals: empty state with reload", /Waiting for requests/.test(await mainText(pop)) && (await pop.locator("#reload").count()) === 1);
await pop.screenshot({ path: join(OUT, "03-empty.png") });

// ---- Live signals ----------------------------------------------------------
await traffic(pageA, [
  [`/api?token=${SYN.query}`, { headers: { Authorization: `Bearer ${SYN.bearer}` } }],
]);
check("live: Bearer appears without reopening popup", await until(async () => /Bearer/.test(await mainText(pop))), await mainText(pop));
check("live: New marker on fresh signal", /New/.test(await mainText(pop)));
await traffic(pageA, [
  ["/api", { headers: { Authorization: `Basic ${SYN.basic}` } }],
  ["/login", {}],
  ["/api", { method: "POST", body: `password=${SYN.body}`, headers: { "X-API-Key": SYN.api, "X-CSRF-Token": SYN.csrf, "X-Custom-Token": SYN.custom, "X-Trace-Id": "trace-1" } }],
  ["/api", { headers: { Authorization: `Bearer ${SYN.bearer}` } }] // duplicate
]);
const txt = await until(async () => {
  const t = await mainText(pop);
  return /Basic/.test(t) && /sid/.test(t) && /X-API-Key/.test(t) && /X-CSRF-Token/.test(t) && /X-Custom-Token/.test(t) && t;
}, 10000);
check("signals: Bearer, Basic, cookies, API key, CSRF, uncertain all shown", !!txt, await mainText(pop));
await sleep(900); // cookie attributes are read in a short batch
const body = await mainText(pop);
check("signals: session cookie group is a heading, other cookies collapsed", /Session cookies \(1\)/.test(body) && /Quick read/.test(body) && /Other cookies \(1\)/.test(body) && !/\bpref\b/.test(body), body.slice(0, 600));
await toggleRow(pop, "sid");
const sidOpen = await mainText(pop);
check("signals: opening the sid row shows HttpOnly and SameSite=Lax", /HttpOnly/.test(sidOpen) && /SameSite=Lax/.test(sidOpen));
await toggleRow(pop, "sid");
await pop.locator("details[aria-label='Quick read'] > summary").click();
const qr = await mainText(pop);
check("quick read: opens to a short reading with a warning", /Session cookies: sid/.test(qr) && /No Secure flag: sid/.test(qr) && /1 warning/.test(qr), qr.slice(0, 400));
await pop.locator("details[aria-label='Quick read'] > summary").click();
check("signals: custom header marked unclear", /Unclear/.test(body));
check("signals: mixed evidence caveat", /Server choice unknown/.test(body));
check("signals: visibility limit stated", /Only this site is visible/.test(body));
check("others: non-auth headers sit in a collapsed separate section", /Other headers \(/.test(body) && !body.includes("X-Trace-Id") && !body.includes("User-Agent"), body.slice(-300));
check("group headings carry the counts", /Authorization \(2\)/.test(body) && /Session cookies \(1\)/.test(body) && /CSRF \(1\)/.test(body));
await pop.locator("summary", { hasText: "Other headers (" }).click();
const opened = await mainText(pop);
check("others: custom and standard headers listed separately when opened", /Custom/.test(opened) && /X-Trace-Id/.test(opened) && /Standard/.test(opened) && /User-Agent/i.test(opened));
check("others: auth headers are not repeated in the other section", !/Other headers[\s\S]*X-API-Key/.test(opened.split("Other headers (")[1] || ""));
await pop.locator("summary", { hasText: "Other headers (" }).click();
check("dedupe: Bearer listed once", ((await pop.locator('section[aria-label="Authorization"]').innerText()).match(/Bearer/g) || []).length === 1);
check("rows: one collapsed line per signal", (await pop.locator(".rowhead").count()) >= 6 && (await pop.locator("details.rowitem[open]").count()) === 0);
await openMenu(pop);
check("export: JSON file and with-values items hidden while Show values is off", (await pop.locator("#export").count()) === 0 && (await pop.locator("#copy-full").count()) === 0 && (await pop.locator("#copy-json").count()) === 1 && (await pop.locator("#copy-json").innerText()) === "Copy as JSON");
await pop.keyboard.press("Escape");
check("export menu: Escape closes it and returns focus to the button", (await pop.locator(".menu-panel").count()) === 0 && (await pop.evaluate(() => document.activeElement && document.activeElement.id)) === "export-menu");
await pop.screenshot({ path: join(OUT, "04-signals.png"), fullPage: true });

// ---- Isolation -----------------------------------------------------------------
const tab2 = await ctx.newPage();
await tab2.goto(`${oA}/plain`);
const other = await ctx.newPage();
await other.goto(`${oOther}/`);
const portB = await ctx.newPage();
await portB.goto(`${oB}/`);
await traffic(tab2, [["/api", { headers: { "Api-Key": "SYNTH-TAB2", "X-Xsrf-Token": "SYNTH-TAB2" } }]]);
await traffic(other, [["/api", { headers: { Authorization: "Digest SYNTH-OTHER", "X-Access-Token": "SYNTH-OTHER" } }]]);
await traffic(portB, [["/api", { headers: { "X-Auth-Token": "SYNTH-PORTB", "Anti-Csrf-Token": "SYNTH-PORTB" } }]]);
await traffic(pageA, [
  [`${oOther}/api`, { headers: { "X-Session-Key": "SYNTH-XORIGIN" } }],
  [`${oB}/api`, { headers: { "X-Secret-Key": "SYNTH-XORIGIN" } }]
]);
await sleep(1200);
const iso = await mainText(pop);
const st1 = await store();
const isoNames = ["Api-Key", "X-Xsrf-Token", "Digest", "X-Access-Token", "X-Auth-Token", "Anti-Csrf-Token", "X-Session-Key", "X-Secret-Key"];
check("isolation: other tab, other origin, other port and cross-origin API are not observed",
  isoNames.every((n) => !iso.includes(n)) && isoNames.every((n) => !JSON.stringify(st1.session).includes(n)),
  isoNames.filter((n) => iso.includes(n)).join(","));
await tab2.close(); await other.close(); await portB.close();

// ---- Copy ----------------------------------------------------------------------------
await openMenu(pop);
await pop.click("#copy");
check("export menu: closes itself after an item is chosen", (await pop.locator(".menu-panel").count()) === 0);
check("copy: concise confirmation", await until(async () => /Copied/.test(await pop.locator("#toast").innerText()), 3000));
await pageA.bringToFront();
const clip = await pageA.evaluate(() => navigator.clipboard.readText());
await pop.bringToFront();
console.log("--- clipboard ---\n" + clip + "\n-----------------");
check("copy: other headers are not in the summary", !clip.includes("X-Trace-Id") && !clip.includes("User-Agent"));
check("copy: origin line", clip.includes(`Origin: ${oA}`));
check("copy: Authorization schemes redacted", /Authorization: Bearer <REDACTED>/.test(clip) && /Authorization: Basic <REDACTED>/.test(clip));
check("copy: cookie with attributes", /Cookie: sid=<REDACTED> \[No Secure, HttpOnly, SameSite=Lax\]/.test(clip), clip);
check("copy: API key and CSRF headers", /API key header: X-API-Key <REDACTED>/.test(clip) && /CSRF header: X-CSRF-Token <REDACTED>/.test(clip));
check("copy: no synthetic secrets", !/SYNTH|U1lOVEhVU0VS/.test(clip));
check("copy: no query string values or body", !/token=|password=|SYNTH/.test(clip));
check("copy: no em or en dashes", !/[–—]/.test(clip));

await openMenu(pop);
await pop.click("#copy-json");
await sleep(300);
await pageA.bringToFront();
const jsonClip = await pageA.evaluate(() => navigator.clipboard.readText());
await pop.bringToFront();
let parsedClip = null;
try { parsedClip = JSON.parse(jsonClip); } catch { /* reported below */ }
check(
  "copy as JSON: valid, sanitized, structured by site",
  !!parsedClip && parsedClip.redacted === true && Array.isArray(parsedClip.sites) && parsedClip.sites[0].origin === oA &&
    parsedClip.sites[0].authorization.some((h) => h.scheme === "Bearer" && h.value === undefined) &&
    !jsonClip.includes("SYNTH"),
  jsonClip.slice(0, 300)
);

// ---- Turning Show values on mid-inspection ---------------------------------------------------
await pop.locator("#capture").check();
check(
  "show values on: explains cookies refresh live, headers need a new request",
  /Reload the page to also capture header and token values/.test(await pop.locator("#toast").innerText())
);
check(
  "show values on: notes that already-seen header values are still missing",
  await until(async () => /Reload the page to capture them/.test(await mainText(pop)), 4000)
);
// A cookie row always renders as a <details> (it always has attribute chips),
// so the row's mere existence says nothing about whether its value arrived
// yet. Wait on the popup's own rendered DOM reflecting the live backfill.
// A cookie row always renders as a <details> (it always has attribute chips),
// so the row's mere existence says nothing about whether its value arrived
// yet. Wait on the popup's own rendered DOM reflecting the live backfill.
check(
  "show values on: the sid cookie value is already live, no reload needed",
  await until(
    () =>
      pop.evaluate(() => {
        const n = [...document.querySelectorAll(".sig-name")].find((x) => x.textContent === "sid");
        const details = n && n.closest("details");
        return !!(details && details.querySelector(".val"));
      }),
    4000
  )
);
await toggleRow(pop, "sid");
const sidLi = pop.locator("li", { has: pop.locator(".sig-name", { hasText: /^sid$/ }) }).first();
const sidValueText = await sidLi.locator(".val").first().innerText();
check("show values on: sid shows its real value once opened", sidValueText === SYN.session, sidValueText);
await toggleRow(pop, "sid");
await pop.locator("#capture").uncheck();
await until(async () => !/Reload the page to capture them/.test(await mainText(pop)), 4000);

// ---- Reopen popup -------------------------------------------------------------------------
await pop.close();
pop = await openPopup(tabA, { width: 520, height: 760 });
const re = await mainText(pop);
check("reopen: inspection state still shown", /Inspecting:/.test(re) && /Bearer/.test(re) && /X-API-Key/.test(re), re);

// ---- Contrast and layout ----------------------------------------------------------------------
const contrast = await pop.evaluate(() => {
  const parse = (c) => c.match(/[\d.]+/g).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (e) => {
    while (e) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c.length < 4 || c[3] > 0.99) { if (c.length === 3 || c[3] > 0.99) return c.slice(0, 3); }
      e = e.parentElement;
    }
    return [30, 31, 34];
  };
  const bad = [];
  let n = 0;
  for (const e of document.querySelectorAll("main *, header *")) {
    const own = [...e.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim());
    if (!own) continue;
    n++;
    const fg = parse(getComputedStyle(e).color).slice(0, 3);
    const bg = bgOf(e);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    if (ratio < 4.5) bad.push(`${e.textContent.trim().slice(0, 20)}:${ratio.toFixed(2)}`);
  }
  const pageBg = parse(getComputedStyle(document.body).backgroundColor);
  return { n, bad, dark: lum(pageBg.slice(0, 3)) < 0.05 };
});
check("dark theme: graphite background", contrast.dark);
check(`dark theme: all ${contrast.n} text elements have contrast >= 4.5`, contrast.bad.length === 0, contrast.bad.join(", "));
check("layout: no horizontal scroll at 520px", await pop.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));

// ---- Same-origin navigation retains; other origin clears ------------------------------------------
await pageA.goto(`${oA}/login`);
await sleep(600);
check("same-origin navigation retains inspection", /Inspecting:/.test(await mainText(pop)) && (await store()).session.inspection?.tabId === tabA);
await pageA.goto(`${oOther}/`);
const cleared = await until(async () => /Idle/.test(await mainText(pop)), 6000);
check("origin change: results cleared immediately, idle for new site", cleared, await mainText(pop));
check("origin change: header shows new origin", (await pop.locator("#site-origin").innerText()) === oOther);
check("origin change: explanation shown", /Site changed/.test(await mainText(pop)));
check("origin change: storage has no inspection", !(await store()).session.inspection);
check("origin change: no leftover signal names", !/Bearer|X-API-Key/.test(await mainText(pop)));
await pop.screenshot({ path: join(OUT, "05-origin-changed.png") });

// ---- Stop ---------------------------------------------------------------------------------------
await pageA.goto(`${oA}/`);
await pop.reload();
await pop.click("#start");
await until(async () => /Inspecting:/.test(await mainText(pop)));
await traffic(pageA, [["/api", { headers: { Authorization: `Bearer ${SYN.bearer}` } }]]);
await until(async () => /Bearer/.test(await mainText(pop)));
await pop.click("#stop");
await until(async () => /Idle/.test(await mainText(pop)));
check("stop: UI idle and results cleared", /Idle/.test(await mainText(pop)) && !/Bearer/.test(await mainText(pop)));
check("stop: storage cleared", !(await store()).session.inspection);
await traffic(pageA, [["/api", { headers: { "X-API-Key": SYN.api } }]]);
await sleep(500);
check("stop: later traffic not recorded", !(await store()).session.inspection);

// ---- Service worker suspension ----------------------------------------------------------------------
await pop.click("#start");
await until(async () => /Inspecting:/.test(await mainText(pop)));
await traffic(pageA, [["/api", { headers: { Authorization: `Bearer ${SYN.bearer}` } }]]);
await until(async () => /Bearer/.test(await mainText(pop)));
let stopped = false;
try {
  // Chrome suspends an idle extension worker after about 30 seconds.
  let closedEvent = false;
  sw().on("close", () => { closedEvent = true; });
  for (let i = 0; i < (process.env.SL_QUICK ? 1 : 40) && !closedEvent; i++) await sleep(1000);
  stopped = closedEvent;
  console.log(`worker close event observed: ${closedEvent}`);
} catch (e) {
  console.log("note: could not stop worker via CDP:", String(e).slice(0, 120));
}
await traffic(pageA, [["/api", { headers: { "X-CSRF-Token": SYN.csrf } }]]);
const afterWake = await until(async () => /X-CSRF-Token/.test(await mainText(pop)) && /Bearer/.test(await mainText(pop)), 8000);
check(
  stopped
    ? "service worker suspended and woken: inspection recovered and still updates"
    : "state and updates intact after 40s idle (worker suspension itself NOT triggered under automation)",
  afterWake,
  await mainText(pop)
);

// ---- Permission lost -----------------------------------------------------------------------------------
await sw().evaluate(() => { chrome.permissions.contains = async () => false; });
await pop.reload();
const lost = await until(async () => /Access removed/.test(await mainText(pop)), 6000);
check("permission lost (stubbed check): inspection ends with explanation", lost, await mainText(pop));
check("permission lost: storage cleared", !(await store()).session.inspection);
// restore a clean worker for the remaining checks
await ctx.newCDPSession(pageA).then(async (c) => { await c.send("ServiceWorker.enable"); await c.send("ServiceWorker.stopAllWorkers"); }).catch(() => {});
await sleep(800);

// ---- Tab close -----------------------------------------------------------------------------------------
await pop.reload();
await pop.click("#start");
await until(async () => /Inspecting:/.test(await mainText(pop)));
await pageA.close();
const closedEnded = await until(async () => !(await store()).session.inspection, 6000);
check("tab close: inspection ended", closedEnded);
check("tab close: reason recorded", /Tab closed/.test(JSON.stringify((await store()).session.lastEnded || {})));
await pop.close();

// ---- Header fallbacks and plain text ----------------------------------------------------------------------
const pPlain = await ctx.newPage();
await pPlain.goto(`${oA}/plain`);
const hitsBefore = A.hits.length;
const tp = await tabIdOf(`${oA}/plain`);
let hp = await openPopup(tp, { width: 520, height: 700 });
await sleep(500);
check("fallback: hostname used when title is missing", (await hp.locator("#site-title").innerText()) === "localhost", await hp.locator("#site-title").innerText());
check("fallback: bundled icon shown when no favicon", (await hp.locator("#favicon-fallback").isVisible()) && !(await hp.locator("#favicon").isVisible()));
check("fallback: no extra network request for a missing icon", !A.hits.slice(hitsBefore).some((h) => /favicon/.test(h.path)), JSON.stringify(A.hits.slice(hitsBefore)));
await hp.close();

await pPlain.goto(`${oA}/xss`);
await sleep(300);
hp = await openPopup(tp, { width: 520, height: 700 });
check("title rendered as plain text", (await hp.locator("#site-title").innerText()).includes("<img src=x onerror=alert(1)>") && (await hp.locator("#site-title img").count()) === 0, await hp.locator("#site-title").innerText());
await hp.close();

await pPlain.goto(`${oA}/long`);
await sleep(300);
hp = await openPopup(tp, { width: 520, height: 700 });
await hp.click("#start");
await until(async () => /Inspecting:/.test(await mainText(hp)));
const longName = "X-Auth-" + "a".repeat(55);
await traffic(pPlain, [["/api", { headers: { [longName]: "SYNTH-LONG" } }]]);
await until(async () => (await mainText(hp)).includes(longName), 6000);
check("layout: long title and header name wrap without horizontal scroll", await hp.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
await hp.screenshot({ path: join(OUT, "06-long.png") });

// live header refresh on navigation while popup stays open
await pPlain.goto(`${oA}/login`);
check("header: refreshes when the tab navigates", await until(async () => (await hp.locator("#site-title").innerText()) === "Fixture Login", 6000));
await hp.close();

const b64e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT_TOKEN = `${b64e({ alg: "HS256", typ: "JWT" })}.${b64e({ sub: "SYNTH-SUBJECT", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2lnbmF0dXJl`;

// ---- Optional value capture (off by default) ---------------------------------------------------
{
  await pPlain.goto(`${oA}/`);
  await sleep(300);
  const cp = await openPopup(tp, { width: 520, height: 900 });
  if (await cp.locator("#stop").count()) {
    await cp.click("#stop");
    await until(async () => /Idle/.test(await mainText(cp)));
  }
  check("capture: Show values toggle present and off for this run", (await cp.locator("#capture").count()) === 1 && !(await cp.locator("#capture").isChecked()));
  await cp.locator("#capture").check();
  await cp.click("#start");
  await until(async () => /Inspecting:/.test(await mainText(cp)));
  await traffic(pPlain, [
    ["/login", {}],
    ["/api", { headers: { Authorization: `Bearer ${SYN.bearer}`, "X-API-Key": SYN.api, "X-Id-Token": JWT_TOKEN } }]
  ]);
  await until(async () => /Bearer/.test(await mainText(cp)) && /sid/.test(await mainText(cp)) && /X-API-Key/.test(await mainText(cp)), 8000);
  check("capture: values stay hidden until a row is opened", (await mainText(cp)).split("\n").every((ln) => ![SYN.bearer, SYN.session, SYN.api, JWT_TOKEN].some((v) => ln.includes(v))) && (await cp.locator(".val").count()) >= 3);
  await toggleRow(cp, "X-Id-Token");
  const jt = await mainText(cp);
  check("jwt: detected with algorithm, expiry and claim names, payload not shown", /JWT: HS256/.test(jt) && /Expires in/.test(jt) && /Claims: sub, role, exp/.test(jt) && !jt.includes("SYNTH-SUBJECT"), jt.slice(0, 700));
  await cp.locator('button[aria-label="Show decoded JWT of X-Id-Token"]').click();
  check("jwt: Decode shows header and payload", /"alg": "HS256"/.test(await mainText(cp)) && /"sub": "SYNTH-SUBJECT"/.test(await mainText(cp)));
  await cp.locator('button[aria-label="Hide decoded JWT of X-Id-Token"]').click();
  await toggleRow(cp, "X-Id-Token");
  await toggleRow(cp, "Authorization");
  check("capture: opening the row shows the Bearer token", (await mainText(cp)).includes(`Bearer ${SYN.bearer}`));
  await toggleRow(cp, "sid");
  check("capture: HttpOnly cookie value visible", (await mainText(cp)).includes(SYN.session));
  await toggleRow(cp, "Authorization");
  check("capture: closing the row hides it again", !(await mainText(cp)).includes(SYN.bearer));
  await toggleRow(cp, "sid");
  await toggleRow(cp, "Authorization");
  await pPlain.bringToFront();
  await cp.bringToFront();
  await cp.locator('button[aria-label="Copy value of Authorization"]').click();
  await sleep(300);
  await pPlain.bringToFront();
  const c1 = await pPlain.evaluate(() => navigator.clipboard.readText());
  check("capture: Copy value puts the exact token on the clipboard", c1 === `Bearer ${SYN.bearer}`, c1);
  await cp.bringToFront();
  await cp.getByText("Copy as Cookie header").click();
  await sleep(300);
  await pPlain.bringToFront();
  const cch = await pPlain.evaluate(() => navigator.clipboard.readText());
  check("capture: Copy as Cookie header gives name=value pairs", cch === `sid=${SYN.session}`, cch);
  await cp.bringToFront();
  await openMenu(cp);
  await cp.click("#copy-full");
  await sleep(300);
  await pPlain.bringToFront();
  const c2 = await pPlain.evaluate(() => navigator.clipboard.readText());
  check("capture: Copy with values includes real values", c2.includes(`Authorization: Bearer ${SYN.bearer}`) && c2.includes(`sid=${SYN.session}`) && c2.includes(`X-API-Key: ${SYN.api}`), c2);
  await cp.bringToFront();
  await openMenu(cp);
  await cp.click("#copy-json");
  await sleep(300);
  await pPlain.bringToFront();
  const cj = await pPlain.evaluate(() => navigator.clipboard.readText());
  let parsedCj = null;
  try { parsedCj = JSON.parse(cj); } catch { /* reported below */ }
  check(
    "capture: Copy as JSON with values has the real token and is valid JSON",
    !!parsedCj && parsedCj.redacted === false && parsedCj.sites[0].authorization.some((h) => h.value === `Bearer ${SYN.bearer}`),
    cj.slice(0, 300)
  );
  await cp.bringToFront();
  await openMenu(cp);
  await cp.click("#copy");
  await sleep(300);
  await pPlain.bringToFront();
  const c3 = await pPlain.evaluate(() => navigator.clipboard.readText());
  check("capture: sanitized copy still redacts everything", !/SYNTH/.test(c3) && !c3.includes(JWT_TOKEN) && /<REDACTED>/.test(c3) && /JWT alg=HS256/.test(c3), c3);
  await cp.bringToFront();
  await openMenu(cp);
  const [download] = await Promise.all([cp.waitForEvent("download"), cp.click("#export")]);
  const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
  check("export: file name ends in .json", /\.json$/.test(download.suggestedFilename()), download.suggestedFilename());
  check(
    "export: cookies array is shaped like the cookies API, compatible with Cookie-Editor import",
    Array.isArray(exported.cookies) &&
      exported.cookies.some((c) => c.name === "sid" && c.value === SYN.session && c.domain && "path" in c && "httpOnly" in c && "sameSite" in c),
    JSON.stringify(exported.cookies).slice(0, 300)
  );
  check(
    "export: headers include the real values",
    exported.headers.some((h) => h.name === "Authorization" && h.value === `Bearer ${SYN.bearer}`) &&
      exported.headers.some((h) => h.name === "X-API-Key" && h.value === SYN.api)
  );
  check("export: origin recorded", exported.origin === oA);
  const sc = await store();
  check("capture: values never written to local or sync storage", !/SYNTH/.test(JSON.stringify([sc.local, sc.sync])));
  await cp.bringToFront();
  await cp.click("#stop");
  await until(async () => /Idle/.test(await mainText(cp)));
  const after = await store();
  check("capture: Stop erases captured values", !/SYNTH/.test(JSON.stringify(after)) && !JSON.stringify(after).includes(JWT_TOKEN) && !(await mainText(cp)).includes("SYNTH"));
  await cp.locator("#capture").uncheck();
  await cp.close();
}

// ---- Auto mode: enable once, then every tab is observed -------------------------------------------
{
  await sw().evaluate(() => chrome.storage.local.set({ capture: true }));
  await pPlain.goto(`${oA}/`);
  await sleep(300);
  const ap = await openPopup(tp, { width: 520, height: 900 });
  if (await ap.locator("#stop").count()) {
    await ap.click("#stop");
    await until(async () => /Idle/.test(await mainText(ap)));
  }
  check("auto: single button enables all sites", (await ap.locator("#enable").count()) === 1);
  const tabZ = await ctx.newPage();
  await tabZ.goto(`${oOther}/plain`);
  await pPlain.evaluate(() => { window.__m = 1; });
  await tabZ.evaluate(() => { window.__m = 1; });
  await ap.click("#enable");
  check("auto: on without any per site step", await until(async () => /Auto: \d+ signal/.test(await mainText(ap)), 8000), await mainText(ap));
  check("auto: open tabs are reloaded once so signals appear at once", await until(async () => (await pPlain.evaluate(() => window.__m)) === undefined && (await tabZ.evaluate(() => window.__m)) === undefined, 10000));
  await tabZ.close();
  await ap.click("#clear");
  await until(async () => /Auto: 0 signals/.test(await mainText(ap)), 4000);
  check("auto: waiting state offers reload and shows delivery diagnostics", /Waiting for requests/.test(await mainText(ap)) && (await ap.locator("#reload").count()) === 1 && /Requests seen: \d+\./.test(await mainText(ap)), await mainText(ap));
  await pPlain.reload();
  check("auto: a plain page refresh brings signals (no other action)", await until(async () => /Auto: [1-9]/.test(await mainText(ap)), 8000), await mainText(ap));
  await ap.click("#clear");
  await until(async () => /Auto: 0 signals/.test(await mainText(ap)), 4000);
  // The worker can re-register its request listener at any time without losing requests.
  await ap.evaluate(() => chrome.runtime.sendMessage({ type: "rearm" }));
  await pPlain.reload();
  check("auto: requests are still seen after re-registering the listener", await until(async () => /Auto: [1-9]/.test(await mainText(ap)), 8000), await mainText(ap));
  await ap.click("#clear");
  await until(async () => /Auto: 0 signals/.test(await mainText(ap)), 4000);
  const tabX = await ctx.newPage();
  await tabX.goto(`${oA}/plain`);
  const tabO = await ctx.newPage();
  await tabO.goto(`${oOther}/`);
  const idX = await tabIdOf(`${oA}/plain`);
  const idO = await tabIdOf(`${oOther}/`);
  await traffic(pPlain, [
    [`/api?token=${SYN.query}`, { headers: { Authorization: `Bearer ${SYN.bearer}`, "X-API-Key": SYN.api } }],
    [`${oOther}/api`, { headers: { "X-Session-Key": "SYNTH-XO" } }]
  ]);
  await traffic(tabX, [["/api", { headers: { "X-Auth-Token": "SYNTH-TABX" } }]]);
  await traffic(tabO, [["/api", { headers: { "X-Access-Token": "SYNTH-TABO" } }]]);
  const gotAuto = await until(async () => /Bearer/.test(await mainText(ap)) && /Other origin:/.test(await mainText(ap)), 8000);
  const at = await mainText(ap);
  check("auto: signals appear with no Inspect click, other host grouped", gotAuto && /Auto: \d+ signals/.test(at) && at.includes(`Other origin: ${oOther}`), at.slice(0, 400));
  const badgeText = await sw().evaluate((i) => chrome.action.getBadgeText({ tabId: i }), tp);
  check("auto: toolbar badge shows the signal count", /^[1-9]\d*$/.test(badgeText), badgeText);
  await openMenu(ap);
  const hasCopyFull = (await ap.locator("#copy-full").count()) === 1;
  await ap.keyboard.press("Escape");
  check("auto: tokens shown for easy copy", (await ap.locator('button[aria-label="Copy value of Authorization"]').count()) === 1 && hasCopyFull);
  check("auto: other tabs are not mixed in", !at.includes("X-Auth-Token") && !at.includes("X-Access-Token"));
  const px = await openPopup(idX, { width: 520, height: 700 });
  const pxt = await mainText(px);
  check("auto: each tab keeps its own results", /X-Auth-Token/.test(pxt) && !/Bearer/.test(pxt), pxt.slice(0, 300));
  const po = await openPopup(idO, { width: 520, height: 700 });
  check("auto: a tab opened after enabling is observed too", await until(async () => /X-Access-Token/.test(await mainText(po)), 6000));
  await tabX.goto(`${oOther}/`);
  check("auto: origin change starts fresh results", await until(async () => /Auto: 0 signals/.test(await mainText(px)) && !/X-Auth-Token/.test(await mainText(px)), 6000));
  await openMenu(ap);
  await ap.click("#copy-full");
  await sleep(300);
  await pPlain.bringToFront();
  const ac = await pPlain.evaluate(() => navigator.clipboard.readText());
  check("auto: copy with values has the real token", ac.includes(`Authorization: Bearer ${SYN.bearer}`) && ac.includes(`Origin: ${oOther}`), ac);
  await ap.bringToFront();
  await ap.screenshot({ path: join(OUT, "07-auto.png"), fullPage: true });
  await ap.click("#clear");
  check("auto: Clear empties this tab", await until(async () => /Auto: 0 signals/.test(await mainText(ap)), 4000));
  await traffic(pPlain, [["/api", { headers: { "X-API-Key": SYN.api } }]]);
  check("auto: keeps observing after Clear", await until(async () => /X-API-Key/.test(await mainText(ap)), 6000));
  await ap.locator("#capture").uncheck();
  await sleep(600);
  const noVal = await store();
  check("auto: turning Show values off erases stored values", !/SYNTH/.test(JSON.stringify(noVal.session)), JSON.stringify(noVal.session).slice(0, 200));
  await openMenu(ap);
  check("auto: copy with values is gone when values are off", (await ap.locator("#copy-full").count()) === 0);
  await ap.keyboard.press("Escape");
  await ap.click("#auto-off");
  check("auto: turning it off returns to idle and drops all tab results", (await until(async () => /Idle/.test(await mainText(ap)), 6000)) && (await until(async () => !Object.keys((await store()).session).some((k) => k.startsWith("insp:")), 6000)));
  await tabX.close();
  await tabO.close();
  await px.close();
  await po.close();
  await ap.close();
}

// ---- Secret absence: storage, logs, UI, profile files ------------------------------------------------------------------
const final = await store();
const dump = JSON.stringify(final);
check("no synthetic credentials in extension storage", !/SYNTH|U1lOVEhVU0VS/.test(dump), dump.slice(0, 200));
check("no synthetic credentials in console output", !consoleLines.some((l) => /SYNTH/.test(l)));
const extStore = join(userDataDir, "Default", "Local Extension Settings");
let fileHit = false;
function scan(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) scan(p);
    else if (/SYNTH-|U1lOVEhVU0VS/.test(readFileSync(p, "latin1"))) fileHit = true;
  }
}
try { scan(extStore); } catch { /* directory may not exist when nothing persisted */ }
check("no synthetic credentials in persisted extension files", !fileHit);

await ctx.close();
A.close();
B.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
