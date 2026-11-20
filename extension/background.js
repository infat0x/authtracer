// AuthTracer background service worker (Manifest V3).
//
// Two modes:
//  - Auto: the user enabled it once. Every tab is observed and gets its own
//    state, created on its first request and reset when the tab changes origin.
//  - Manual: "Only this site". One tab and origin, ends when the tab closes or
//    leaves the origin.
//
// All listeners are registered at the top level so the browser can wake this
// worker after suspension. Per tab state lives in chrome.storage.session
// (memory only, cleared when the browser restarts). Values are kept only while
// the user's "Show values" preference is on.

import { extractSignals, extractOthers, extractQuery, addSignal, cookieMetaFrom } from "./lib/signals.js";
import { parseSupportedOrigin, permissionPattern } from "./lib/origin.js";

const PREFIX = "insp:";
const ENDED = "lastEnded";
const ALL_SITES = ["http://*/*", "https://*/*"];

const REASONS = {
  tab_closed: "Stopped. Tab closed.",
  origin_changed: "Stopped. Site changed.",
  permission_lost: "Stopped. Access removed.",
  unavailable: "Stopped. Start again."
};

// Diagnostics: how many requests the browser delivered per tab since this worker started.
const seenByTab = new Map();
const workerStart = Date.now();

const keyOf = (tabId) => PREFIX + tabId;
const valid = (s) => s && typeof s.tabId === "number" && typeof s.origin === "string";

// Per tab state lives in memory and is copied to chrome.storage.session shortly
// after a change, so the popup and a restarted worker can read it. Memory is
// bounded: MAX_TABS tabs, 40 header names and 20 extra origins per tab.
const MAX_TABS = 40;
const states = new Map();
const dirty = new Set();
const skip = new Set(); // tabs whose page cannot be inspected (browser pages)
let P = { auto: false, capture: true };
let isReady = false;
const ready = (async () => {
  const [all, l] = await Promise.all([
    chrome.storage.session.get(null),
    chrome.storage.local.get(["auto", "capture"])
  ]);
  for (const [k, v] of Object.entries(all)) if (k.startsWith(PREFIX) && valid(v)) states.set(v.tabId, v);
  P = { auto: l.auto === true, capture: l.capture !== false };
  isReady = true;
})();

// Serialize all state changes so concurrent events cannot overwrite each other.
let chain = Promise.resolve();
function mutate(fn) {
  const next = chain.then(() => ready).then(fn);
  chain = next.catch(() => {});
  return next;
}

const load = async (tabId) => states.get(tabId) || null;
const loadAll = async () => [...states.values()];
const prefs = async () => {
  await ready;
  return P;
};

chrome.action.setBadgeBackgroundColor({ color: "#3f7a5e" });
// The browser clears a tab's badge when it navigates, so this is also called on load.
function badge(s) {
  const n = Object.values(s.signals).filter((x) => x.type !== "other").length;
  chrome.action.setBadgeText({ tabId: s.tabId, text: n ? String(n) : "" }).catch(() => {});
}

let flushT = 0;
async function flush() {
  clearTimeout(flushT);
  flushT = 0;
  const out = {};
  for (const id of dirty) {
    const s = states.get(id);
    if (s) {
      out[keyOf(id)] = s;
      badge(s);
    }
  }
  dirty.clear();
  if (!Object.keys(out).length) return;
  try {
    await chrome.storage.session.set(out);
  } catch {
    // Quota reached: forget the oldest tabs and carry on.
    for (const s of [...states.values()].sort((x, y) => (x.t || 0) - (y.t || 0)).slice(0, 5)) await drop(s.tabId);
  }
}

async function save(state) {
  state.t = Date.now();
  states.set(state.tabId, state);
  dirty.add(state.tabId);
  if (states.size > MAX_TABS) {
    const old = [...states.values()].filter((x) => x.tabId !== state.tabId).sort((x, y) => (x.t || 0) - (y.t || 0))[0];
    if (old) await drop(old.tabId);
  }
  if (!flushT) flushT = setTimeout(flush, 300);
}

