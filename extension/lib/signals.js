// Classification and sanitization of request headers.
// Rule: header values are read here once, reduced to sanitized metadata, and
// never returned, stored or logged. Only names, schemes and flags leave.

const KNOWN_SCHEMES = [
  "Bearer",
  "Basic",
  "Digest",
  "Negotiate",
  "NTLM",
  "Token",
  "ApiKey",
  "AWS4-HMAC-SHA256",
  "HOBA",
  "Mutual",
  "OAuth",
  "SCRAM-SHA-256"
];

const API_KEY_HEADERS = new Set([
  "x-api-key",
  "api-key",
  "apikey",
  "x-apikey",
  "x-api-token",
  "x-access-token",
  "ocp-apim-subscription-key",
  "x-functions-key",
  "x-goog-api-key",
  "x-rapidapi-key"
]);

const CSRF_HEADERS = new Set([
  "x-csrf-token",
  "x-xsrf-token",
  "csrf-token",
  "xsrf-token",
  "x-csrftoken",
  "x-csrf",
  "x-csrf-header",
  "x-xsrf",
  "anti-csrf-token"
]);

const NAME_OK = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const UNCERTAIN_HINT = /(auth|token|key|secret|session|sign|credential|csrf|xsrf|nonce|jwt|ticket)/i;
const UNCERTAIN_PREFIX = /^x-/i;

// Header names that contain a hint word (for example "key" or "token") but
// follow a well-known convention for a non-secret id, not a credential. These
// keep the Unclear group focused on names that are genuinely ambiguous.
const NOT_CREDENTIAL_HINT =
  /(idempotency|cache[-_]?key|partition[-_]?key|shard[-_]?key|routing[-_]?key|dedup(e|lication)?[-_]?key|correlation|trace|span|transaction|txn[-_]?id|order[-_]?id|message[-_]?id|event[-_]?id|operation[-_]?id|job[-_]?id|workflow[-_]?id|request[-_]?id)/i;

// Headers that mention auth words but are not credentials in practice.
const IGNORED = new Set([
  "x-forwarded-for",
  "x-requested-with",
  "x-client-data",
  "sec-websocket-key",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-version"
]);

// ---- JWT helpers -------------------------------------------------------------
const B64URL = /^[A-Za-z0-9_-]+$/;

