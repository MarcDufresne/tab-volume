import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../fixtures/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXT = path.join(ROOT, "extension");
const BROWSER_PATH = process.env.BROWSER_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

// Runs in a CDP isolated world, where HTMLMediaElement.prototype is untouched by page.js,
// and logs the volume that really reaches the speakers at every play/playing event.
const NATIVE_LOG = `(() => {
  const log = [];
  for (const type of ["play", "playing"]) {
    window.addEventListener(type, (e) => {
      if (!(e.target instanceof HTMLMediaElement)) return;
      log.push({ type, id: e.target.id, v: e.target.volume });
      document.documentElement.setAttribute("data-tv-native-log", JSON.stringify(log));
    }, true);
  }
})();`;

export async function launch() {
  const server = await startServer();
  const context = await chromium.launchPersistentContext("", {
    executablePath: BROWSER_PATH,
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--host-resolver-rules=MAP *.test 127.0.0.1",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
  const extensionId = new URL(sw.url()).host;

  const h = {
    context,
    sw,
    extensionId,
    serverUrl: (host) => `http://${host}:${server.port}`,

    async waitForRegistration(predicate) {
      for (let i = 0; i < 100; i++) {
        const regs = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
        if (predicate(regs)) return regs;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("registration did not reach expected state");
    },

    async setDomains(domains) {
      await sw.evaluate((d) => chrome.storage.local.set({ domains: d }), domains);
    },

    async tabIdFor(page) {
      const url = page.url();
      return sw.evaluate((u) => chrome.tabs.query({}).then((ts) => (ts.find((t) => t.url === u) || {}).id), url);
    },

    async openWithNativeLog(url) {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Page.enable");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: NATIVE_LOG, worldName: "tv-test" });
      await page.goto(url);
      return page;
    },

    async nativeLog(page) {
      return JSON.parse((await page.evaluate(() => document.documentElement.getAttribute("data-tv-native-log"))) || "[]");
    },

    // Reads current native volumes of every media element in a page or frame through a fresh isolated world.
    async nativeVolumes(target) {
      const page = typeof target.page === "function" ? target.page() : target;
      let cdp;
      try {
        cdp = await context.newCDPSession(target);
      } catch {
        cdp = await context.newCDPSession(page);
      }
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const frameId = target === page || typeof target.page !== "function" ? frameTree.frame.id : await findFrameId(frameTree, target.url());
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId, worldName: "tv-read" });
      const { result } = await cdp.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: `JSON.stringify([...document.querySelectorAll("audio, video")].map((e) => e.volume))`,
        returnByValue: true,
      });
      await cdp.detach();
      return JSON.parse(result.value);
    },

    async close() {
      await context.close();
      await server.close();
    },
  };
  return h;
}

function findFrameId(tree, url) {
  if (tree.frame.url === url) return tree.frame.id;
  for (const child of tree.childFrames || []) {
    const id = findFrameId(child, url);
    if (id) return id;
  }
  return null;
}

export async function eventually(fn, { timeout = 3000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (Date.now() > end) throw last;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

export const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
