const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../extension/lib/domain.js");

test("siteOf", () => {
  assert.equal(T.siteOf("www.facebook.com"), "facebook.com");
  assert.equal(T.siteOf("web.facebook.com"), "facebook.com");
  assert.equal(T.siteOf("facebook.com"), "facebook.com");
  assert.equal(T.siteOf("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(T.siteOf("shop.example.com.au"), "example.com.au");
  assert.equal(T.siteOf("a.b.co"), "b.co");
  assert.equal(T.siteOf("foo.github.io"), "github.io");
  assert.equal(T.siteOf("WWW.Example.COM."), "example.com");
  assert.equal(T.siteOf("localhost"), "localhost");
  assert.equal(T.siteOf("192.168.1.10"), "192.168.1.10");
  assert.equal(T.siteOf("[::1]"), null);
  assert.equal(T.siteOf(""), null);
  assert.equal(T.siteOf(undefined), null);
});

test("isValidSite", () => {
  for (const s of ["facebook.com", "localhost", "10.0.0.1", "xn--bcher-kva.ch"]) assert.equal(T.isValidSite(s), true, s);
  for (const s of ["", "a b.com", "*.x.com", "x.com.", "[::1]", "-x.com", "x..com", "X.com"]) assert.equal(T.isValidSite(s), false, s);
});

test("patternsForSite", () => {
  assert.deepEqual(T.patternsForSite("facebook.com"), ["*://*.facebook.com/*"]);
  assert.deepEqual(T.patternsForSite("localhost"), ["*://localhost/*"]);
  assert.deepEqual(T.patternsForSite("10.0.0.1"), ["*://10.0.0.1/*"]);
});

test("clampLevel", () => {
  assert.equal(T.clampLevel(6), 6);
  assert.equal(T.clampLevel(6.4), 6);
  assert.equal(T.clampLevel(6.5), 7);
  assert.equal(T.clampLevel(-3), 0);
  assert.equal(T.clampLevel(140), 100);
  assert.equal(T.clampLevel("12"), 12);
  assert.equal(T.clampLevel(NaN), null);
  assert.equal(T.clampLevel(null), null);
  assert.equal(T.clampLevel(""), null);
  assert.equal(T.clampLevel("loud"), null);
});

test("levelFor", () => {
  const d = { "facebook.com": 6 };
  assert.equal(T.levelFor(d, "web.facebook.com"), 6);
  assert.equal(T.levelFor(d, "facebook.com"), 6);
  assert.equal(T.levelFor(d, "notfacebook.com"), null);
  assert.equal(T.levelFor(d, "youtube.com"), null);
  assert.equal(T.levelFor({ "a.com": 0 }, "a.com"), 0);
});

test("normaliseImport own shape", () => {
  assert.deepEqual(T.normaliseImport('{"www.facebook.com": 6}'), { domains: { "facebook.com": 6 }, dropped: [] });
});

test("normaliseImport Volume Master shape", () => {
  assert.deepEqual(
    T.normaliseImport('{"www.facebook.com":{"volume":6},"m.youtube.com":{"volume":40}}').domains,
    { "facebook.com": 6, "youtube.com": 40 },
  );
});

test("normaliseImport drops junk", () => {
  const r = T.normaliseImport('{"[::1]":5,"x.com":"loud","y.com":{"volume":null},"null":3,"bücher.ch":20,"z.com":250}');
  assert.deepEqual(r.domains, { "xn--bcher-kva.ch": 20, "z.com": 100 });
  assert.deepEqual(r.dropped.sort(), ["[::1]", "null", "x.com", "y.com"]);
});

test("normaliseImport bad JSON", () => {
  assert.throws(() => T.normaliseImport("{"), /Invalid JSON/);
  assert.throws(() => T.normaliseImport("[1,2]"), /Invalid JSON/);
});

test("isRestrictedUrl / classifyTab", () => {
  for (const u of ["chrome://settings", "brave://settings", "about:blank", "chrome-extension://abc/x.html", "view-source:https://a.com", "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/x", undefined, ""])
    assert.equal(T.isRestrictedUrl(u), true, String(u));
  assert.equal(T.isRestrictedUrl("https://www.facebook.com/reel/1"), false);
  assert.equal(T.classifyTab("chrome://settings", false), "restricted");
  assert.equal(T.classifyTab("chrome://settings", true), "restricted");
  assert.equal(T.classifyTab("https://a.com/", false), "needs-reload");
  assert.equal(T.classifyTab("https://a.com/", true), "ok");
});
