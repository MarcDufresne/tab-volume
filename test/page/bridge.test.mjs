import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../fixtures/server.mjs";
import { BROWSER_PATH } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOMAIN_JS = readFileSync(path.join(ROOT, "extension/lib/domain.js"), "utf8");
const BRIDGE_JS = readFileSync(path.join(ROOT, "extension/content/bridge.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs bridge.js against a fake `chrome` so storage failures and an invalidated context can be simulated.
function fakeChrome(config) {
  return `(() => {
    const config = ${JSON.stringify(config)};
    const listeners = { changed: [], message: [] };
    window.__log = { levels: [], messages: [] };
    window.addEventListener("tabvolume:level", (e) => window.__log.levels.push(e.detail));
    window.__fake = { domains: config.domains, storageFails: !!config.storageFails };
    const fake = {
      runtime: {
        id: "test",
        sendMessage: async (m) => {
          window.__log.messages.push(m.type);
          if (config.messageFails) throw new Error("Extension context invalidated.");
          return config.state || { site: null, overrideLevel: null };
        },
        onMessage: { addListener: (f) => listeners.message.push(f) },
      },
      storage: {
        local: { get: async () => { if (window.__fake.storageFails) throw new Error("Extension context invalidated."); return { domains: window.__fake.domains }; } },
        onChanged: { addListener: (f) => listeners.changed.push(f) },
      },
    };
    window.__fakeChrome = fake;
    window.__change = (newValue) => {
      const oldValue = window.__fake.domains;
      window.__fake.domains = newValue;
      for (const f of listeners.changed) f({ domains: { oldValue, newValue } }, "local");
    };
  })();`;
}

async function withBridge(config, fn) {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript({ content: fakeChrome(config) });
    await context.addInitScript({ content: DOMAIN_JS });
    await context.addInitScript({ content: `((chrome) => {\n${BRIDGE_JS}\n})(window.__fakeChrome);` });
    const page = await context.newPage();
    await page.goto(server.url + "/media.html");
    await sleep(200);
    await fn(page, () => page.evaluate(() => window.__log));
  } finally {
    await browser.close();
    await server.close();
  }
}

test("storage failure on a saved site sends no level", () => withBridge({ domains: { "127.0.0.1": 6 }, storageFails: true, messageFails: true }, async (_page, log) => {
  assert.deepEqual((await log()).levels, []);
}));

test("saved site level change applies without messaging the background", () => withBridge({ domains: { "127.0.0.1": 6 } }, async (page, log) => {
  assert.deepEqual(await log(), { levels: [6], messages: [] });
  await page.evaluate(() => window.__change({ "127.0.0.1": 20 }));
  await sleep(100);
  assert.deepEqual(await log(), { levels: [6, 20], messages: [] });
}));

test("unsaved frame ignores other sites' level changes", () => withBridge({ domains: { "other.com": 5 } }, async (page, log) => {
  assert.deepEqual(await log(), { levels: [100], messages: ["tv:getTabState"] });
  await page.evaluate(() => window.__change({ "other.com": 9 }));
  await sleep(100);
  assert.deepEqual(await log(), { levels: [100], messages: ["tv:getTabState"] });
}));

test("saving and forgetting this site", () => withBridge({ domains: {} }, async (page, log) => {
  await page.evaluate(() => window.__change({ "127.0.0.1": 7 }));
  await sleep(100);
  assert.deepEqual((await log()).levels, [100, 7]);
  await page.evaluate(() => window.__change({}));
  await sleep(100);
  assert.deepEqual(await log(), { levels: [100, 7, 100], messages: ["tv:getTabState", "tv:getTabState"] });
}));

test("orphaned bridge stays quiet after the extension is reloaded", () => withBridge({ domains: { "127.0.0.1": 6 } }, async (page, log) => {
  assert.deepEqual((await log()).levels, [6]);
  await page.evaluate(() => { window.__fakeChrome.runtime.id = undefined; window.dispatchEvent(new Event("tabvolume:ready")); });
  await sleep(100);
  assert.deepEqual((await log()).levels, [6]);
}));
