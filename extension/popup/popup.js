import { parseSupportedOrigin, permissionPattern, safeHostname } from "../lib/origin.js";
import { decodeJwt, tokenFromValue } from "../lib/signals.js";
import {
  groupSignals,
  attributeList,
  hasMixedEvidence,
  buildClipboardText,
  buildFullText,
  buildJSON,
  buildInsights,
  collectJwts,
  jwtExpiry,
  originsOf,
  signalsOfOrigin,
  MIXED_SHORT,
  SCOPE_SHORT
} from "../lib/format.js";

const $ = (id) => document.getElementById(id);
const main = $("main");
const toast = $("toast");
const ALL_SITES = ["http://*/*", "https://*/*"];
const DOTS = "••••••";

// Test aid: when the popup page is opened as a normal tab, ?tab=ID selects the
// target tab. In normal use the active tab of the current window is used.
const forcedTab = Number(new URLSearchParams(location.search).get("tab")) || null;

const ui = {
  auto: false, // auto mode is on
  capture: true, // show token values
  denied: false,
  failure: "",
  tab: null,
  state: null, // inspection state of the target tab
  diag: null, // delivery diagnostics for the empty state
  ended: null,
  seen: null, // keys already shown, to mark new ones
  seenFor: "",
  fresh: new Set(),
  decoded: new Set(), // keys whose decoded JWT is shown
  openGroups: new Set(),
  exportOpen: false // the Export menu panel
};

// ---- Small DOM helpers (text nodes only, no markup parsing of data) ---------

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

function message(kind, iconId, text) {
  return el("div", { class: `msg ${kind}` }, icon(iconId), el("span", { text }));
}

function chip(text, kind) {
  return el("span", { class: `chip${kind ? " " + kind : ""}`, text });
}

function say(text, isError) {
  toast.textContent = text;
  toast.classList.toggle("error", !!isError);
}

// ---- Data -----------------------------------------------------------------

async function getTab() {
  try {
    if (forcedTab) return await chrome.tabs.get(forcedTab);
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t || null;
  } catch {
    return null;
  }
}

async function readStorage(tab) {
  const id = tab && tab.id;
  const r = await chrome.storage.session.get(id != null ? [`insp:${id}`, "lastEnded"] : ["lastEnded"]);
  const l = await chrome.storage.local.get(["auto", "capture"]);
  return {
    state: id != null ? r[`insp:${id}`] || null : null,
    ended: r.lastEnded || null,
    auto: l.auto === true,
    capture: l.capture !== false
  };
}

let seq = 0;
const rearmed = new Set(); // tabs where the worker was already asked to re-register
async function refresh(sync) {
  const my = ++seq; // a newer refresh wins, so an older slow one never overwrites it
  const tab = await getTab();
  const data = await readStorage(tab);
  let diag = null;
  const credentialCount = data.state ? Object.values(data.state.signals || {}).filter((x) => x.type !== "other").length : 0;
  if (tab && !credentialCount) {
    try {
      diag = await chrome.runtime.sendMessage({ type: "diag", tabId: tab.id });
    } catch {
      diag = null;
    }
  }
  if (my !== seq) return;
  // Auto is on, access is granted, but nothing arrived: ask the worker to re-register once.
  if (tab && diag && diag.ok && diag.access && data.auto && diag.seen === 0 && !rearmed.has(tab.id)) {
    rearmed.add(tab.id);
    chrome.runtime.sendMessage({ type: "rearm" }).catch(() => {});
  }
  Object.assign(ui, data, { tab, diag });
  render(); // show what is stored right away
  // Housekeeping runs in the background. Anything it changes comes back through
  // the storage listener, so the popup never waits for it.
  if (sync && tab) chrome.runtime.sendMessage({ type: "sync", tabId: tab.id }).catch(() => {});
}

// ---- Header ---------------------------------------------------------------

