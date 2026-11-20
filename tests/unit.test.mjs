import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSignals, extractOthers, extractQuery, classifyCookie, jwtMeta, decodeJwt, tokenFromValue, cookieMetaFrom, addSignal, schemeOf } from "../extension/lib/signals.js";
import { buildClipboardText, buildJSON, groupSignals, hasMixedEvidence, originsOf, signalsOfOrigin, signalConfidence } from "../extension/lib/format.js";
import { parseSupportedOrigin, permissionPattern } from "../extension/lib/origin.js";

const SECRET = {
  bearer: "SYNTH-BEARER-7f3a91c2d4e5",
  basic: "U1lOVEhVU0VSOlNZTlRIUEFTUw==",
  session: "SYNTH-SESSION-b8c1d2e3f4",
  api: "SYNTH-APIKEY-55aa66bb77cc",
  csrf: "SYNTH-CSRF-99ee88dd77",
  custom: "SYNTH-CUSTOM-1a2b3c4d"
};
const H = (name, value) => ({ name, value });

test("Bearer and Basic keep the scheme only", () => {
  const s = extractSignals([H("Authorization", `Bearer ${SECRET.bearer}`)]);
  assert.equal(s[0].scheme, "Bearer");
  const b = extractSignals([H("authorization", `Basic ${SECRET.basic}`)]);
  assert.equal(b[0].scheme, "Basic");
  assert.ok(!JSON.stringify([s, b]).includes("SYNTH"));
  assert.ok(!JSON.stringify([s, b]).includes(SECRET.basic));
});

test("a bare Authorization token is never treated as a scheme", () => {
  assert.equal(schemeOf(SECRET.bearer).label, "No scheme");
  assert.equal(schemeOf(`${SECRET.bearer} extra`).label, "Unrecognized scheme");
  const s = extractSignals([H("Authorization", SECRET.bearer)]);
  assert.ok(!JSON.stringify(s).includes(SECRET.bearer));
});

test("cookie names are kept, values are not", () => {
  const s = extractSignals([H("Cookie", `session=${SECRET.session}; theme=dark; =bad; x`)]);
  assert.deepEqual(s.map((x) => x.name), ["session", "theme"]);
  assert.ok(!JSON.stringify(s).includes(SECRET.session));
});

test("API key, CSRF and uncertain headers are classified", () => {
  const s = extractSignals([
    H("X-API-Key", SECRET.api),
    H("X-CSRF-Token", SECRET.csrf),
    H("X-Custom-Token", SECRET.custom),
    H("X-Requested-With", "XMLHttpRequest"),
    H("Accept", "*/*"),
    H("User-Agent", "x")
  ]);
  const types = Object.fromEntries(s.map((x) => [x.name, x.type]));
  assert.deepEqual(types, {
    "X-API-Key": "apikey",
    "X-CSRF-Token": "csrf",
    "X-Custom-Token": "uncertain"
  });
  assert.ok(!JSON.stringify(s).includes("SYNTH"));
});

test("hostile header names are rejected", () => {
  const s = extractSignals([H("X-Token <img src=x>", "v"), H("x-api-key\n", "v")]);
  assert.equal(s.length, 1); // trimmed newline name is a valid api key name
  assert.ok(!JSON.stringify(s).includes("<"));
});

test("deduplication", () => {
  const map = {};
  const [a] = extractSignals([H("Authorization", "Bearer x")]);
  assert.equal(addSignal(map, a, 1), true);
  assert.equal(addSignal(map, a, 2), false);
  assert.equal(Object.keys(map).length, 1);
});

test("cookie metadata never reads the value", () => {
  const meta = cookieMetaFrom([
    { name: "session", value: SECRET.session, domain: "a", path: "/", secure: true, httpOnly: true, sameSite: "lax" },
    { name: "session", value: SECRET.session, domain: "a", path: "/", secure: true },
    { name: "pref", value: "1", domain: "a", path: "/", sameSite: "no_restriction", expirationDate: 99 }
  ]);
  assert.equal(meta.length, 2);
  assert.deepEqual(meta[0], { name: "session", secure: true, httpOnly: true, sameSite: "Lax", persistent: false });
  assert.ok(!JSON.stringify(meta).includes("SYNTH"));
});

