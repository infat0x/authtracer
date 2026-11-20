import { chromium } from "playwright-core";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
export const EXT_SRC = join(here, "..", "extension");

// Locates the Chromium build that `npx playwright install chromium` places in
// its per-OS cache, so the test suite runs the same way on a developer's
// machine and in CI.
export function chromiumPath() {
  if (process.env.SL_BROWSER) return process.env.SL_BROWSER;
  const base =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || homedir(), "ms-playwright")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches", "ms-playwright")
        : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright");
  const binaries = {
    win32: ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"],
    darwin: ["chrome-mac/Chromium.app/Contents/MacOS/Chromium"],
    linux: ["chrome-linux/chrome"]
  }[process.platform] || ["chrome-linux/chrome"];
  for (const n of ["chromium-1200", "chromium-1194", "chromium-1187"]) {
    for (const bin of binaries) {
      const p = join(base, n, bin);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("No Playwright Chromium found. Run: npx playwright install chromium");
}

// Copy of the extension. With grantHosts the manifest also lists the host
// permissions up front, so chrome.permissions.request resolves without a prompt
// (the native prompt cannot be clicked by automation). Everything else is identical.
export function stageExtension(grantHosts) {
  const dir = mkdtempSync(join(tmpdir(), "authtracer-ext-"));
  cpSync(EXT_SRC, dir, { recursive: true });
  if (grantHosts) {
    const p = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.host_permissions = m.optional_host_permissions;
    delete m.optional_host_permissions;
    writeFileSync(p, JSON.stringify(m, null, 2));
  }
  return dir;
}

export async function launch(extDir) {
  const userDataDir = mkdtempSync(join(tmpdir(), "authtracer-prof-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromiumPath(),
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  return { ctx, sw, id, userDataDir };
}
