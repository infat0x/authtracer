// Grouping and clipboard formatting. Works only on sanitized state.

import { classifyCookie } from "./signals.js";

export const REDACTED = "<REDACTED>";

// How confident we are that a signal is itself a real authentication
// credential, not just a header or cookie that happens to look like one.
// Only changes display order within a group; it never hides or regroups
// anything. Higher is more confident:
//   +5/+6  a JWT was decoded here (a genuine exp claim adds the extra point)
//   +4     Authorization with a recognized scheme, or a cookie name/flags
//          that match a session cookie (classifyCookie level "auth")
//   +3     a known API key header name
//   +2     a known CSRF header name, or a cookie that is merely HttpOnly
//          and Secure without a recognizable name (level "maybe")
//   +1     Authorization with no or an unrecognized scheme, or a header
//          whose name alone made it Unclear
//   +0.5   the same, but only seen in a URL query parameter
export function signalConfidence(s) {
  let score = 0;
  if (s.jwt) score += typeof s.jwt.exp === "number" ? 6 : 5;
  switch (s.type) {
    case "authorization":
      score += s.scheme && s.scheme !== "No scheme" && s.scheme !== "Unrecognized scheme" ? 4 : 1;
      break;
    case "cookie":
      score += s.cls && s.cls.level === "auth" ? 4 : s.cls && s.cls.level === "maybe" ? 2 : 0;
      if (s.meta && s.meta.httpOnly && s.meta.secure) score += 1;
      break;
    case "apikey":
      score += 3;
      break;
    case "csrf":
      score += 2;
      break;
    case "uncertain":
      score += s.via === "url" ? 0.5 : 1;
      break;
  }
  return score;
}
// A stable sort, so items of equal confidence keep the order they first
// appeared in, with the most credential-like signal in a group shown first.
const byConfidence = (a, b) => signalConfidence(b) - signalConfidence(a);

export function groupSignals(state) {
  const list = Object.values((state && state.signals) || {});
  const byTime = (t) => list.filter((s) => s.type === t).sort((a, b) => a.firstSeen - b.firstSeen);
  const by = (t) => byTime(t).sort(byConfidence);
  const meta = (state && state.cookieMeta) || [];
  // Cookies need their classification and attributes attached before they can
  // be scored, so they are sorted by confidence only after that is done.
  const sentKeys = new Set(byTime("cookie").map((s) => `${s.origin || ""}|${s.name}`));
  const cookiesSent = byTime("cookie")
    .map((s) => {
      const meta2 = meta.find((m) => m.name === s.name && (m.origin || "") === (s.origin || "")) || null;
      // The cookie store is read fresh every time, so its value is never stale.
      // The value on the request signal itself can be: it was captured once,
      // possibly before Show values was on, and is never refreshed after that.
      const value = meta2 && typeof meta2.value === "string" ? meta2.value : s.value;
      return { ...s, value, meta: meta2, cls: classifyCookie(s.name, meta2) };
    })
    .sort(byConfidence);
  const byName = (a, b) => a.name.localeCompare(b.name);
  // cookiesSent is already ranked, so a filter alone keeps that order; only the
  // de-emphasized buckets (tracking, other) go back to a plain alphabetical list.
  const cg = (lv, ranked) => {
    const found = cookiesSent.filter((c) => c.cls.level === lv);
    return ranked ? found : found.sort(byName);
  };
  return {
    authorization: by("authorization"),
    cookieGroups: { auth: cg("auth", true), maybe: cg("maybe", true), tracking: cg("tracking", false), other: cookiesSent.filter((c) => c.cls.level === "preference" || c.cls.level === "other").sort(byName) },
    cookiesSent,
    cookiesMetaOnly: meta.filter((m) => !sentKeys.has(`${m.origin || ""}|${m.name}`)),
    apikey: by("apikey"),
    csrf: by("csrf"),
    uncertain: by("uncertain"),
    standard: by("other").filter((s) => s.group === "standard"),
    custom: by("other").filter((s) => s.group === "custom"),
    total: list.filter((s) => s.type !== "other").length
  };
}

