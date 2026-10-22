import { test } from "node:test";
import assert from "node:assert/strict";
import { openPage, near, PAGE_JS } from "./harness.mjs";

async function withPage(opts, fn) {
  const h = await openPage(opts);
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("test timed out after 20s")), 20000).unref());
  try {
    await Promise.race([fn(h), timeout]);
  } finally {
    await h.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("unset element is scaled", () => withPage({}, async (h) => {
  await h.page.evaluate(() => { const v = document.createElement("video"); v.id = "v"; v.src = "/tone.wav"; document.body.append(v); });
  await h.setLevel(6);
  assert.ok(near(await h.nativeVolume("#v"), 0.06));
  assert.equal(await h.page.evaluate(() => document.querySelector("#v").volume), 1);
}));

test("page-set volume is scaled", () => withPage({}, async (h) => {
  await h.page.evaluate(() => { const a = document.createElement("audio"); a.id = "a"; document.body.append(a); });
  await h.setLevel(6);
  await h.page.evaluate(() => { document.querySelector("#a").volume = 0.5; });
  assert.ok(near(await h.nativeVolume("#a"), 0.03));
  assert.equal(await h.page.evaluate(() => document.querySelector("#a").volume), 0.5);
}));

test("invalid volume still throws like native", () => withPage({}, async (h) => {
  const errs = await h.page.evaluate(() => {
    const a = document.createElement("audio");
    const out = [];
    for (const v of [2, -1, NaN]) { try { a.volume = v; out.push("ok"); } catch (e) { out.push(e.name); } }
    return out;
  });
  assert.deepEqual(errs, ["IndexSizeError", "IndexSizeError", "TypeError"]);
}));

test("level change rescales all known elements", () => withPage({}, async (h) => {
  await h.page.evaluate(async () => {
    const a = document.createElement("audio"); a.id = "dom"; a.src = "/tone.wav"; document.body.append(a);
    window.__detached = new Audio("/tone.wav");
    await window.__detached.play();
  });
  await h.setLevel(50);
  await h.setLevel(10);
  assert.ok(near(await h.nativeVolume("#dom"), 0.1));
  assert.ok(near(await h.page.evaluate(() => window.__native(window.__detached)), 0.1));
}));

test("site resets volume", () => withPage({}, async (h) => {
  await h.setLevel(6);
  await h.page.evaluate(async () => {
    for (let i = 0; i < 5; i++) {
      const v = document.createElement("audio"); v.id = `r${i}`; v.src = "/tone.wav"; document.body.append(v);
      v.volume = 1;
      const playing = new Promise((r) => v.addEventListener("playing", r, { once: true }));
      await v.play();
      await playing;
      v.pause();
    }
  });
  const log = (await h.playLog()).filter((e) => e.id.startsWith("r"));
  assert.equal(log.length, 10);
  for (const e of log) assert.ok(near(e.v, 0.06), JSON.stringify(e));
}));

test("autoplay attribute element", () => withPage({ path: "/media.html?autoplay", preLevel: 6 }, async (h) => {
  await h.page.waitForFunction(() => window.__playLog.some((e) => e.id === "auto" && e.type === "playing"));
  const log = (await h.playLog()).filter((e) => e.id === "auto");
  assert.ok(log.length >= 2);
  for (const e of log) assert.ok(near(e.v, 0.06), JSON.stringify(e));
}));

test("shadow DOM element", () => withPage({ preLevel: 6 }, async (h) => {
  await h.page.evaluate(() => {
    const host = document.createElement("div"); document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    const a = document.createElement("audio"); a.id = "shadow"; a.src = "/tone.wav"; a.autoplay = true;
    window.__shadowAudio = a;
    a.addEventListener("playing", () => { window.__shadowNative = window.__native(a); });
    root.append(a);
  });
  await h.page.waitForFunction(() => window.__shadowNative !== undefined);
  assert.ok(near(await h.page.evaluate(() => window.__shadowNative), 0.06));
}));

test("start-muted mutes until level", () => withPage({ startMuted: true }, async (h) => {
  await h.page.evaluate(async () => {
    const a = document.createElement("audio"); a.id = "a"; a.src = "/tone.wav"; document.body.append(a);
    await a.play();
  });
  assert.equal(await h.nativeVolume("#a"), 0);
  await h.setLevel(6);
  assert.ok(near(await h.nativeVolume("#a"), 0.06));
}));

test("start-muted after level is ignored", () => withPage({}, async (h) => {
  await h.page.evaluate(() => { const a = document.createElement("audio"); a.id = "a"; document.body.append(a); });
  await h.setLevel(6);
  await h.page.evaluate(() => window.dispatchEvent(new Event("tabvolume:start-muted")));
  assert.ok(near(await h.nativeVolume("#a"), 0.06));
}));

test("start-muted with no level yet mutes an installed page.js", () => withPage({}, async (h) => {
  await h.page.evaluate(() => { const a = document.createElement("audio"); a.id = "a"; document.body.append(a); });
  await h.page.evaluate(() => window.dispatchEvent(new Event("tabvolume:start-muted")));
  assert.equal(await h.nativeVolume("#a"), 0);
}));

test("double install is a no-op", () => withPage({}, async (h) => {
  await h.page.evaluate((src) => { (0, eval)(src); }, PAGE_JS);
  await h.page.evaluate(() => { const a = document.createElement("audio"); a.id = "a"; document.body.append(a); });
  await h.setLevel(50);
  await h.page.evaluate(() => { document.querySelector("#a").volume = 0.5; });
  assert.ok(near(await h.nativeVolume("#a"), 0.25));
}));

test("late install seeds from native", () => withPage({ injectPageJs: false }, async (h) => {
  await h.page.evaluate(() => { const a = document.createElement("audio"); a.id = "a"; document.body.append(a); a.volume = 0.4; });
  await h.page.evaluate((src) => { (0, eval)(src); }, PAGE_JS);
  await h.setLevel(50);
  assert.ok(near(await h.nativeVolume("#a"), 0.2));
  assert.ok(near(await h.page.evaluate(() => document.querySelector("#a").volume), 0.4));
}));

test("reconcile does not loop", () => withPage({}, async (h) => {
  await h.page.evaluate(() => { const a = document.createElement("audio"); a.id = "a"; document.body.append(a); });
  await h.setLevel(50);
  await h.page.evaluate(() => { window.__volumechanges = 0; window.__setNative(document.querySelector("#a"), 0.3); });
  await sleep(200);
  assert.ok(near(await h.page.evaluate(() => document.querySelector("#a").volume), 0.6));
  assert.ok(near(await h.nativeVolume("#a"), 0.3));
  assert.ok((await h.page.evaluate(() => window.__volumechanges)) < 3);
}));

test("reconcile at level 0 keeps page volume and stays silent", () => withPage({}, async (h) => {
  await h.page.evaluate(() => { const a = document.createElement("audio"); a.id = "a"; document.body.append(a); a.volume = 0.8; });
  await h.setLevel(0);
  await h.page.evaluate(() => { window.__volumechanges = 0; window.__setNative(document.querySelector("#a"), 0.5); });
  await sleep(200);
  assert.ok(near(await h.page.evaluate(() => document.querySelector("#a").volume), 0.8));
  assert.equal(await h.nativeVolume("#a"), 0);
  assert.ok((await h.page.evaluate(() => window.__volumechanges)) < 3);
}));

test("ready handshake", () => withPage({}, async (h) => {
  assert.deepEqual(await h.page.evaluate(() => window.__events), ["ready"]);
  await h.page.evaluate(() => window.dispatchEvent(new Event("tabvolume:hello")));
  assert.deepEqual(await h.page.evaluate(() => window.__events), ["ready", "ready"]);
}));

test("Web Audio routed through gain", () => withPage({ preLevel: 25 }, async (h) => {
  const res = await h.page.evaluate(() => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const returned = osc.connect(ctx.destination);
    window.__ctx = ctx; window.__osc = osc;
    return { returnedIsDest: returned === ctx.destination };
  });
  assert.equal(res.returnedIsDest, true);
  const conns = await h.connections();
  assert.ok(conns.some((c) => c.from === "OscillatorNode" && c.to === "GainNode"), JSON.stringify(conns));
  assert.ok(conns.some((c) => c.from === "GainNode" && c.to === "AudioDestinationNode" && near(c.gain, 0.25)), JSON.stringify(conns));
  assert.ok(!conns.some((c) => c.from === "OscillatorNode" && c.to === "AudioDestinationNode"));
  await h.setLevel(50);
  const g = await h.page.evaluate(() => window.__conns.find((c) => c.from instanceof GainNode && c.to instanceof AudioDestinationNode).from.gain.value);
  assert.ok(near(g, 0.5));
  const dis = await h.page.evaluate(() => {
    try { window.__osc.disconnect(window.__ctx.destination); } catch (e) { return e.name; }
    return window.__disconns;
  });
  assert.deepEqual(dis, [{ from: "OscillatorNode", to: "GainNode" }]);
}));