async function drop(tabId) {
  states.delete(tabId);
  dirty.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.storage.session.remove(keyOf(tabId));
}

chrome.runtime.onSuspend.addListener(() => {
  flush();
});

// Cookie attributes are re-read at most every 500 ms per burst of changes.
const cookieDirty = new Set();
let cookieT = 0;
function markCookies(tabId) {
  cookieDirty.add(tabId);
  if (cookieT) return;
  cookieT = setTimeout(() => {
    cookieT = 0;
    const ids = [...cookieDirty];
    cookieDirty.clear();
    mutate(async () => {
      for (const id of ids) {
        const st = states.get(id);
        if (!st) continue;
        await refreshCookies(st);
        await save(st);
      }
    });
  }, 500);
}

// Requests of the new origin that arrived before the tab navigation was reported
// were stored as "other origin" results. Move them to the new main origin.
function carryOver(old, fresh) {
  const o = fresh.origin;
  for (const [k, v] of Object.entries((old && old.signals) || {})) {
    if (v.origin !== o) continue;
    const { origin: _drop, ...rest } = v;
    fresh.signals[k.slice(o.length + 1)] = { ...rest, key: rest.key.slice(o.length + 1) };
  }
  for (const m of (old && old.cookieMeta) || []) {
    if (m.origin !== o) continue;
    const { origin: _drop, ...rest } = m;
    fresh.cookieMeta.push(rest);
  }
  return fresh;
}

function newState(tabId, origin, auto, scope) {
  return {
    tabId,
    origin,
    startedAt: Date.now(),
    auto,
    scope: auto ? "tab" : scope || "origin",
    signals: {},
    cookieMeta: []
  };
}

const patternsFor = (state) => (state.scope === "tab" ? ALL_SITES : [permissionPattern(state.origin)]);

// Remove site access that nothing needs any more.
async function releasePermissions(removed) {
  if ((await prefs()).auto) return;
  const keep = new Set((await loadAll()).flatMap(patternsFor));
  const drop = patternsFor(removed).filter((p) => !keep.has(p));
  if (!drop.length) return;
  try {
    await chrome.permissions.remove({ origins: drop });
  } catch {
    // Already removed.
  }
}

async function endInspection(state, reason) {
  await drop(state.tabId);
  if (!state.auto) {
    await chrome.storage.session.set({
      [ENDED]: { tabId: state.tabId, origin: state.origin, reason, text: REASONS[reason] || "" }
    });
    await releasePermissions(state);
  }
}

async function refreshCookies(state) {
  const { capture } = await prefs();
  const origins = [state.origin];
  for (const s of Object.values(state.signals || {})) {
    if (s.origin && !origins.includes(s.origin)) origins.push(s.origin);
  }
  const meta = [];
  for (const o of origins.slice(0, 21)) {
    try {
      const cookies = await chrome.cookies.getAll({ url: o });
      for (const m of cookieMetaFrom(cookies, capture)) {
        meta.push(o === state.origin ? m : { ...m, origin: o });
      }
    } catch {
      // No access to this origin: skip it.
    }
  }
  state.cookieMeta = meta;
  state.ct = Date.now();
  return state;
}

function stripValues(state) {
  for (const s of Object.values(state.signals || {})) delete s.value;
  for (const m of state.cookieMeta || []) delete m.value;
}

// Is the stored state still valid? Returns the (possibly replaced) state or null.
async function validate(state) {
  if (!state) return null;
  let tab;
  try {
    tab = await chrome.tabs.get(state.tabId);
  } catch {
    await endInspection(state, "tab_closed");
    return null;
  }
  const o = parseSupportedOrigin(tab.url || tab.pendingUrl);
  if (o !== state.origin) {
    if (state.auto) {
      if (!o) {
        await drop(state.tabId);
        return null;
      }
      const fresh = carryOver(state, newState(state.tabId, o, true));
      await save(fresh);
      return fresh;
    }
    await endInspection(state, "origin_changed");
    return null;
  }
  if (!state.auto) {
    let ok = false;
    try {
      ok = await chrome.permissions.contains({ origins: patternsFor(state) });
    } catch {
      ok = false;
    }
    if (!ok) {
      await endInspection(state, "permission_lost");
      return null;
    }
  }
  return state;
}

