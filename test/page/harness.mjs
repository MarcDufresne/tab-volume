import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../fixtures/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PAGE_JS = readFileSync(path.join(ROOT, "extension/content/page.js"), "utf8");
export const START_MUTED_JS = readFileSync(path.join(ROOT, "extension/content/start-muted.js"), "utf8");
export const BROWSER_PATH = process.env.BROWSER_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

// Runs before page.js: keeps handles on the untouched native APIs so tests can see what really reaches the speakers.
const INSPECT = `(() => {
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
  window.__native = (el) => d.get.call(el);
  window.__setNative = (el, v) => d.set.call(el, v);
  window.__conns = [];
  window.__disconns = [];
  const c = AudioNode.prototype.connect, dc = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function (t, ...r) {
    window.__conns.push({ from: this, to: t, fromName: this.constructor.name, toName: t && t.constructor ? t.constructor.name : String(t), gain: t instanceof GainNode ? t.gain.value : this instanceof GainNode ? this.gain.value : undefined });
    return c.call(this, t, ...r);
  };
  AudioNode.prototype.disconnect = function (...a) {
    window.__disconns.push({ from: this.constructor.name, to: a[0] && a[0].constructor ? a[0].constructor.name : undefined });
    return dc.apply(this, a);
  };
  window.__events = [];
  window.addEventListener("tabvolume:ready", () => window.__events.push("ready"));
  window.__playLog = [];
  window.__volumechanges = 0;
  for (const type of ["play", "playing"]) {
    window.addEventListener(type, (e) => {
      if (e.target instanceof HTMLMediaElement) window.__playLog.push({ type, id: e.target.id, v: d.get.call(e.target) });
    }, true);
  }
  window.addEventListener("volumechange", () => { window.__volumechanges++; }, true);
})();`;

export async function openPage({ startMuted = false, injectPageJs = true, autoplayPolicy = "no-user-gesture-required", path: pagePath = "/media.html", preLevel } = {}) {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true, args: [`--autoplay-policy=${autoplayPolicy}`] });
  const context = await browser.newContext();
  await context.addInitScript({ content: INSPECT });
  if (startMuted) await context.addInitScript({ content: START_MUTED_JS });
  if (injectPageJs) await context.addInitScript({ content: PAGE_JS });
  if (preLevel !== undefined) {
    await context.addInitScript({ content: `window.dispatchEvent(new CustomEvent("tabvolume:level", { detail: ${preLevel} }));` });
  }
  const page = await context.newPage();
  await page.goto(server.url + pagePath);
  return {
    page,
    nativeVolume: (sel) => page.evaluate((s) => window.__native(document.querySelector(s)), sel),
    setLevel: (n) => page.evaluate((v) => window.dispatchEvent(new CustomEvent("tabvolume:level", { detail: v })), n),
    connections: () => page.evaluate(() => window.__conns.map(({ fromName, toName, gain }) => ({ from: fromName, to: toName, gain }))),
    playLog: () => page.evaluate(() => window.__playLog),
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

export const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