test("OfflineAudioContext untouched", () => withPage({ preLevel: 25 }, async (h) => {
  await h.page.evaluate(() => {
    const ctx = new OfflineAudioContext(1, 128, 44100);
    ctx.createOscillator().connect(ctx.destination);
  });
  const conns = await h.connections();
  assert.deepEqual(conns.map((c) => `${c.from}->${c.to}`), ["OscillatorNode->AudioDestinationNode"]);
}));

test("MediaElementSource scaled exactly once", () => withPage({ preLevel: 25 }, async (h) => {
  const res = await h.page.evaluate(async () => {
    const el = new Audio("/tone.wav");
    el.loop = true;
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(el);
    const an = ctx.createAnalyser();
    src.connect(an);
    an.connect(ctx.destination);
    await el.play();
    const rms = async () => {
      await new Promise((r) => setTimeout(r, 400));
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      return Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
    };
    const at25 = await rms();
    window.dispatchEvent(new CustomEvent("tabvolume:level", { detail: 100 }));
    const at100 = await rms();
    window.dispatchEvent(new CustomEvent("tabvolume:level", { detail: 25 }));
    const gain = window.__conns.find((c) => c.from instanceof GainNode && c.to instanceof AudioDestinationNode).from.gain.value;
    return { elementRatio: at25 / at100, gain, native: window.__native(el) };
  });
  assert.ok(Math.abs(res.elementRatio * res.gain - 0.25) < 0.03, JSON.stringify(res));
  assert.equal(res.native, 1);
}));

test("volume 0 does not bypass autoplay policy", async (t) => {
  let baseline, muted;
  await withPage({ injectPageJs: false, autoplayPolicy: "document-user-activation-required" }, async (h) => {
    baseline = await h.page.evaluate(async () => {
      const a = document.createElement("audio"); a.src = "/tone.wav"; document.body.append(a);
      try { await a.play(); return "played"; } catch (e) { return e.name; }
    });
  });
  if (baseline === "played") return t.skip("this browser does not enforce the autoplay policy here, nothing to compare");
  await withPage({ startMuted: true, autoplayPolicy: "document-user-activation-required" }, async (h) => {
    muted = await h.page.evaluate(async () => {
      const a = document.createElement("audio"); a.src = "/tone.wav"; document.body.append(a);
      try { await a.play(); return "played"; } catch (e) { return e.name; }
    });
  });
  assert.equal(muted, baseline);
});