export function attributeList(meta) {
  if (!meta) return null;
  const a = [];
  a.push(meta.secure ? "Secure" : "No Secure");
  a.push(meta.httpOnly ? "HttpOnly" : "No HttpOnly");
  a.push(`SameSite=${meta.sameSite}`);
  return a;
}

export function hasMixedEvidence(g) {
  const kinds = [
    g.authorization.length > 0,
    g.cookiesSent.length > 0,
    g.apikey.length > 0
  ].filter(Boolean).length;
  return kinds >= 2;
}

export const MIXED_NOTE =
  "More than one credential type was sent. Which one the server accepted is unknown.";
export const VISIBILITY_NOTE =
  "Only requests from this tab to this origin are visible. Requests to other origins, such as a separate API host, are not observed.";
export const MIXED_SHORT = "Cookie and token both sent. Server choice unknown.";
export const SCOPE_SHORT = "Only this site is visible.";
export const TAB_SCOPE_NOTE =
  "Requests from this tab to any origin are visible. Requests from other tabs are not observed.";
export const scopeNote = (state) => (state && state.scope === "tab" ? TAB_SCOPE_NOTE : VISIBILITY_NOTE);

// Origins that have signals: the selected site first, then the others.
export function originsOf(state) {
  const rest = new Set();
  for (const s of Object.values((state && state.signals) || {})) if (s.origin) rest.add(s.origin);
  return [state.origin, ...[...rest].sort()];
}

// A state that only contains one origin's signals and cookie metadata.
export function signalsOfOrigin(state, origin) {
  const mine = (x) => (x.origin || state.origin) === origin;
  const signals = {};
  for (const [k, v] of Object.entries(state.signals || {})) if (mine(v)) signals[k] = v;
  return { ...state, origin, signals, cookieMeta: (state.cookieMeta || []).filter(mine) };
}

const hostOf = (o) => {
  try {
    return new URL(o).host;
  } catch {
    return o;
  }
};
const at = (s) => (s && s.origin ? ` at ${hostOf(s.origin)}` : "");

export const EMPTY_NOTE =
  "No signals observed so far. Use the site, for example sign in or load a page. No signals does not prove the site has no authentication.";

function sectionLines(g) {
  const lines = [];
  for (const s of g.authorization) {
    lines.push(`${s.name}: ${s.scheme} ${REDACTED}${s.jwt ? ` [${jwtNote(s.jwt)}]` : ""}`);
  }
  for (const c of g.cookiesSent) {
    const attrs = attributeList(c.meta);
    lines.push(
      `Cookie: ${c.name}=${REDACTED} [${attrs ? attrs.join(", ") : "attributes unavailable"}]${c.jwt ? ` [${jwtNote(c.jwt)}]` : ""}`
    );
  }
  const likely = g.cookieGroups.auth.map((c) => c.name);
  if (likely.length) lines.push(`Likely session cookies: ${likely.join(", ")}`);
  const tag = (s) => (s.jwt ? ` [${jwtNote(s.jwt)}]` : "");
  for (const s of g.apikey) lines.push(`API key header: ${s.name} ${REDACTED}${tag(s)}`);
  for (const s of g.csrf) lines.push(`CSRF header: ${s.name} ${REDACTED}${tag(s)}`);
  for (const s of g.uncertain) {
    lines.push(`Header with uncertain meaning: ${s.name} ${REDACTED}${tag(s)}`);
  }
  for (const m of g.cookiesMetaOnly) {
    lines.push(
      `Cookie metadata only, not observed on a request: ${m.name} [${attributeList(m).join(", ")}]`
    );
  }
  return lines;
}