function stateWith(headersList, cookies) {
  const signals = {};
  let t = 1;
  for (const h of headersList) for (const s of extractSignals(h)) addSignal(signals, s, t++);
  return { origin: "https://test.example", tabId: 1, startedAt: 1, signals, cookieMeta: cookieMetaFrom(cookies || []) };
}

test("clipboard output matches the example and has no secrets", () => {
  const st = stateWith(
    [
      [H("Authorization", `Bearer ${SECRET.bearer}`), H("Cookie", `session=${SECRET.session}`)],
      [H("X-CSRF-Token", SECRET.csrf)]
    ],
    [{ name: "session", value: SECRET.session, domain: "test.example", path: "/", secure: true, httpOnly: true, sameSite: "lax" }]
  );
  const text = buildClipboardText(st);
  assert.match(text, /^Origin: https:\/\/test\.example$/m);
  assert.match(text, /^Authorization: Bearer <REDACTED>$/m);
  assert.match(text, /^Cookie: session=<REDACTED> \[Secure, HttpOnly, SameSite=Lax\]$/m);
  assert.match(text, /^CSRF header: X-CSRF-Token <REDACTED>$/m);
  assert.match(text, /Which one the server accepted is unknown/);
  assert.ok(!text.includes("SYNTH"));
  assert.ok(!/[\u2013\u2014]/.test(text));
  assert.equal(hasMixedEvidence(groupSignals(st)), true);
});

test("empty inspection output", () => {
  const text = buildClipboardText(stateWith([], []));
  assert.match(text, /No authentication signals observed\./);
});

test("cookie metadata only is labelled as not observed", () => {
  const text = buildClipboardText(
    stateWith([], [{ name: "pref", value: "v", domain: "a", path: "/", sameSite: "strict" }])
  );
  assert.match(text, /Cookie metadata only, not observed on a request: pref \[No Secure, No HttpOnly, SameSite=Strict\]/);
});

test("origins and unsupported pages", () => {
  assert.equal(parseSupportedOrigin("https://a.example/p?q=1#x"), "https://a.example");
  assert.equal(parseSupportedOrigin("http://localhost:8080/x"), "http://localhost:8080");
  for (const u of ["chrome://extensions", "edge://settings", "about:blank", "file:///c:/x", "chrome-extension://abc/p.html", "view-source:https://a.example", "", null, "https://chromewebstore.google.com/detail/x"]) {
    assert.equal(parseSupportedOrigin(u), null, String(u));
  }
  assert.equal(permissionPattern("http://localhost:8080"), "http://localhost/*");
});

test("manifest permissions are minimal and host access is optional", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ["cookies", "favicon", "storage", "tabs", "webRequest"]);
  assert.equal(m.host_permissions, undefined);
  assert.deepEqual(m.optional_host_permissions, ["http://*/*", "https://*/*"]);
  for (const bad of ["webRequestBlocking", "declarativeNetRequest", "scripting", "debugger", "clipboardRead", "history"]) {
    assert.ok(!m.permissions.includes(bad));
  }
});

function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("no emojis, em dashes or en dashes in the extension source", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
  for (const f of walk(dir).filter((p) => /\.(js|html|css|json|svg)$/.test(p))) {
    const t = readFileSync(f, "utf8");
    assert.ok(!/[\u2013\u2014]/.test(t), `dash in ${f}`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(t), `emoji in ${f}`);
  }
});

test("no network, logging or remote code in the extension source", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
  for (const f of walk(dir).filter((p) => /\.(js|html)$/.test(p))) {
    const t = readFileSync(f, "utf8");
    assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|console\.|eval\(|innerHTML|chrome\.storage\.local\.set\(\{[^}]*signals/.test(t), `forbidden call in ${f}`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(t.replace(/"https?:\/\/\*\/\*"/g, "")), `external URL in ${f}`);
  }
});

test("values are attached only when explicitly requested", () => {
  const hdr = [H("Authorization", `Bearer ${SECRET.bearer}`), H("Cookie", `session=${SECRET.session}; a=b`), H("X-API-Key", SECRET.api)];
  assert.ok(!JSON.stringify(extractSignals(hdr)).includes("SYNTH"));
  const withV = extractSignals(hdr, true);
  assert.equal(withV.find((s) => s.type === "authorization").value, `Bearer ${SECRET.bearer}`);
  assert.equal(withV.find((s) => s.name === "session").value, SECRET.session);
  assert.equal(withV.find((s) => s.type === "apikey").value, SECRET.api);
  const map = {};
  for (const s of withV) addSignal(map, s, 1);
  const rotated = extractSignals([H("Authorization", "Bearer NEW-TOKEN-1")], true)[0];
  assert.equal(addSignal(map, rotated, 2), true);
  assert.equal(map[rotated.key].value, "Bearer NEW-TOKEN-1");
  assert.equal(map[rotated.key].firstSeen, 1);
});