// If auto mode lost its site access, switch it off cleanly.
async function validateAuto() {
  if (!(await prefs()).auto) return;
  let ok = false;
  try {
    ok = await chrome.permissions.contains({ origins: ALL_SITES });
  } catch {
    ok = false;
  }
  if (!ok) await chrome.storage.local.set({ auto: false });
}

// ---- Request observation -------------------------------------------------

// True when this request adds nothing new to the tab's results.
function allKnown(state, signals, o) {
  const foreign = o !== state.origin;
  for (const s0 of signals) {
    if (foreign && s0.type === "other") continue;
    const cur = state.signals[foreign ? `${o}|${s0.key}` : s0.key];
    if (!cur) {
      if (s0.type === "other" && (state.oc || 0) >= 40) continue;
      return false;
    }
    if (P.capture && s0.value !== undefined && cur.value !== s0.value) return false;
    if (s0.jwt && (!cur.jwt || cur.jwt.exp !== s0.jwt.exp || cur.jwt.alg !== s0.jwt.alg)) return false;
  }
  return true;
}

function onRequest(details) {
    const tabId = details.tabId;
    if (tabId < 0) return;
    seenByTab.set(tabId, (seenByTab.get(tabId) || 0) + 1);
    let st = null;
    let o = null;
    if (isReady) {
      st = states.get(tabId) || null;
      // Cheapest exits first: nothing watches this tab, it is a browser page,
      // or the request goes to another origin and this tab only watches one.
      if ((!st && !P.auto) || skip.has(tabId)) return;
      if (st) {
        o = parseSupportedOrigin(details.url);
        if (!o || (o !== st.origin && st.scope !== "tab")) return;
      }
    }
    // Reduce headers to signals right away, then drop the headers. Values are
    // stripped below unless the user's "Show values" preference is on.
    const signals = extractSignals(details.requestHeaders, true).concat(
      extractOthers(details.requestHeaders),
      details.url.includes("?") ? extractQuery(details.url, true) : []
    );
    if (signals.length === 0) return;
    // Repeated requests carry nothing new: skip the queue entirely.
    if (st && allKnown(st, signals, o)) return;
    const url = details.url;
    mutate(async () => {
      const o = parseSupportedOrigin(url);
      if (!o) return;
      const { auto, capture } = await prefs();
      let state = await load(tabId);
      if (!state) {
        if (!auto || skip.has(tabId)) return;
        let tab;
        try {
          tab = await chrome.tabs.get(tabId);
        } catch {
          return;
        }
        const main = parseSupportedOrigin(tab.pendingUrl || tab.url);
        if (!main) {
          skip.add(tabId);
          return;
        }
        state = newState(tabId, main, true);
      }
      const foreign = o !== state.origin;
      if (foreign && state.scope !== "tab") return;
      if (foreign) {
        const known = new Set(Object.values(state.signals).map((x) => x.origin).filter(Boolean));
        if (!known.has(o) && known.size >= 20) return;
      }
      if (!capture) for (const s of signals) delete s.value;
      const now = Date.now();
      let changed = false;
      let newCookie = false;
      let otherCount = Object.values(state.signals).filter((x) => x.type === "other").length;
      for (const s0 of signals) {
        if (foreign && s0.type === "other") continue;
        const s = foreign ? { ...s0, key: `${o}|${s0.key}`, origin: o } : s0;
        if (s.type === "other") {
          if (state.signals[s.key] || otherCount >= 40) continue;
          otherCount++;
        }
        if (addSignal(state.signals, s, now)) {
          changed = true;
          if (s.type === "cookie") newCookie = true;
        }
      }
      state.oc = otherCount;
      if (!changed) return;
      if (newCookie) markCookies(tabId);
      await save(state);
    });
}