function b64urlToText(part) {
  let t = part.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Value of an Authorization style header without its scheme word.
export function tokenFromValue(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  const sp = v.search(/\s/);
  if (sp === -1) return v;
  const word = v.slice(0, sp);
  if (KNOWN_SCHEMES.some((x) => x.toLowerCase() === word.toLowerCase())) return v.slice(sp + 1).trim();
  // A site specific scheme word (for example "Education <jwt>"): use the last part if it is JWT shaped.
  const last = v.match(/\S+$/)[0];
  return /^[\w-]+\.[\w-]+\.[\w-]*$/.test(last) ? last : v;
}

// Full decode, used only where the token value is legitimately available.
export function decodeJwt(token) {
  if (typeof token !== "string" || token.length > 8192) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  if (!B64URL.test(parts[0]) || !B64URL.test(parts[1]) || (parts[2] && !B64URL.test(parts[2]))) return null;
  try {
    const header = JSON.parse(b64urlToText(parts[0]));
    const payload = JSON.parse(b64urlToText(parts[1]));
    if (!header || typeof header !== "object" || typeof header.alg !== "string") return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return { header, payload };
  } catch {
    return null;
  }
}

const CLAIM_OK = /^[\w:./-]{1,60}$/;

// Light metadata that is safe to keep: algorithm, claim names, time claims.
export function jwtMeta(value) {
  const d = decodeJwt(tokenFromValue(value));
  if (!d) return null;
  const alg = /^[A-Za-z0-9_+-]{1,20}$/.test(d.header.alg) ? d.header.alg : "unknown";
  const num = (n) => (Number.isFinite(n) ? n : undefined);
  const meta = {
    alg,
    claims: Object.keys(d.payload).filter((k) => CLAIM_OK.test(k)).slice(0, 20)
  };
  if (typeof d.header.typ === "string" && /^[A-Za-z0-9+._-]{1,20}$/.test(d.header.typ)) meta.typ = d.header.typ;
  if (num(d.payload.exp) !== undefined) meta.exp = d.payload.exp;
  if (num(d.payload.iat) !== undefined) meta.iat = d.payload.iat;
  if (num(d.payload.nbf) !== undefined) meta.nbf = d.payload.nbf;
  return meta;
}
const jw = (v) => {
  const m = jwtMeta(v);
  return m ? { jwt: m } : {};
};

export function cleanName(name) {
  if (typeof name !== "string") return null;
  const n = name.trim();
  return NAME_OK.test(n) ? n : null;
}

export function schemeOf(value) {
  if (typeof value !== "string") return { scheme: null, label: "No scheme" };
  const trimmed = value.trim();
  const space = trimmed.search(/\s/);
  // A single token has no scheme, so that token is the credential itself.
  if (space === -1) return { scheme: null, label: "No scheme" };
  const word = trimmed.slice(0, space);
  const known = KNOWN_SCHEMES.find((s) => s.toLowerCase() === word.toLowerCase());
  if (known) return { scheme: known, label: known };
  return { scheme: null, label: "Unrecognized scheme" };
}

const MAX_VALUE = 8192;
const cap = (v) => (typeof v === "string" ? v.slice(0, MAX_VALUE) : undefined);

// Returns [{name, value}] from a Cookie header. Callers decide whether the
// value may be kept.
export function cookiePairs(headerValue) {
  if (typeof headerValue !== "string") return [];
  const out = [];
  for (const part of headerValue.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = cleanName(part.slice(0, eq));
    if (name && !out.some((o) => o.name === name)) {
      out.push({ name, value: cap(part.slice(eq + 1).trim()) });
    }
  }
  return out;
}

export function cookieNames(headerValue) {
  return cookiePairs(headerValue).map((p) => p.name);
}

// Returns a list of signals for one request. The input headers are the
// browser-provided array of {name, value}. With withValues false (default) no
// value is copied. With true, each signal also carries a value field, and the
// caller must drop it unless the user turned on value capture.
export function extractSignals(headers, withValues = false) {
  const val = (v) => (withValues ? { value: cap(v) } : {});
  const out = [];
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (!h || typeof h.name !== "string") continue;
    const lower = h.name.toLowerCase();
    if (lower === "authorization" || lower === "proxy-authorization") {
      const s = schemeOf(h.value);
      out.push({
        key: `authorization:${lower}:${s.label}`,
        type: "authorization",
        name: lower === "authorization" ? "Authorization" : "Proxy-Authorization",
        scheme: s.label,
        ...jw(h.value),
        ...val(h.value)
      });
    } else if (lower === "cookie") {
      for (const c of cookiePairs(h.value)) {
        out.push({ key: `cookie:${c.name}`, type: "cookie", name: c.name, ...jw(c.value), ...val(c.value) });
      }
    } else if (IGNORED.has(lower)) {
      continue;
    } else if (API_KEY_HEADERS.has(lower)) {
      const name = cleanName(h.name);
      if (name) out.push({ key: `apikey:${lower}`, type: "apikey", name, ...jw(h.value), ...val(h.value) });
    } else if (CSRF_HEADERS.has(lower)) {
      const name = cleanName(h.name);
      if (name) out.push({ key: `csrf:${lower}`, type: "csrf", name, ...jw(h.value), ...val(h.value) });
    } else if (UNCERTAIN_HINT.test(h.name) && !STANDARD.test(h.name) && !NOT_CREDENTIAL_HINT.test(h.name)) {
      const name = cleanName(h.name);
      if (name) out.push({ key: `uncertain:${lower}`, type: "uncertain", name, ...jw(h.value), ...val(h.value) });
    } else if (jwtMeta(h.value) || tokenShaped(h)) {
      // Any other header that carries a JWT or a long opaque value is worth showing.
      const name = cleanName(h.name);
      if (name) out.push({ key: `uncertain:${lower}`, type: "uncertain", name, ...jw(h.value), ...val(h.value) });
    }
  }
  return out;
}

const SAME_SITE = {
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
  unspecified: "unspecified"
};

