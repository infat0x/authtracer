// Origin helpers. Only plain http and https pages can be inspected.

export function parseSupportedOrigin(url) {
  if (typeof url !== "string" || url === "") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  // Browser stores and similar pages cannot be observed by extensions.
  const host = u.hostname.toLowerCase();
  if (host === "chrome.google.com" && u.pathname.startsWith("/webstore")) return null;
  if (host === "chromewebstore.google.com") return null;
  if (host === "microsoftedge.microsoft.com" && u.pathname.startsWith("/addons")) return null;
  return u.origin;
}

// Match pattern for chrome.permissions. Chrome ignores ports in host
// permissions, so every request is also checked against the exact origin.
export function permissionPattern(origin) {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

export function sameOrigin(urlA, urlB) {
  const a = parseSupportedOrigin(urlA);
  const b = parseSupportedOrigin(urlB);
  return a !== null && a === b;
}

export function safeHostname(url) {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}