const REQ_FILTER = {
  urls: ["<all_urls>"],
  // Credentials travel on these. Images, fonts, styles and media add cost, not signal.
  types: ["main_frame", "sub_frame", "xmlhttprequest", "websocket", "ping", "other"]
};

// A listener registered before the site access was granted may not see the
// newly granted sites. Registering it again after the grant fixes that.
function armRequests() {
  chrome.webRequest.onBeforeSendHeaders.removeListener(onRequest);
  chrome.webRequest.onBeforeSendHeaders.addListener(onRequest, REQ_FILTER, ["requestHeaders", "extraHeaders"]);
}
armRequests();

const hostMatches = (cookieDomain, origin) => {
  try {
    const host = new URL(origin).hostname;
    const d = String(cookieDomain || "").replace(/^\./, "");
    return d !== "" && (host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
};

chrome.cookies.onChanged.addListener((info) => {
  const domain = info && info.cookie && info.cookie.domain;
  mutate(async () => {
    for (const state of states.values()) {
      const origins = [state.origin, ...Object.values(state.signals).map((s) => s.origin).filter(Boolean)];
      if (origins.some((o) => hostMatches(domain, o))) markCookies(state.tabId);
    }
  });
});

// ---- Lifecycle -------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  skip.delete(tabId);
  seenByTab.delete(tabId);
  mutate(async () => {
    const state = await load(tabId);
    if (state) await endInspection(state, "tab_closed");
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && states.has(tabId)) badge(states.get(tabId));
  if (!changeInfo.url) return;
  skip.delete(tabId);
  mutate(async () => {
    const state = await load(tabId);
    if (!state) return;
    const o = parseSupportedOrigin(changeInfo.url);
    if (o === state.origin) return;
    if (state.auto) {
      if (o) await save(carryOver(state, newState(tabId, o, true)));
      else await drop(tabId);
    } else {
      await endInspection(state, "origin_changed");
    }
  });
});

async function finishPendingAuto() {
  const l = await chrome.storage.local.get("pendingAuto");
  if (!l.pendingAuto) return;
  let ok = false;
  try {
    ok = await chrome.permissions.contains({ origins: ALL_SITES });
  } catch {
    ok = false;
  }
  if (ok) await chrome.storage.local.set({ auto: true, pendingAuto: false });
}

chrome.permissions.onAdded.addListener(() => {
  armRequests();
  mutate(finishPendingAuto);
});

chrome.permissions.onRemoved.addListener(() => {
  mutate(async () => {
    for (const state of await loadAll()) await validate(state);
    await validateAuto();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.auto) P = { ...P, auto: changes.auto.newValue === true };
  if (changes.auto && changes.auto.newValue === true && changes.auto.oldValue !== true) {
    armRequests();
    reloadOpenTabs(); // outside the queue: it takes a moment
  }
  if (changes.capture) P = { ...P, capture: changes.capture.newValue !== false };
  if (changes.capture && changes.capture.newValue === false) {
    mutate(async () => {
      for (const state of states.values()) {
        stripValues(state);
        await save(state);
      }
    });
  }
  if (changes.capture && changes.capture.newValue !== false) {
    mutate(async () => {
      for (const state of states.values()) markCookies(state.tabId);
    });
  }
  if (changes.auto && changes.auto.newValue !== true) {
    mutate(async () => {
      for (const state of [...states.values()]) if (state.auto) await drop(state.tabId);
      if (![...states.values()].some((s) => s.scope === "tab")) {
        try {
          await chrome.permissions.remove({ origins: ALL_SITES });
        } catch {
          // Not granted.
        }
      }
    });
  }
});

// Tabs that were open before auto mode started already sent their requests.
// Reload each one once so its signals appear without any extra step.
async function reloadOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return;
  }
  let n = 0;
  for (const t of tabs) {
    if (t.id == null || t.discarded || n >= 100) continue; // discarded tabs load on their own later
    n++;
    try {
      await chrome.tabs.reload(t.id);
    } catch {
      // The tab went away.
    }
    await new Promise((r) => setTimeout(r, 120)); // spread the load
  }
}