// Builds metadata from chrome.cookies results. The cookie value is read only
// when withValues is true (user turned on value capture).
export function cookieMetaFrom(cookies, withValues = false) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(cookies)) return out;
  for (const c of cookies) {
    const name = cleanName(c && c.name);
    if (!name) continue;
    const id = `${name}|${c.domain || ""}|${c.path || ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      name,
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      sameSite: SAME_SITE[c.sameSite] || "unspecified",
      persistent: typeof c.expirationDate === "number",
      ...jw(c.value),
      ...(withValues ? { value: cap(c.value) } : {})
    });
  }
  return out;
}

// Adds a signal to a map keyed by signal key. Returns true if it was new.
// A changed value (for example a rotated token) updates the entry and also
// returns true so it gets saved.
export function addSignal(map, signal, now) {
  const cur = map[signal.key];
  if (!cur) {
    map[signal.key] = { ...signal, firstSeen: now };
    return true;
  }
  if (signal.value !== undefined && cur.value !== signal.value) {
    cur.value = signal.value;
    if (signal.jwt) cur.jwt = signal.jwt;
    return true;
  }
  if (signal.jwt && JSON.stringify(signal.jwt) !== JSON.stringify(cur.jwt)) {
    cur.jwt = signal.jwt;
    return true;
  }
  return false;
}

const STANDARD =
  /^(accept|accept-.*|user-agent|host|connection|content-.*|origin|referer|sec-.*|cache-control|pragma|upgrade-insecure-requests|dnt|te|priority|if-.*|range|purpose|expect|keep-alive|upgrade|via|forwarded|save-data|x-requested-with|x-forwarded-.*|x-client-data)$/i;

function isAuthHeader(name) {
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "proxy-authorization" || lower === "cookie") return true;
  if (API_KEY_HEADERS.has(lower) || CSRF_HEADERS.has(lower)) return true;
  if (IGNORED.has(lower)) return false;
  return UNCERTAIN_HINT.test(name) && !STANDARD.test(name) && !NOT_CREDENTIAL_HINT.test(name);
}

// Header names that are not authentication related. Names only, never values.
export function extractOthers(headers) {
  const out = [];
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (!h || typeof h.name !== "string" || isAuthHeader(h.name) || jwtMeta(h.value) || tokenShaped(h)) continue;
    const name = cleanName(h.name);
    if (!name) continue;
    out.push({
      key: `other:${name.toLowerCase()}`,
      type: "other",
      group: STANDARD.test(name) ? "standard" : "custom",
      name
    });
  }
  return out;
}

const TRACKING =
  /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|_dd_|dd_|_octo|datadome|__utm|_hj|_clck|_clsk|amplitude|mp_|ajs_|optimizely|_pk_|__hs|hubspot|__cf|_cfuvid|cf_clearance|_uetsid|_uetvid|_scid|IDE$|NID$|_pin_|_tt_|_rdt_)/i;
const PREFERENCE =
  /(color_mode|theme|lang|locale|^tz$|timezone|consent|^ghcc$|cookie_?(notice|banner|accept)|^ui_|bucket|currency|region|dismiss)/i;
const AUTH_NAME =
  /(sess|auth|token|jwt|^sid$|[_-]sid$|^sid[_-]|login|logged|account|remember|sso|credential|secret|csrf|xsrf|user)/i;

// Best guess about what a cookie is for. This is a heuristic, not proof.
// level: "auth" | "maybe" | "tracking" | "preference" | "other"
export function classifyCookie(name, meta) {
  if (TRACKING.test(name)) return { level: "tracking", reason: "Tracking or analytics" };
  if (PREFERENCE.test(name)) return { level: "preference", reason: "Preference" };
  if (AUTH_NAME.test(name)) return { level: "auth", reason: "Session or login" };
  if (meta && meta.httpOnly && meta.secure) {
    return { level: "maybe", reason: "Possibly auth: HttpOnly and Secure" };
  }
  return { level: "other", reason: "" };
}

// Names that carry long ids that are not credentials (tracing, versions, cache tags).
const BORING = /(trace|span|baggage|version|etag|b3|datadog|sentry|^cf-|request-id|correlation)/i;

// A custom header whose value looks like an opaque token: long, no spaces, letters and digits.
function tokenShaped(h) {
  return (
    typeof h.value === "string" &&
    !STANDARD.test(h.name) &&
    !BORING.test(h.name) &&
    !NOT_CREDENTIAL_HINT.test(h.name) &&
    /^[A-Za-z0-9._~+\/=-]{32,}$/.test(h.value) &&
    /\d/.test(h.value) &&
    /[A-Za-z]/.test(h.value)
  );
}

const QUERY_HINT = /(token|key|auth|session|sid|jwt|ticket|secret|sig|credential|bearer)/i;

// URL parameters whose name suggests a credential. Names always, values only on request.
export function extractQuery(url, withValues = false) {
  const out = [];
  let u;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  let n = 0;
  for (const [k, v] of u.searchParams) {
    if (++n > 30) break;
    if (!QUERY_HINT.test(k) || !/^[\w.\[\]-]{1,40}$/.test(k)) continue;
    out.push({ key: `query:${k}`, type: "uncertain", name: `?${k}`, via: "url", ...jw(v), ...(withValues ? { value: cap(v) } : {}) });
  }
  return out;
}
