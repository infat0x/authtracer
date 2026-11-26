import { chromium } from "playwright-core";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const EXT_SRC = join(here, "..", "extension");

// Playwright's own executablePath() always resolves to whatever Chromium
// revision this exact playwright-core version actually installed, on any OS,
// so there is no cache folder name or revision number to guess here.
export function chromiumPath() {
  if (process.env.SL_BROWSER) return process.env.SL_BROWSER;
  const p = chromium.executablePath();
  if (!p || !existsSync(p)) {
    throw new Error("No Playwright Chromium found. Run: npx playwright-core install chromium");
  }
  return p;
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