export function buildClipboardText(state) {
  const lines = [];
  let total = 0;
  let mixed = false;
  originsOf(state).forEach((o, i) => {
    const g = groupSignals(signalsOfOrigin(state, o));
    total += g.total + g.cookiesMetaOnly.length;
    mixed = mixed || hasMixedEvidence(g);
    const body = sectionLines(g);
    if (i > 0 && body.length === 0) return;
    if (i > 0) lines.push("");
    lines.push(`Origin: ${o}`, ...body);
  });
  if (total === 0) lines.push("No authentication signals observed.");
  if (mixed) lines.push(`Note: ${MIXED_NOTE}`);
  lines.push(`Scope: ${scopeNote(state)}`);
  return lines.join("\n");
}

function sectionFull(g) {
  const v = (x) => (typeof x === "string" ? x : "<value not captured>");
  const lines = [];
  for (const s of g.authorization) lines.push(`${s.name}: ${v(s.value)}`);
  for (const c of g.cookiesSent) {
    const attrs = attributeList(c.meta);
    lines.push(
      `Cookie: ${c.name}=${v(c.value)} [${attrs ? attrs.join(", ") : "attributes unavailable"}]`
    );
  }
  for (const s of g.apikey) lines.push(`API key header: ${s.name}: ${v(s.value)}`);
  for (const s of g.csrf) lines.push(`CSRF header: ${s.name}: ${v(s.value)}`);
  for (const s of g.uncertain) lines.push(`Header with uncertain meaning: ${s.name}: ${v(s.value)}`);
  for (const m of g.cookiesMetaOnly) {
    lines.push(
      `Cookie from store, not seen on a request: ${m.name}=${v(m.value)} [${attributeList(m).join(", ")}]`
    );
  }
  return lines;
}

// Full copy with real values. Only meaningful when value capture was on.
export function buildFullText(state) {
  const lines = [];
  let total = 0;
  originsOf(state).forEach((o, i) => {
    const g = groupSignals(signalsOfOrigin(state, o));
    total += g.total + g.cookiesMetaOnly.length;
    const body = sectionFull(g);
    if (i > 0 && body.length === 0) return;
    if (i > 0) lines.push("");
    lines.push(`Origin: ${o}`, ...body);
  });
  if (total === 0) lines.push("No authentication signals observed.");
  return lines.join("\n");
}

// Structured JSON version of the same evidence, for machine or AI consumption.
function sectionJSON(g, withValues) {
  const pack = (s) => {
    const o = { name: s.name };
    if (s.scheme) o.scheme = s.scheme;
    if (withValues && typeof s.value === "string") o.value = s.value;
    if (s.jwt) o.jwt = s.jwt;
    return o;
  };
  const packCookie = (c) => {
    const o = { name: c.name };
    const attrs = attributeList(c.meta);
    if (attrs) o.attributes = attrs;
    if (withValues && typeof c.value === "string") o.value = c.value;
    if (c.jwt) o.jwt = c.jwt;
    return o;
  };
  return {
    authorization: g.authorization.map(pack),
    sessionCookies: g.cookieGroups.auth.concat(g.cookieGroups.maybe).map(packCookie),
    otherCookies: g.cookieGroups.other.concat(g.cookieGroups.tracking).map(packCookie),
    apikey: g.apikey.map(pack),
    csrf: g.csrf.map(pack),
    uncertain: g.uncertain.map(pack)
  };
}

const sectionHasData = (s) => Object.values(s).some((v) => v.length);

// Structured report: the same evidence as buildClipboardText/buildFullText, as
// an object ready for JSON.stringify. withValues false keeps it sanitized.
export function buildReport(state, withValues) {
  const sites = [];
  originsOf(state).forEach((o, i) => {
    const section = sectionJSON(groupSignals(signalsOfOrigin(state, o)), withValues);
    if (i > 0 && !sectionHasData(section)) return;
    sites.push({ origin: o, ...section });
  });
  return {
    tool: "AuthTracer",
    exportedAt: new Date().toISOString(),
    scope: state.scope === "tab" ? "tab" : "origin",
    redacted: !withValues,
    sites
  };
}

export function buildJSON(state, withValues) {
  return JSON.stringify(buildReport(state, withValues), null, 2);
}

const list = (arr) => {
  const names = arr.map((c) => c.name);
  return names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
};