test("non-auth headers are listed by name only and split into standard and custom", () => {
  const o = extractOthers([
    H("User-Agent", "SYNTH-UA"), H("Accept", "*/*"), H("Sec-Fetch-Mode", "cors"), H("X-Trace-Id", "SYNTH-T"),
    H("Authorization", "Bearer SYNTH-B"), H("Cookie", "a=SYNTH-C"), H("X-API-Key", "SYNTH-K"), H("X-Custom-Token", "SYNTH-X")
  ]);
  const by = Object.fromEntries(o.map((x) => [x.name, x.group]));
  assert.deepEqual(by, { "User-Agent": "standard", Accept: "standard", "Sec-Fetch-Mode": "standard", "X-Trace-Id": "custom" });
  assert.ok(!JSON.stringify(o).includes("SYNTH"));
});

test("cookie classification separates session, tracking and preference cookies", () => {
  const lv = (n, m) => classifyCookie(n, m).level;
  for (const n of ["user_session", "_gh_sess", "logged_in", "dotcom_user", "saved_user_sessions", "sid", "JSESSIONID", "auth_token", "csrftoken"]) {
    assert.equal(lv(n), "auth", n);
  }
  for (const n of ["_dd_s_v2", "datadome", "_octo", "_ga", "_ga_ABC123", "dd_cookie_test_x", "cf_clearance"]) {
    assert.equal(lv(n), "tracking", n);
  }
  for (const n of ["color_mode", "preferred_color_mode", "tz", "GHCC", "ui_eligible", "cpu_bucket"]) {
    assert.equal(lv(n), "preference", n);
  }
  assert.equal(lv("__Host-ghlw", { secure: true, httpOnly: true }), "maybe");
  assert.equal(lv("last_write_ms", { secure: true, httpOnly: false }), "other");
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "SYNTH-SUBJECT", role: "admin", exp: 4102444800 })}.c2lnbmF0dXJl`;
const JWT_NONE = `${b64({ alg: "none" })}.${b64({ sub: "SYNTH-SUBJECT" })}.`;

test("JWTs are recognised in Authorization, cookies and other headers without keeping values", () => {
  const sigs = extractSignals([
    H("Authorization", `Bearer ${JWT}`),
    H("Cookie", `access=${JWT}; theme=dark`),
    H("X-Id-Token", JWT)
  ]);
  const auth = sigs.find((s) => s.type === "authorization");
  assert.equal(auth.jwt.alg, "HS256");
  assert.deepEqual(auth.jwt.claims, ["sub", "role", "exp"]);
  assert.equal(auth.jwt.exp, 4102444800);
  assert.equal(sigs.find((s) => s.name === "access").jwt.alg, "HS256");
  assert.equal(sigs.find((s) => s.name === "theme").jwt, undefined);
  assert.equal(sigs.find((s) => s.name === "X-Id-Token").type, "uncertain");
  const dump = JSON.stringify(sigs);
  assert.ok(!dump.includes(JWT) && !dump.includes("SYNTH-SUBJECT"));
  assert.equal(extractOthers([H("X-Anything", JWT)]).length, 0);
});

test("bare JWT in Authorization and alg none are handled", () => {
  const bare = extractSignals([H("Authorization", JWT)])[0];
  assert.equal(bare.scheme, "No scheme");
  assert.equal(bare.jwt.alg, "HS256");
  const none = jwtMeta(JWT_NONE);
  assert.equal(none.alg, "none");
  assert.equal(jwtMeta("not.a.jwt"), null);
  assert.equal(jwtMeta("Basic dXNlcjpwYXNz"), null);
  assert.equal(decodeJwt(tokenFromValue(`Bearer ${JWT}`)).payload.sub, "SYNTH-SUBJECT");
});

test("JWT summary lines in the sanitized clipboard text", () => {
  const st = stateWith([[H("Authorization", `Bearer ${JWT}`)]], []);
  const text = buildClipboardText(st);
  assert.match(text, /^Authorization: Bearer <REDACTED> \[JWT alg=HS256, exp=2100-01-01T00:00:00\.000Z, claims: sub role exp\]$/m);
  assert.ok(!text.includes("SYNTH-SUBJECT") && !text.includes(JWT));
});

test("signals from other origins are grouped per origin in the clipboard text", () => {
  const signals = {};
  let t = 1;
  for (const s of extractSignals([H("Cookie", `sid=${SECRET.session}`)])) addSignal(signals, s, t++);
  for (const s of extractSignals([H("Authorization", `Bearer ${SECRET.bearer}`)])) {
    addSignal(signals, { ...s, key: `https://api.test.example|${s.key}`, origin: "https://api.test.example" }, t++);
  }
  const st = {
    origin: "https://test.example", tabId: 1, startedAt: 1, scope: "tab", signals,
    cookieMeta: [
      { name: "sid", secure: true, httpOnly: true, sameSite: "Lax", persistent: false },
      { name: "sid", origin: "https://api.test.example", secure: false, httpOnly: false, sameSite: "None", persistent: false }
    ]
  };
  assert.deepEqual(originsOf(st), ["https://test.example", "https://api.test.example"]);
  assert.equal(Object.keys(signalsOfOrigin(st, "https://api.test.example").signals).length, 1);
  const text = buildClipboardText(st);
  assert.match(text, /^Origin: https:\/\/test\.example\nCookie: sid=<REDACTED> \[Secure, HttpOnly, SameSite=Lax\]/m);
  assert.match(text, /^Origin: https:\/\/api\.test\.example\nAuthorization: Bearer <REDACTED>$/m);
  assert.match(text, /Requests from this tab to any origin are visible/);
  assert.ok(!text.includes("SYNTH"));
});

