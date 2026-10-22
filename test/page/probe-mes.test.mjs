import { test } from "node:test";
import assert from "node:assert/strict";
import { openPage } from "./harness.mjs";

// Measures what Chromium does on its own (no page.js): does HTMLMediaElement.volume
// scale the signal that a MediaElementAudioSourceNode feeds into Web Audio?
// page.js relies on this finding (see the MES comment there).
test("probe: element.volume scales MediaElementAudioSourceNode output in Chromium", async () => {
  const h = await openPage({ injectPageJs: false });
  try {
    const ratio = await h.page.evaluate(async () => {
      const el = new Audio("/tone.wav");
      el.loop = true;
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(el);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      await el.play();
      const rms = async () => {
        await new Promise((r) => setTimeout(r, 400));
        const buf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(buf);
        return Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
      };
      el.volume = 1;
      const full = await rms();
      el.volume = 0.25;
      const quarter = await rms();
      return quarter / full;
    });
    assert.ok(ratio > 0.2 && ratio < 0.3, `expected element.volume to scale MES output (ratio ${ratio})`);
  } finally {
    await h.close();
  }
});
