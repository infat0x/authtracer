// Local fixture site. Every credential here is synthetic.
import http from "node:http";

export const SYN = {
  bearer: "SYNTH-BEARER-7f3a91c2d4e5",
  basic: "U1lOVEhVU0VSOlNZTlRIUEFTUw==",
  session: "SYNTH-SESSION-b8c1d2e3f4",
  pref: "SYNTH-PREF-0011",
  api: "SYNTH-APIKEY-55aa66bb77cc",
  csrf: "SYNTH-CSRF-99ee88dd77",
  custom: "SYNTH-CUSTOM-1a2b3c4d",
  query: "SYNTH-QUERY-zz99",
  body: "SYNTH-PASSWORD-hunter2"
};

const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#e91e63"/></svg>';

function page(title, withIcon) {
  return `<!doctype html><html><head><meta charset="utf-8">${title ? `<title>${title}</title>` : ""}${
    withIcon ? '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' : '<link rel="icon" href="data:,">'
  }</head><body><h1>${title || "untitled"}</h1></body></html>`;
}

export function startFixture() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    hits.push({ host: req.headers.host, path: url.pathname });
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "*, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/favicon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end(FAVICON);
    }
    if (url.pathname === "/login") {
      res.setHeader("Set-Cookie", [
        `sid=${SYN.session}; Path=/; HttpOnly; SameSite=Lax`,
        `pref=${SYN.pref}; Path=/`
      ]);
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page("Fixture Login", true));
    }
    if (url.pathname === "/long") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page("L".repeat(110) + "Title", true));
    }
    if (url.pathname === "/xss") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page("&lt;img src=x onerror=alert(1)&gt;", false));
    }
    if (url.pathname === "/plain") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page("", false));
    }
    if (url.pathname.startsWith("/api")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("Fixture Home", true));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, hits, close: () => server.close() });
    });
  });
}