test("custom headers without an x- prefix and token-shaped values are surfaced", () => {
  const t = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
  const sigs = extractSignals([
    H("Token", t), H("Session-Ticket", "short"), H("lang", "en"),
    H("X-Build", t), H("Custom-Thing", t), H("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"),
    H("Sec-Fetch-Site", "same-origin"), H("User-Agent", "Mozilla/5.0 " + t)
  ]);
  const names = sigs.map((s) => s.name).sort();
  assert.deepEqual(names, ["Custom-Thing", "Session-Ticket", "Token", "X-Build"]);
  assert.ok(sigs.every((s) => s.type === "uncertain"));
  assert.deepEqual(extractOthers([H("lang", "en"), H("Token", t)]).map((x) => x.name), ["lang"]);
});

test("credential-like URL parameters are listed by name, values only on request", () => {
  const url = "https://a.example/api?access_token=SYNTH-QV1&page=2&sid=SYNTH-QV2&x=1";
  const names = extractQuery(url).map((x) => x.name);
  assert.deepEqual(names, ["?access_token", "?sid"]);
  assert.ok(!JSON.stringify(extractQuery(url)).includes("SYNTH"));
  assert.equal(extractQuery(url, true)[0].value, "SYNTH-QV1");
  assert.deepEqual(extractQuery("not a url"), []);
});

test("a JWT after a site specific scheme word is still recognised and decodable", () => {
  const meta = extractSignals([H("Auth", `Education ${JWT}`)])[0];
  assert.equal(meta.name, "Auth");
  assert.equal(meta.jwt.alg, "HS256");
  assert.equal(decodeJwt(tokenFromValue(`Education ${JWT}`)).payload.role, "admin");
  assert.equal(tokenFromValue("Bearer abc"), "abc");
  assert.equal(tokenFromValue("two words"), "two words");
});

test("buildJSON: valid JSON, sanitized by default, values only when asked", () => {
  const signals = {};
  let t = 1;
  const hdr = [H("Authorization", `Bearer ${SECRET.bearer}`), H("Cookie", `session=${SECRET.session}`)];
  for (const s of extractSignals(hdr, true)) addSignal(signals, s, t++);
  const cookieMeta = cookieMetaFrom(
    [{ name: "session", value: SECRET.session, domain: "test.example", path: "/", secure: true, httpOnly: true, sameSite: "lax" }],
    true
  );
  const st = { origin: "https://test.example", tabId: 1, startedAt: 1, signals, cookieMeta };

  const sanitized = JSON.parse(buildJSON(st, false));
  assert.equal(sanitized.tool, "AuthTracer");
  assert.equal(sanitized.redacted, true);
  assert.equal(sanitized.sites[0].origin, "https://test.example");
  assert.equal(sanitized.sites[0].authorization[0].scheme, "Bearer");
  assert.equal(sanitized.sites[0].authorization[0].value, undefined);
  assert.ok(!JSON.stringify(sanitized).includes("SYNTH"));

  const full = JSON.parse(buildJSON(st, true));
  assert.equal(full.redacted, false);
  assert.equal(full.sites[0].authorization[0].value, `Bearer ${SECRET.bearer}`);
  assert.equal(full.sites[0].sessionCookies[0].value, SECRET.session);
});