// After a browser restart session storage is empty. Keep access only if auto
// mode is on, otherwise release anything left over.
async function releaseLeftoverAccess() {
  if ((await prefs()).auto) return;
  if ((await loadAll()).length) return;
  try {
    const all = await chrome.permissions.getAll();
    const origins = (all.origins || []).filter((o) => /^https?:\/\//.test(o));
    if (origins.length) await chrome.permissions.remove({ origins });
  } catch {
    // Nothing to release.
  }
}
chrome.runtime.onStartup.addListener(() => mutate(releaseLeftoverAccess));
chrome.runtime.onInstalled.addListener(() => mutate(releaseLeftoverAccess));

// ---- Messages from the popup ------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension's own pages.
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return false;
  const tabId = msg.tabId;

  if (msg.type === "start") {
    mutate(async () => {
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return { ok: false, error: "tab_missing" };
      }
      const origin = parseSupportedOrigin(tab.url);
      if (!origin) return { ok: false, error: "unsupported" };
      const scope = msg.allOrigins === true ? "tab" : "origin";
      const needed = scope === "tab" ? ALL_SITES : [permissionPattern(origin)];
      if (!(await chrome.permissions.contains({ origins: needed }))) {
        return { ok: false, error: "no_permission" };
      }
      await chrome.storage.session.remove(ENDED);
      const state = newState(tabId, origin, false, scope);
      await refreshCookies(state);
      await save(state);
      await flush();
      return { ok: true };
    }).then(sendResponse, () => sendResponse({ ok: false, error: "failed" }));
    return true;
  }

  if (msg.type === "stop" || msg.type === "clear") {
    mutate(async () => {
      const state = await load(tabId);
      if (state) {
        await drop(tabId);
        if (!state.auto) await releasePermissions(state);
      }
      await chrome.storage.session.remove(ENDED);
      await flush();
      return { ok: true };
    }).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "sync") {
    mutate(async () => {
      await finishPendingAuto();
      await validateAuto();
      const state = await validate(await load(tabId));
      // Cookie attributes are re-read only when they are older than 5 seconds.
      if (state && Date.now() - (state.ct || 0) > 5000) {
        await refreshCookies(state);
        await save(state);
      }
      await flush();
      return { ok: true };
    }).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "export") {
    (async () => {
      const { capture } = await prefs();
      if (!capture) return { ok: false, error: "capture_off" };
      const state = await load(tabId);
      if (!state) return { ok: false, error: "no_state" };
      // Only the cookies currently shown for this tab, as the raw objects the
      // cookies API returns. That shape is what Cookie-Editor itself exports,
      // so the array can be pasted straight into its own Import dialog.
      const meta = state.cookieMeta || [];
      const names = new Set(meta.map((m) => `${m.origin || state.origin}|${m.name}`));
      const origins = [state.origin, ...new Set(meta.map((m) => m.origin).filter(Boolean))];
      const cookies = [];
      for (const o of origins.slice(0, 21)) {
        try {
          for (const c of await chrome.cookies.getAll({ url: o })) {
            if (names.has(`${o}|${c.name}`)) cookies.push(c);
          }
        } catch {
          // No access to this origin.
        }
      }
      return { ok: true, cookies };
    })().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "rearm") {
    armRequests();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "diag") {
    (async () => {
      let access = false;
      try {
        access = await chrome.permissions.contains({ origins: ALL_SITES });
      } catch {
        access = false;
      }
      return { ok: true, seen: seenByTab.get(tabId) || 0, access, since: workerStart };
    })().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "dismiss") {
    chrome.storage.session.remove(ENDED).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
