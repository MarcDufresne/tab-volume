const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../extension/lib/registrations.js");

test("no saved sites", () => {
  const r = T.buildRegistrations([]);
  assert.deepEqual(r.map((x) => x.id).sort(), ["tv-bridge", "tv-page"]);
  const page = r.find((x) => x.id === "tv-page");
  assert.equal(page.excludeMatches, undefined);
  assert.deepEqual(page.matches, ["<all_urls>"]);
  for (const x of r) {
    assert.equal(x.runAt, "document_start");
    assert.equal(x.allFrames, true);
    assert.equal(x.matchOriginAsFallback, true);
    assert.equal(x.persistAcrossSessions, true);
  }
  assert.deepEqual(r.find((x) => x.id === "tv-bridge"), {
    id: "tv-bridge", matches: ["<all_urls>"], js: ["lib/domain.js", "content/bridge.js"], world: "ISOLATED",
    runAt: "document_start", allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true,
  });
  assert.deepEqual(page.js, ["content/page.js"]);
  assert.equal(page.world, "MAIN");
});

test("saved sites", () => {
  const r = T.buildRegistrations(["facebook.com", "localhost"]);
  const saved = r.find((x) => x.id === "tv-page-saved");
  assert.deepEqual(saved.matches, ["*://*.facebook.com/*", "*://localhost/*"]);
  assert.deepEqual(saved.js, ["content/start-muted.js", "content/page.js"]);
  assert.equal(saved.world, "MAIN");
  assert.deepEqual(r.find((x) => x.id === "tv-page").excludeMatches, saved.matches);
});

test("invalid sites are skipped", () => {
  const r = T.buildRegistrations(["facebook.com", "a b", "[::1]"]);
  assert.deepEqual(r.find((x) => x.id === "tv-page-saved").matches, ["*://*.facebook.com/*"]);
  assert.equal(T.buildRegistrations(["a b"]).find((x) => x.id === "tv-page-saved"), undefined);
});
