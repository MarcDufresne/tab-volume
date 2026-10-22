import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, eventually, near } from "./harness.mjs";

let h;
before(async () => { h = await launch(); });
after(async () => { await h?.close(); });

const hasSaved = (site) => (regs) => regs.some((r) => r.id === "tv-page-saved" && r.matches.includes(`*://*.${site}/*`));
const noSaved = (regs) => regs.length >= 2 && !regs.some((r) => r.id === "tv-page-saved");

async function addAudio(page, id) {
  await page.evaluate(async (i) => {
    const a = document.createElement("audio"); a.id = i; a.src = "/tone.wav"; a.loop = true; document.body.append(a);
    await a.play();
  }, id);
}

test("saved domain never plays above level", async () => {
  await h.setDomains({ "loud.test": 6 });
  await h.waitForRegistration(hasSaved("loud.test"));
  const page = await h.openWithNativeLog(h.serverUrl("www.loud.test") + "/media.html?autoplay");
  const log = await eventually(async () => {
    const l = await h.nativeLog(page);
    assert.ok(l.some((e) => e.type === "playing"), "not playing yet");
    return l;
  }, { timeout: 5000 });
  for (const e of log) assert.ok(e.v <= 0.06 + 1e-9, JSON.stringify(log));
  await eventually(async () => assert.ok(near((await h.nativeVolumes(page))[0], 0.06)));
  await page.close();
});

test("live update across tabs and cross-origin iframe", async () => {
  await h.setDomains({ "loud.test": 6 });
  await h.waitForRegistration(hasSaved("loud.test"));
  const a = await h.context.newPage();
  await a.goto(h.serverUrl("www.loud.test") + "/media.html?autoplay");
  const b = await h.context.newPage();
  const frameSrc = h.serverUrl("other.test") + "/media.html?autoplay";
  await b.goto(h.serverUrl("web.loud.test") + `/media.html?iframe=${encodeURIComponent(frameSrc)}`);
  const frame = await eventually(async () => {
    const f = b.frames().find((x) => x.url() === frameSrc);
    assert.ok(f, "iframe not loaded");
    return f;
  });
  await eventually(async () => assert.ok(near((await h.nativeVolumes(frame))[0], 0.06), "iframe at 6"));
  await h.setDomains({ "loud.test": 20 });
  await eventually(async () => {
    assert.ok(near((await h.nativeVolumes(a))[0], 0.2), "tab a");
    assert.ok(near((await h.nativeVolumes(frame))[0], 0.2), "iframe");
  }, { timeout: 1000 });
  await a.close();
  await b.close();
});

test("unsaved domain tab override", async () => {
  await h.setDomains({});
  await h.waitForRegistration(noSaved);
  const page = await h.context.newPage();
  await page.goto(h.serverUrl("other.test") + "/media.html");
  await addAudio(page, "a");
  const tabId = await h.tabIdFor(page);
  assert.deepEqual(await h.sw.evaluate((id) => self.tv.setTabLevel(id, 30), tabId), { ok: true });
  await eventually(async () => assert.ok(near((await h.nativeVolumes(page))[0], 0.3)));

  await page.goto(h.serverUrl("www.other.test") + "/media.html");
  await addAudio(page, "a");
  await eventually(async () => assert.ok(near((await h.nativeVolumes(page))[0], 0.3)));

  await page.goto(h.serverUrl("loud2.test") + "/media.html");
  await addAudio(page, "a");
  await eventually(async () => assert.equal((await h.nativeVolumes(page))[0], 1));
  assert.deepEqual(await h.sw.evaluate((id) => chrome.storage.session.get(`tab:${id}`), tabId), {});

  await page.goto(h.serverUrl("other.test") + "/media.html");
  await h.sw.evaluate((id) => self.tv.setTabLevel(id, 30), tabId);
  await page.close();
  await eventually(async () => assert.deepEqual(await h.sw.evaluate((id) => chrome.storage.session.get(`tab:${id}`), tabId), {}));
});

test("forgetting a domain restores 100", async () => {
  await h.setDomains({ "loud.test": 6 });
  await h.waitForRegistration(hasSaved("loud.test"));
  const page = await h.context.newPage();
  await page.goto(h.serverUrl("www.loud.test") + "/media.html?autoplay");
  await eventually(async () => assert.ok(near((await h.nativeVolumes(page))[0], 0.06)));
  await h.setDomains({});
  await eventually(async () => assert.equal((await h.nativeVolumes(page))[0], 1));
  await page.close();
});

test("badge", async () => {
  await h.setDomains({ "loud.test": 6 });
  await h.waitForRegistration(hasSaved("loud.test"));
  const loud = await h.context.newPage();
  await loud.goto(h.serverUrl("www.loud.test") + "/media.html");
  const other = await h.context.newPage();
  await other.goto(h.serverUrl("other.test") + "/media.html");
  const badge = (id) => h.sw.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), id);
  const loudId = await h.tabIdFor(loud);
  const otherId = await h.tabIdFor(other);
  await eventually(async () => assert.equal(await badge(loudId), "6"));
  assert.equal(await badge(otherId), "");
  await loud.reload();
  await eventually(async () => assert.equal(await badge(loudId), "6"));
  await loud.close();
  await other.close();
});

test("already-open tab gets late injection", async () => {
  await h.setDomains({});
  await h.waitForRegistration(noSaved);
  await h.sw.evaluate(() => chrome.scripting.unregisterContentScripts());
  const page = await h.context.newPage();
  await page.goto(h.serverUrl("other.test") + "/media.html");
  await page.evaluate(() => { const a = document.createElement("audio"); a.id = "a"; document.body.append(a); a.volume = 0.4; });
  const tabId = await h.tabIdFor(page);
  await h.sw.evaluate(() => self.tv.injectIntoOpenTabs());
  const ping = await eventually(async () => {
    const r = await h.sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: "tv:ping" }, { frameId: 0 }), tabId);
    assert.equal(r.applied, true);
    return r;
  });
  assert.equal(ping.site, "other.test");
  await h.sw.evaluate((id) => self.tv.setTabLevel(id, 50), tabId);
  await eventually(async () => assert.ok(near((await h.nativeVolumes(page))[0], 0.2)));
  await h.sw.evaluate(() => self.tv.syncRegistrations());
  await page.close();
});

test("junk in storage keeps registration working", async () => {
  await h.setDomains({ "a b": 5, "[::1]": 3, "loud.test": 6 });
  const regs = await h.waitForRegistration(hasSaved("loud.test"));
  assert.deepEqual(regs.map((r) => r.id).sort(), ["tv-bridge", "tv-page", "tv-page-saved"]);
  const page = await h.context.newPage();
  await page.goto(h.serverUrl("www.loud.test") + "/media.html?autoplay");
  await eventually(async () => assert.ok(near((await h.nativeVolumes(page))[0], 0.06)));
  await page.close();
  await h.setDomains({});
});