test("structural ids that merely contain a hint word are not treated as Unclear credentials", () => {
  const boring = [
    "Idempotency-Key",
    "X-Idempotency-Key",
    "X-Cache-Key",
    "X-Partition-Key",
    "X-Correlation-Id",
    "X-Request-Id",
    "X-Trace-Id",
    "X-Transaction-Id",
    "X-Order-Id",
    "X-Event-Id",
    "X-Workflow-Id"
  ];
  const sigs = extractSignals(boring.map((n) => H(n, "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4")));
  assert.deepEqual(sigs, [], boring.join(", "));
  const others = extractOthers(boring.map((n) => H(n, "x")));
  assert.deepEqual(others.map((o) => o.name).sort(), boring.slice().sort());
  // A genuine credential-sounding header is still caught.
  const real = extractSignals([H("X-Session-Ticket", "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4")]);
  assert.equal(real.length, 1);
  assert.equal(real[0].type, "uncertain");
});

test("signalConfidence ranks a JWT highest, then a recognized scheme, above a bare name hint", () => {
  const withJwt = { type: "authorization", scheme: "Bearer", jwt: { alg: "HS256", exp: 1 } };
  const bearerOnly = { type: "authorization", scheme: "Bearer" };
  const noScheme = { type: "authorization", scheme: "No scheme" };
  const uncertainName = { type: "uncertain" };
  const uncertainUrl = { type: "uncertain", via: "url" };
  assert.ok(signalConfidence(withJwt) > signalConfidence(bearerOnly));
  assert.ok(signalConfidence(bearerOnly) > signalConfidence(noScheme));
  assert.ok(signalConfidence(noScheme) > signalConfidence(uncertainUrl));
  assert.ok(signalConfidence(uncertainName) > signalConfidence(uncertainUrl));
});

test("groupSignals ranks each group by confidence: JWTs and real session cookies rise to the top", () => {
  const signals = {};
  let t = 1;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "HS256" })}.${b64({ sub: "x", exp: 9999999999 })}.sig`;
  const add = (hdrs) => {
    for (const s of extractSignals(hdrs, true)) addSignal(signals, s, t++);
  };
  // A weak Authorization value arrives first, a real Bearer JWT second: confidence must still put the JWT on top.
  add([H("Authorization", "garbage-no-scheme-value-here")]);
  add([H("Authorization", `Bearer ${jwt}`)]);
  // Same idea for a pair of Unclear headers.
  add([H("X-Session-Thing", "plainvalue")]);
  add([H("X-Weird-Token", jwt)]);
  // And for cookies: a weak/"maybe" one first, a real session cookie second.
  add([H("Cookie", `zzz_misc=randomvalue; auth_session=${jwt}`)]);
  const cookieMeta = cookieMetaFrom(
    [
      { name: "zzz_misc", value: "randomvalue", domain: "test.example", path: "/", secure: true, httpOnly: true, sameSite: "lax" },
      { name: "auth_session", value: jwt, domain: "test.example", path: "/", secure: true, httpOnly: true, sameSite: "lax" }
    ],
    true
  );
  const g = groupSignals({ origin: "https://test.example", tabId: 1, startedAt: 1, signals, cookieMeta });

  assert.equal(g.authorization[0].scheme, "Bearer");
  assert.ok(g.authorization[0].jwt);
  assert.equal(g.authorization[1].scheme, "No scheme");

  assert.equal(g.uncertain[0].name, "X-Weird-Token");
  assert.ok(g.uncertain[0].jwt);
  assert.equal(g.uncertain[1].name, "X-Session-Thing");

  const sessionNames = g.cookieGroups.auth.concat(g.cookieGroups.maybe).map((c) => c.name);
  assert.equal(sessionNames[0], "auth_session");
});
