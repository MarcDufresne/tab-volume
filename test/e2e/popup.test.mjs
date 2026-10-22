import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, eventually, near } from "./harness.mjs";

let h;
before(async () => { h = await launch(); });
after(async () => { await h?.close(); });

const noSaved = (regs) => regs.length >= 2 && !regs.some((r) => r.id === "tv-page-saved");
const getDomains = () => h.sw.evaluate(() => chrome.storage.local.get("domains").then((r) => r.domains || {}));
const getOverride = (tabId) => h.sw.evaluate((id) => chrome.storage.session.get(`tab:${id}`).then((r) => r[`tab:${id}`] || null), tabId);

async function target(url) {
  const page = await h.context.newPage();
  await page.goto(url);
  if (url.startsWith("http")) {
    await page.evaluate(async () => {
      const a = document.createElement("audio"); a.id = "a"; a.src = "/tone.wav"; a.loop = true; document.body.append(a);
      await a.play();
    });
  }
  return { page, tabId: await h.tabIdFor(page) };
}

async function openPopup(tabId) {
  const popup = await h.context.newPage();
  await popup.goto(`chrome-extension://${h.extensionId}/popup/popup.html?tabId=${tabId}`);
  await popup.waitForSelector("body[data-state]");
  return popup;
}

async function setSlider(popup, value) {
  await popup.$eval("#level-slider", (el, v) => { el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, value);
}

async function fresh() {
  await h.sw.evaluate(() => self.tv.syncRegistrations());
  await h.setDomains({});
  await h.sw.evaluate(() => self.tv.syncRegistrations());
  await h.waitForRegistration(noSaved);
}

test("slider and number stay in sync", async () => {
  await fresh();
  const t = await target(h.serverUrl("other.test") + "/media.html");
  const popup = await openPopup(t.tabId);
  assert.equal(await popup.getAttribute("body", "data-state"), "ok");
  await popup.fill("#level-number", "6");
  assert.equal(await popup.inputValue("#level-slider"), "6");
  await eventually(async () => assert.ok(near((await h.nativeVolumes(t.page))[0], 0.06)));
  assert.deepEqual(await getOverride(t.tabId), { site: "other.test", level: 6 });
  await setSlider(popup, 40);
  assert.equal(await popup.inputValue("#level-number"), "40");
  await eventually(async () => assert.ok(near((await h.nativeVolumes(t.page))[0], 0.4)));
  await popup.close();
  await t.page.close();
});

test("remember toggle", async () => {
  await fresh();
  const t = await target(h.serverUrl("other.test") + "/media.html");
  const popup = await openPopup(t.tabId);
  await setSlider(popup, 40);
  await eventually(async () => assert.ok(await getOverride(t.tabId)));
  await popup.check("#remember");
  await eventually(async () => assert.deepEqual(await getDomains(), { "other.test": 40 }));
  await eventually(async () => assert.equal(await getOverride(t.tabId), null));
  await popup.fill("#level-number", "12");
  await eventually(async () => assert.deepEqual(await getDomains(), { "other.test": 12 }));
  await eventually(async () => assert.ok(near((await h.nativeVolumes(t.page))[0], 0.12)));
  await popup.uncheck("#remember");
  await eventually(async () => assert.deepEqual(await getDomains(), {}));
  await eventually(async () => assert.equal((await h.nativeVolumes(t.page))[0], 1));
  assert.equal(await popup.inputValue("#level-number"), "100");
  await popup.close();
  await t.page.close();
});

test("label shows site", async () => {
  await fresh();
  const t = await target(h.serverUrl("www.other.test") + "/media.html");
  const popup = await openPopup(t.tabId);
  assert.equal((await popup.textContent("#remember-label")).trim(), "Remember for other.test");
  assert.equal((await popup.textContent("#site")).trim(), "other.test");
  await popup.close();
  await t.page.close();
});

test("saved list", async () => {
  await h.setDomains({ "b.test": 50, "a.test": 5 });
  const t = await target(h.serverUrl("other.test") + "/media.html");
  const popup = await openPopup(t.tabId);
  assert.deepEqual(await popup.$$eval("#saved li", (lis) => lis.map((li) => li.dataset.site)), ["a.test", "b.test"]);
  await popup.fill('#saved li[data-site="b.test"] input', "60");
  await eventually(async () => assert.deepEqual(await getDomains(), { "a.test": 5, "b.test": 60 }));
  await popup.click('#saved li[data-site="a.test"] button.remove');
  await eventually(async () => assert.deepEqual(await getDomains(), { "b.test": 60 }));
  await eventually(async () => assert.deepEqual(await popup.$$eval("#saved li", (lis) => lis.map((li) => li.dataset.site)), ["b.test"]));
  await popup.close();
  await t.page.close();
  await fresh();
});

test("import", async () => {
  await h.setDomains({ "b.test": 50 });
  const t = await target(h.serverUrl("other.test") + "/media.html");
  const popup = await openPopup(t.tabId);
  await popup.click(".import summary");
  await popup.fill("#import-text", '{"www.c.test":{"volume":7},"[::1]":3}');
  await popup.click("#import-btn");
  await eventually(async () => assert.deepEqual(await getDomains(), { "b.test": 50, "c.test": 7 }));
  assert.equal((await popup.textContent("#import-result")).trim(), "Imported 1, skipped 1: [::1]");
  await popup.fill("#import-text", "{nope");
  await popup.click("#import-btn");
  assert.equal((await popup.textContent("#import-result")).trim(), "That isn't valid JSON.");
  await popup.close();
  await t.page.close();
  await fresh();
});

test("restricted tab", async () => {
  await fresh();
  const t = await target("chrome://version");
  const popup = await openPopup(t.tabId);
  assert.equal(await popup.getAttribute("body", "data-state"), "restricted");
  assert.equal((await popup.textContent("#status")).trim(), "Tab Volume can't control this page.");
  assert.equal(await popup.isDisabled("#level-slider"), true);
  assert.equal(await popup.isDisabled("#remember"), true);
  await popup.close();
  await t.page.close();
});

test("not applied", async () => {
  await fresh();
  await h.sw.evaluate(() => chrome.scripting.unregisterContentScripts());
  const t = await target(h.serverUrl("other.test") + "/media.html");
  await h.sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["lib/domain.js", "content/bridge.js"] }), t.tabId);
  const popup = await openPopup(t.tabId);
  assert.equal(await popup.getAttribute("body", "data-state"), "not-applied");
  assert.equal((await popup.textContent("#status")).trim(), "Volume not applied yet. Reload this tab.");
  assert.equal(await popup.isVisible("#reload"), true);
  await h.sw.evaluate(() => self.tv.syncRegistrations());
  await popup.close();
  await t.page.close();
});

test("needs reload", async () => {
  await fresh();
  await h.sw.evaluate(() => chrome.scripting.unregisterContentScripts());
  const t = await target(h.serverUrl("other.test") + "/media.html");
  const popup = await openPopup(t.tabId);
  assert.equal(await popup.getAttribute("body", "data-state"), "needs-reload");
  assert.equal((await popup.textContent("#status")).trim(), "Reload this tab to control its volume.");
  await h.sw.evaluate(() => self.tv.syncRegistrations());
  const reloaded = t.page.waitForEvent("load");
  await popup.click("#reload");
  await reloaded;
  const ping = await eventually(() => h.sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "tv:ping" }, { frameId: 0 }), t.tabId));
  assert.equal(ping.applied, true);
  await t.page.close();
});