function renderHeader() {
  const tab = ui.tab;
  const url = tab && (tab.url || tab.pendingUrl);
  const origin = parseSupportedOrigin(url);
  const title = $("site-title");
  const originEl = $("site-origin");
  const img = $("favicon");
  const fb = $("favicon-fallback");

  if (!tab) {
    title.textContent = "No active tab";
    originEl.textContent = "";
  } else if (origin) {
    // Plain text only. Fall back to the hostname when the title is missing.
    const t = (tab.title || "").trim();
    // Browsers use the address as the title when a page has none.
    const noScheme = String(url).replace(/^https?:\/\//, "");
    const isAddress = t === url || t === noScheme || t === noScheme.replace(/[?#].*$/, "");
    title.textContent = t && !isAddress ? t : safeHostname(url);
    originEl.textContent = origin;
  } else {
    title.textContent = (tab.title || "").trim() || "Browser page";
    let shown = "Not a website";
    try {
      const u = new URL(url);
      if (u.host) shown = `${u.protocol}//${u.host}`;
    } catch {
      // keep default
    }
    originEl.textContent = shown;
  }

  // Icon sources in order: the page's own icon, then the browser's cached copy
  // (no network request), then the bundled icon. The cached copy covers icons
  // that refuse requests from outside the site.
  const fav = tab && tab.favIconUrl;
  const sources = [];
  if (origin && typeof fav === "string" && /^(https?:|data:image\/)/.test(fav)) {
    sources.push(fav);
    const u = new URL(url);
    const api = new URL(chrome.runtime.getURL("/_favicon/"));
    api.searchParams.set("pageUrl", u.origin + u.pathname);
    api.searchParams.set("size", "32");
    sources.push(api.toString());
  }
  setIcon(sources);
}

let iconKey = null;
function setIcon(sources) {
  const key = sources.join("|");
  if (key === iconKey) return; // same icon: no reload, no flicker
  iconKey = key;
  const img = $("favicon");
  const fb = $("favicon-fallback");
  let i = 0;
  const showFallback = () => {
    img.removeAttribute("src");
    img.hidden = true;
    fb.removeAttribute("hidden");
  };
  const next = () => (i < sources.length ? (img.src = sources[i++]) : showFallback());
  img.onload = () => {
    img.hidden = false;
    fb.setAttribute("hidden", "");
  };
  img.onerror = next;
  showFallback();
  if (sources.length) next();
}

// ---- Views ------------------------------------------------------------------

function viewUnsupported() {
  return el(
    "section",
    { class: "card" },
    el("div", { class: "status warn" }, icon("i-alert"), el("span", { text: "Can't inspect this page" })),
    el("p", { class: "note", text: "Open a normal http or https site." })
  );
}

// Auto mode is off: one click enables it for every site, once.
function viewOff(origin) {
  const kids = [
    el("div", { class: "status idle" }, icon("i-info"), el("span", { text: "Idle" })),
    el("p", {
      text: "See tokens, cookies and JWTs while you browse. One time access to all sites. Stays on this device."
    })
  ];
  if (ui.ended && ui.ended.tabId === (ui.tab && ui.tab.id) && ui.ended.text) {
    kids.push(message("warn", "i-alert", ui.ended.text));
  }
  if (ui.denied) kids.push(message("error", "i-error", "Access not granted. Try again."));
  if (ui.failure) kids.push(message("error", "i-error", ui.failure));
  kids.push(
    el(
      "div",
      { class: "row" },
      el(
        "button",
        { class: "primary", type: "button", id: "enable", onclick: onEnable },
        icon("i-play"),
        el("span", { text: "Enable for all sites" })
      ),
      el(
        "button",
        { type: "button", id: "start", onclick: () => onStart(origin) },
        el("span", { text: "Only this site" })
      )
    )
  );
  return el("section", { class: "card", "aria-label": "AuthTracer" }, ...kids);
}

function attrChips(meta) {
  const attrs = attributeList(meta);
  if (!attrs) return [{ text: "No attributes", kind: "uncertain" }];
  return attrs.map((a) => {
    const bad = a.startsWith("No ") || a === "SameSite=None" || a === "SameSite=unspecified";
    return { text: a, kind: bad ? "warn" : "good" };
  });
}

// Keeps a <details> element open or closed across re-renders.
function remember(key) {
  return {
    open: ui.openGroups.has(key),
    ontoggle: (e) => {
      if (e.target.open) ui.openGroups.add(key);
      else ui.openGroups.delete(key);
    }
  };
}

// One row per signal, like a cookie editor list: only the name (and a small badge)
// shows. Opening the row reveals the value, actions and details.
function sigItem(name, badges, chips, isFresh, cap, warn) {
  const key = (cap && cap.key) || name;
  const hasValue = cap && typeof cap.value === "string";
  const jwt = cap && cap.jwt;
  const dec = hasValue && jwt ? decodeJwt(tokenFromValue(cap.value)) : null;

  const head = [el("span", { class: "sig-name", text: name })];
  for (const b of badges || []) head.push(chip(b.text, b.kind));
  if (jwt) head.push(chip("JWT", String(jwt.alg).toLowerCase() === "none" ? "warn" : "good"));
  if (warn) head.push(el("span", { class: "warn-mark", title: "Needs attention" }, icon("i-alert")));
  if (isFresh) head.push(chip("New", "new"));

  const body = [];
  if (jwt) {
    const ex = jwtExpiry(jwt);
    const jc = [{ text: `JWT: ${jwt.alg}`, kind: String(jwt.alg).toLowerCase() === "none" ? "warn" : "good" }];
    if (ex) jc.push({ text: ex.text, kind: ex.kind });
    chips = jc.concat(chips || []);
    if (jwt.claims && jwt.claims.length) body.push(el("p", { class: "note", text: `Claims: ${jwt.claims.join(", ")}` }));
  }
  if (hasValue) {
    body.push(
      el("code", { class: "val", text: cap.value }),
      el(
        "div",
        { class: "row tight" },
        el("button", {
          class: "small",
          type: "button",
          "aria-label": `Copy value of ${name}`,
          text: "Copy",
          onclick: () => copyText(cap.value, "Copied.")
        }),
        dec
          ? el("button", {
              class: "small",
              type: "button",
              "aria-pressed": String(ui.decoded.has(key)),
              "aria-label": `${ui.decoded.has(key) ? "Hide" : "Show"} decoded JWT of ${name}`,
              text: ui.decoded.has(key) ? "Hide decoded" : "Decode",
              onclick: () => {
                if (ui.decoded.has(key)) ui.decoded.delete(key);
                else ui.decoded.add(key);
                render();
              }
            })
          : null
      )
    );
    if (dec && ui.decoded.has(key)) {
      body.push(el("pre", { class: "val pre", text: JSON.stringify({ header: dec.header, payload: dec.payload }, null, 2) }));
    }
  }
  if (chips && chips.length) {
    const c = el("div", { class: "chips" });
    for (const x of chips) c.append(chip(x.text, x.kind));
    body.push(c);
  }

  const cls = `rowitem${isFresh ? " fresh" : ""}`;
  if (!body.length) return el("li", { style: "list-style:none" }, el("div", { class: `${cls} plain` }, el("div", { class: "rowhead" }, ...head)));
  return el(
    "li",
    { style: "list-style:none" },
    el(
      "details",
      { class: cls, ...remember("row:" + key) },
      el("summary", { class: "rowhead" }, ...head),
      el("div", { class: "rowbody" }, ...body)
    )
  );
}

function group(title, items, action) {
  if (!items.length) return null;
  const g = el("section", { class: "group", "aria-label": title }, el("h3", { text: `${title} (${items.length})` }));
  if (action) g.append(action);
  const ul = el("ul", { class: "plain", style: "padding:0;margin:0" });
  for (const i of items) ul.append(i);
  g.append(ul);
  return g;
}

function cookieItem(c) {
  const chips = [];
  if (c.cls.reason) {
    chips.push({ text: c.cls.reason, kind: c.cls.level === "auth" ? "good" : c.cls.level === "maybe" ? "uncertain" : "" });
  }
  const weak = c.meta && (!c.meta.secure || !c.meta.httpOnly || c.meta.sameSite === "None" || c.meta.sameSite === "unspecified");
  return sigItem(c.name, [], chips.concat(attrChips(c.meta)), ui.fresh.has(c.key), c, c.cls.level === "auth" && weak);
}

function nameChips(list) {
  const c = el("div", { class: "chips names" });
  for (const s of list) c.append(el("span", { class: "chip mono", text: s.name }));
  return c;
}

// Not authentication, and often dozens of them. Kept minimal, collapsed by
// default, and always last, so it never competes with the real signals.
function othersSection(g) {
  const count = g.standard.length + g.custom.length;
  if (!count) return null;
  const mem = remember("others");
  const d = el(
    "details",
    {
      class: "others minimal",
      // With no credential found, show the header names right away so nothing is hidden.
      open: mem.open || g.total === 0,
      ontoggle: mem.ontoggle
    },
    el("summary", { text: `Other headers (${count})` })
  );
  if (g.custom.length) d.append(el("p", { class: "mini-label", text: "Custom" }), nameChips(g.custom));
  if (g.standard.length) d.append(el("p", { class: "mini-label", text: "Standard" }), nameChips(g.standard));
  return d;
}

function collapsible(key, title, items) {
  if (!items.length) return null;
  const d = el("details", { class: "others", ...remember(key) }, el("summary", { text: `${title} (${items.length})` }));
  const ul = el("ul", { class: "plain", style: "padding:0;margin:0" });
  for (const i of items) ul.append(i);
  d.append(ul);
  return d;
}

function qrow(i) {
  const warn = i.kind === "warn";
  return el(
    "li",
    { class: `qrow${warn ? " warn" : ""}` },
    icon(warn ? "i-alert" : "i-info"),
    el("span", { text: i.text })
  );
}

// Short reading of the evidence, closed by default. Color only on rows that need attention.
function quickRead(insights) {
  const warns = insights.filter((i) => i.kind === "warn");
  const notes = insights.filter((i) => i.kind !== "warn");
  const d = el(
    "details",
    { class: "others", "aria-label": "Quick read", ...remember("quick") },
    el(
      "summary",
      null,
      el("span", { text: "Quick read" }),
      warns.length ? chip(`${warns.length} ${warns.length === 1 ? "warning" : "warnings"}`, "warn") : null
    )
  );
  const list = (items) => {
    const ul = el("ul", { class: "qr-list" });
    for (const i of items) ul.append(qrow(i));
    return ul;
  };
  if (warns.length) d.append(el("h3", { class: "qr-title", text: "Needs attention" }), list(warns));
  if (notes.length) {
    if (warns.length) d.append(el("h3", { class: "qr-title", text: "Notes" }));
    d.append(list(notes));
  }
  return d;
}

// One click copy of the session cookies as a Cookie header value.
function cookieHeaderButton(cookies) {
  const withValues = cookies.filter((c) => typeof c.value === "string");
  if (!withValues.length) return null;
  return el("button", {
    class: "small",
    type: "button",
    text: "Copy as Cookie header",
    onclick: () => copyText(withValues.map((c) => `${c.name}=${c.value}`).join("; "), "Copied.")
  });
}

function groupNodes(g, isNew, prefix) {
  const sess = g.cookieGroups.auth.concat(g.cookieGroups.maybe);
  const groups = [
    group(
      "Authorization",
      g.authorization.map((s) =>
        sigItem(
          s.name,
          [{ text: s.scheme, kind: s.scheme === "Unrecognized scheme" || s.scheme === "No scheme" ? "uncertain" : "good" }],
          [],
          isNew(s.key),
          s
        )
      )
    ),
    group("Session cookies", sess.map((c) => cookieItem(c)), cookieHeaderButton(sess)),
    collapsible(prefix + "cookies-other", "Other cookies", g.cookieGroups.other.map((c) => cookieItem(c))),
    collapsible(prefix + "cookies-tracking", "Tracking cookies", g.cookieGroups.tracking.map((c) => cookieItem(c))),
    group("API keys", g.apikey.map((s) => sigItem(s.name, [], [], isNew(s.key), s))),
    group("CSRF", g.csrf.map((s) => sigItem(s.name, [], [], isNew(s.key), s))),
    group(
      "Unclear headers",
      g.uncertain.map((s) => sigItem(s.name, [{ text: s.via === "url" ? "In URL" : "Unclear", kind: "uncertain" }], [], isNew(s.key), s))
    ),
    collapsible(
      prefix + "cookies-store",
      "Other browser cookies",
      g.cookiesMetaOnly.map((m) => sigItem(m.name, [], attrChips(m), false, { key: "meta:" + (m.origin || "") + m.name, value: m.value }))
    )
  ];
  return groups.filter(Boolean);
}

function menuItem(id, text, fn) {
  return el(
    "button",
    {
      type: "button",
      id,
      class: "menu-item",
      role: "menuitem",
      onclick: () => {
        ui.exportOpen = false;
        render();
        fn();
      }
    },
    el("span", { text })
  );
}

// One button that opens a small panel with every copy and export choice, so
// the row never grows past one button as more formats are added.
function exportMenu(hasValues) {
  const items = [
    menuItem("copy", "Copy summary", onCopy),
    hasValues ? menuItem("copy-full", "Copy for AI, with values", onCopyFull) : null,
    menuItem("copy-json", hasValues ? "Copy as JSON, with values" : "Copy as JSON", onCopyJSON),
    hasValues ? menuItem("export", "Download JSON file", onExport) : null
  ].filter(Boolean);
  return el(
    "div",
    { class: "menu" },
    el(
      "button",
      {
        class: "primary",
        type: "button",
        id: "export-menu",
        "aria-haspopup": "true",
        "aria-expanded": String(ui.exportOpen),
        onclick: (e) => {
          e.stopPropagation();
          ui.exportOpen = !ui.exportOpen;
          render();
        }
      },
      icon("i-copy"),
      el("span", { text: "Export" })
    ),
    ui.exportOpen ? el("div", { class: "menu-panel", role: "menu" }, ...items) : null
  );
}

function viewActive(state) {
  const g = groupSignals(state);
  const isNew = (key) => ui.fresh.has(key);
  const credentialSignals = Object.values(state.signals || {}).filter((s) => s.type !== "other");
  const hasValues = credentialSignals.some((s) => typeof s.value === "string");
  // Cookie values refresh live once Show values is on, but a header or token
  // seen before that can only be captured again from a new request.
  const missingValues = ui.capture && credentialSignals.some((s) => s.type !== "cookie" && typeof s.value !== "string");
  const kids = [];

  kids.push(
    el(
      "div",
      { class: "status active" },
      icon("i-check"),
      el("span", { text: `${state.auto ? "Auto" : "Inspecting"}: ${g.total} ${g.total === 1 ? "signal" : "signals"}` })
    )
  );

  kids.push(
    el(
      "div",
      { class: "row" },
      exportMenu(hasValues),
      state.auto
        ? el("button", { type: "button", id: "clear", onclick: onClear }, el("span", { text: "Clear" }))
        : el(
            "button",
            { class: "danger", type: "button", id: "stop", onclick: onStop },
            icon("i-stop"),
            el("span", { text: "Stop" })
          )
    )
  );

  if (missingValues) {
    kids.push(
      el("p", {
        class: "note",
        text: "Some header or token values were seen before Show values was on. Reload the page to capture them."
      })
    );
  }

  if (g.total === 0) {
    kids.push(
      el("p", { class: "note", text: "Waiting for requests." }),
      ui.diag && ui.diag.ok
        ? el("p", {
            class: "note",
            id: "diag",
            text:
              ui.diag.seen > 0
                ? `Requests seen: ${ui.diag.seen}. None carried credentials yet.`
                : ui.diag.access
                  ? "Requests seen: 0. Reload the page."
                  : "Requests seen: 0. Site access is missing. Press Turn off auto, then Enable again."
          })
        : null,
      el(
        "div",
        { class: "row" },
        el("button", { class: "small", type: "button", id: "reload", onclick: onReload }, el("span", { text: "Reload tab" }))
      )
    );
  }

  const ins = buildInsights(g);
  if (ins.length) kids.push(quickRead(ins));

  const sections = originsOf(state);
  sections.forEach((o, i) => {
    const sub = groupSignals(signalsOfOrigin(state, o));
    const nodes = groupNodes(sub, isNew, i === 0 ? "" : o + "|");
    if (i > 0 && !nodes.length) return;
    if (sections.length > 1) {
      kids.push(el("h2", { class: "origin-head", text: i === 0 ? `This site: ${o}` : `Other origin: ${o}` }));
    }
    for (const n of nodes) kids.push(n);
  });

  if (hasMixedEvidence(g)) kids.push(el("p", { class: "note", text: MIXED_SHORT }));
  if (state.scope !== "tab") kids.push(el("p", { class: "note", text: SCOPE_SHORT }));

  // Not credentials: always last, so it never pushes real signals down.
  const oth = othersSection(g);
  if (oth) kids.push(oth);

  return el("section", { class: "card", "aria-label": "Inspection" }, ...kids);
}

function footer() {
  return el(
    "div",
    { class: "footer" },
    el(
      "label",
      { class: "check small" },
      el("input", {
        type: "checkbox",
        id: "capture",
        checked: ui.capture,
        onchange: async (e) => {
          ui.capture = e.target.checked;
          await chrome.storage.local.set({ capture: ui.capture });
          if (ui.capture) {
            say("Cookie values are live already. Reload the page to also capture header and token values.", false);
            setTimeout(() => say(""), 6000);
          }
        }
      }),
      el("span", { text: "Show values" })
    ),
    ui.auto
      ? el("button", { class: "link", type: "button", id: "auto-off", onclick: onAutoOff, text: "Turn off auto" })
      : null
  );
}

// ---- Render ---------------------------------------------------------------

function render() {
  renderHeader();
  const tab = ui.tab;
  const origin = parseSupportedOrigin(tab && (tab.url || tab.pendingUrl));
  main.replaceChildren();

  if (!tab) {
    main.append(message("warn", "i-alert", "No active tab."));
    return;
  }
  if (!origin) {
    main.append(viewUnsupported());
    return;
  }

  const st = ui.state && ui.state.origin === origin && (!ui.state.auto || ui.auto) ? ui.state : null;
  if (st || ui.auto) {
    const state = st || { origin, tabId: tab.id, startedAt: 0, auto: true, scope: "tab", signals: {}, cookieMeta: [] };
    // Mark signals that appeared after the first render for this tab and origin.
    const keys = Object.keys(state.signals || {});
    const id = `${tab.id}:${origin}`;
    if (ui.seen === null || ui.seenFor !== id) {
      ui.seen = new Set(keys);
      ui.seenFor = id;
      ui.fresh = new Set();
    } else {
      let added = false;
      for (const k of keys) {
        if (!ui.seen.has(k)) {
          ui.seen.add(k);
          ui.fresh.add(k);
          added = true;
        }
      }
      if (added) {
        setTimeout(() => {
          ui.fresh.clear();
          if (ui.state) render();
        }, 8000);
      }
    }
    main.append(viewActive(state));
    const n = groupSignals(state).total;
    const line = `${state.auto ? "Auto" : "Inspecting"}: ${n} ${n === 1 ? "signal" : "signals"}`;
    if ($("live").textContent !== line) $("live").textContent = line;
  } else {
    $("live").textContent = "";
    ui.seen = null;
    ui.fresh = new Set();
      ui.decoded.clear();
    main.append(viewOff(origin));
  }
  main.append(footer());
}

// ---- Actions ----------------------------------------------------------------

// The permission request must be the first async call inside the click.
function onEnable() {
  ui.denied = false;
  ui.failure = "";
  // Remember the intent. The browser prompt can close this popup, so the
  // background finishes the setup when the access is added.
  chrome.storage.local.set({ pendingAuto: true });
  chrome.permissions
    .request({ origins: ALL_SITES })
    .then(async (granted) => {
      await chrome.storage.local.set({ pendingAuto: false });
      if (!granted) {
        ui.denied = true;
        render();
        const b = $("enable");
        if (b) b.focus();
        return;
      }
      await chrome.storage.local.set({ auto: true });
      await refresh(false);
      const b = $("copy") || $("clear");
      if (b) b.focus();
    })
    .catch(() => {
      ui.denied = true;
      render();
    });
}

function onStart(origin) {
  const tab = ui.tab;
  ui.denied = false;
  ui.failure = "";
  chrome.permissions
    .request({ origins: [permissionPattern(origin)] })
    .then(async (granted) => {
      if (!granted) {
        ui.denied = true;
        render();
        const b = $("start");
        if (b) b.focus();
        return;
      }
      const res = await chrome.runtime.sendMessage({ type: "start", tabId: tab.id });
      if (!res || !res.ok) ui.failure = "Could not start. Try again.";
      await refresh(false);
      const b = $("stop");
      if (b) b.focus();
      else {
        const s = $("start");
        if (s) s.focus();
      }
    })
    .catch(() => {
      ui.denied = true;
      render();
    });
}

async function onStop() {
  await chrome.runtime.sendMessage({ type: "stop", tabId: ui.tab.id });
  ui.decoded.clear();
  ui.denied = false;
  ui.failure = "";
  say("");
  await refresh(false);
  const b = $("start");
  if (b) b.focus();
}

async function onClear() {
  await chrome.runtime.sendMessage({ type: "clear", tabId: ui.tab.id });
  ui.decoded.clear();
  ui.seen = null;
  say("");
  await refresh(false);
}

async function onAutoOff() {
  await chrome.storage.local.set({ auto: false });
  ui.decoded.clear();
  await refresh(false);
  const b = $("enable");
  if (b) b.focus();
}

async function onReload() {
  if (!ui.tab) return;
  try {
    await chrome.runtime.sendMessage({ type: "rearm" });
  } catch {
    // Worker not reachable: reload anyway.
  }
  chrome.tabs.reload(ui.tab.id);
}

function onCopy() {
  if (ui.state) copyText(buildClipboardText(ui.state), "Copied.");
}

function onCopyFull() {
  if (ui.state) copyText(buildFullText(ui.state), "Copied with values.");
}

// Includes whatever values are currently captured. Nothing extra to pick:
// turn Show values on and this (and the file export below) follow it.
function onCopyJSON() {
  if (!ui.state) return;
  const hasValues = Object.values(ui.state.signals || {}).some((s) => typeof s.value === "string");
  copyText(buildJSON(ui.state, hasValues), hasValues ? "Copied as JSON with values." : "Copied as JSON.");
}

// Downloads a JSON file: the cookies in the browser's own cookie shape (paste
// that array straight into Cookie-Editor's Import dialog) plus the headers
// and JWTs this tab observed. Never writes anything back to the browser.
async function onExport() {
  if (!ui.state || !ui.tab) return;
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "export", tabId: ui.tab.id });
  } catch {
    res = null;
  }
  if (!res || !res.ok) {
    say("Turn on Show values first.", true);
    return;
  }
  const g = groupSignals(ui.state);
  const headers = [];
  for (const s of g.authorization) headers.push({ type: "authorization", name: s.name, scheme: s.scheme, value: s.value, jwt: s.jwt });
  for (const s of g.apikey) headers.push({ type: "apikey", name: s.name, value: s.value, jwt: s.jwt });
  for (const s of g.csrf) headers.push({ type: "csrf", name: s.name, value: s.value, jwt: s.jwt });
  for (const s of g.uncertain) headers.push({ type: "uncertain", name: s.name, value: s.value, jwt: s.jwt });
  const payload = {
    tool: "AuthTracer",
    exportedAt: new Date().toISOString(),
    origin: ui.state.origin,
    cookies: res.cookies,
    headers
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `authtracer-${safeHostname(ui.state.origin) || "export"}-${Date.now()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  say("Exported.", false);
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    say(okMessage, false);
  } catch {
    try {
      const ta = el("textarea", { "aria-hidden": "true", style: "position:fixed;opacity:0" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      say(ok ? okMessage : "Copy failed.", !ok);
    } catch {
      say("Copy failed.", true);
    }
  }
  setTimeout(() => say(""), 3000);
}

// ---- Live updates -----------------------------------------------------------

// Only react to changes that concern this tab, so other tabs never wake this popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" || changes.lastEnded || (ui.tab && changes[`insp:${ui.tab.id}`])) refresh(false);
});
chrome.tabs.onActivated.addListener(() => {
  if (!forcedTab) {
    ui.denied = false;
    ui.failure = "";
    refresh(true);
  }
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const watching = forcedTab || (ui.tab && ui.tab.id);
  if (tabId !== watching) return;
  if (info.url || info.title || info.favIconUrl || info.status === "complete") {
    if (info.url) {
      ui.denied = false;
      ui.failure = "";
    }
    refresh(!!info.url);
  }
});

// Closes the Export menu on an outside click or Escape. The toggle button
// itself stops its click from reaching here, so opening it still works.
document.addEventListener("click", () => {
  if (ui.exportOpen) {
    ui.exportOpen = false;
    render();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.exportOpen) {
    ui.exportOpen = false;
    render();
    const b = $("export-menu");
    if (b) b.focus();
  }
});

refresh(true);