// Short plain language reading of the evidence. kind: info or warn
export function buildInsights(g) {
  const out = [];
  const strong = g.cookieGroups.auth;
  for (const s of g.authorization) {
    out.push({ kind: "info", text: `${s.name}${at(s)}: ${s.scheme}` });
  }
  if (strong.length) out.push({ kind: "info", text: `Session cookies: ${list(strong)}` });
  if (!g.authorization.length && strong.length) {
    out.push({ kind: "info", text: "No Authorization header. Cookie session likely." });
  }
  const noHttp = strong.filter((c) => c.meta && !c.meta.httpOnly);
  if (noHttp.length) out.push({ kind: "warn", text: `No HttpOnly: ${list(noHttp)}` });
  const noSecure = strong.filter((c) => c.meta && !c.meta.secure);
  if (noSecure.length) out.push({ kind: "warn", text: `No Secure flag: ${list(noSecure)}` });
  const weakSame = strong.filter((c) => c.meta && (c.meta.sameSite === "None" || c.meta.sameSite === "unspecified"));
  if (weakSame.length) out.push({ kind: "warn", text: `Weak SameSite: ${list(weakSame)}` });
  for (const j of collectJwts(g)) {
    const ex = jwtExpiry(j.jwt);
    const noneAlg = String(j.jwt.alg).toLowerCase() === "none";
    if (noneAlg) {
      out.push({ kind: "warn", text: `Unsigned JWT (alg none) in ${j.where}` });
    } else {
      out.push({
        kind: ex && ex.expired ? "warn" : "info",
        text: `JWT in ${j.where}: ${j.jwt.alg}${ex ? ", " + ex.text.toLowerCase() : ""}`
      });
    }
  }
  if (g.csrf.length) {
    out.push({ kind: "info", text: `CSRF header: ${g.csrf.map((s) => s.name).join(", ")}` });
  } else if (strong.length) {
    out.push({ kind: "info", text: "No CSRF header seen." });
  }
  if (g.uncertain.length) {
    out.push({ kind: "info", text: `Unclear headers: ${g.uncertain.map((s) => s.name).join(", ")}` });
  }
  return out;
}

// ---- JWT summaries -----------------------------------------------------------
function human(ms) {
  const a = Math.abs(ms) / 1000;
  if (a < 60) return `${Math.round(a)} s`;
  if (a < 3600) return `${Math.round(a / 60)} min`;
  if (a < 172800) return `${Math.round(a / 3600)} h`;
  return `${Math.round(a / 86400)} days`;
}

export function jwtExpiry(jwt, now = Date.now()) {
  if (!jwt) return null;
  if (typeof jwt.exp !== "number") return { text: "No expiry claim", kind: "uncertain", expired: false };
  const diff = jwt.exp * 1000 - now;
  return diff < 0
    ? { text: `Expired ${human(diff)} ago`, kind: "warn", expired: true }
    : { text: `Expires in ${human(diff)}`, kind: "good", expired: false };
}

export function jwtNote(jwt) {
  const parts = [`JWT alg=${jwt.alg}`];
  if (typeof jwt.exp === "number") parts.push(`exp=${new Date(jwt.exp * 1000).toISOString()}`);
  if (jwt.claims && jwt.claims.length) parts.push(`claims: ${jwt.claims.join(" ")}`);
  return parts.join(", ");
}

// Every place a JWT was seen: [{where, jwt}]
export function collectJwts(g) {
  const out = [];
  for (const s of g.authorization) if (s.jwt) out.push({ where: `${s.name} header${at(s)}`, jwt: s.jwt });
  for (const c of g.cookiesSent) if (c.jwt) out.push({ where: `cookie ${c.name}${at(c)}`, jwt: c.jwt });
  for (const s of g.apikey.concat(g.csrf, g.uncertain)) if (s.jwt) out.push({ where: `header ${s.name}${at(s)}`, jwt: s.jwt });
  for (const m of g.cookiesMetaOnly) if (m.jwt) out.push({ where: `cookie ${m.name} (cookie store)`, jwt: m.jwt });
  return out;
}
