# Tab Volume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Brave MV3 extension that sets a tab's volume (0–100%) and remembers it per domain, applying saved levels from the first sound with no clicks.

**Architecture:** `page.js` runs in the page's MAIN world at `document_start` and patches `HTMLMediaElement.prototype.volume`, `play()` and Web Audio destination connections, so every sound is scaled by a factor. An ISOLATED-world `bridge.js` works out the tab's level (from `chrome.storage.local` for saved domains, or from the background for tab overrides) and hands it to `page.js` through window CustomEvents. A service worker registers the content scripts dynamically, so saved domains start muted until their level arrives. It also owns tab overrides, the badge, and late injection into tabs that are already open.

**Tech Stack:** Plain JavaScript, Chromium Manifest V3, no build step, no runtime dependencies. Dev only: Node 26 `node --test`, and `playwright` (driving the installed Brave, or Playwright's Chromium for extension-loading tests).

**Spec:** `docs/superpowers/specs/2026-10-22-tab-volume-design.md`

## Global Constraints

- Manifest V3, `"minimum_chrome_version": "121"`, `"version": "1.0.0"`, name "Tab Volume".
- Permissions are exactly `storage` and `scripting`, plus `host_permissions: ["<all_urls>"]`. Add `tabs` or `webNavigation` only if a test proves one is needed.
- No runtime dependencies and no bundler. Everything under `extension/` ships as is. Shared code in `extension/lib/` must load both as a classic script (sets `globalThis.TabVolume`) and through Node `require` (`module.exports`).
- A level is an integer 0–100. Factor = `level / 100`, linear amplitude.
- Storage schema: `chrome.storage.local` `{ domains: { "<site>": <level> } }`. `chrome.storage.session` `{ "tab:<tabId>": { site, level } }`.
- Cross-world events go on `window` and their `detail` is a primitive only (objects don't survive the MAIN/ISOLATED boundary).
- Saved domains never cause a full-volume moment. A failure leaves the frame muted, never at 100%.
- Commit locally after each task. Never push. Specs and plans are committed too, since this is a personal repo.
- Brave binary: `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`, overridable with `BROWSER_PATH`.

## Review Focus

1. **A site that forces volume = 1 on every new element and listens to `volumechange`** (Facebook Reels): native volume stays at the level, and the extension never loops with the site. Covered in Task 2 ("site resets volume" and "reconcile does not loop").
2. **Extension reloaded while tabs are open:** the old `page.js` is still in the page and a new bridge or late injection arrives. Expected: a single install, the factor never squared, and the level still applied. Covered in Task 2 ("double install is a no-op").
3. **Autoplay media that starts before the bridge answers on a saved domain:** native volume is never above the level at any `play` or `playing` event. Covered in Task 3 ("saved domain never plays above level").
4. **Junk import** (bad JSON, levels out of range, IPv6, unicode hosts, `"null"`): it's dropped and reported, and content-script registration still succeeds afterwards. Covered in Task 1 (`normaliseImport`) and Task 4 ("junk import keeps registration working").
5. **Opening the popup on a tab with no bridge** (opened before install, or a restricted page): a clear message instead of an exception or a dead slider. Covered in Task 1 (`classifyTab`) and Task 4 ("restricted tab").

---

## File Structure

```
package.json                     dev deps + scripts (test:unit, test:page, test:e2e, package)
.gitignore                       node_modules, dist, test-results
extension/
  manifest.json
  background.js                  classic service worker; importScripts lib/*.js
  lib/domain.js                  site rules, patterns, levels, import, tab classification
  lib/registrations.js           buildRegistrations(sites)
  content/page.js                MAIN world: volume/play/Web Audio patch
  content/start-muted.js         MAIN world: mute until level arrives
  content/bridge.js              ISOLATED world: resolve level, talk to page.js and background
  popup/popup.html, popup.css, popup.js
  icons/icon-16.png, icon-32.png, icon-48.png, icon-128.png
scripts/make-icons.mjs           generates the PNGs with node:zlib (speaker glyph)
scripts/package.mjs              zips extension/ into dist/tab-volume-1.0.0.zip
test/unit/*.test.js              node --test
test/page/*.test.js              playwright + Brave, page.js via addInitScript (no extension)
test/e2e/*.test.js               playwright with the extension loaded
test/fixtures/                   server.mjs (static + tone.wav generator), html pages
docs/manual-test.md              checklist for Brave by hand
```

## Messages and events (shared contract)

| From → to | Name | Payload | Reply |
|---|---|---|---|
| bridge → page.js | `tabvolume:level` (window CustomEvent) | `detail`: level int | — |
| start-muted → page.js | `tabvolume:start-muted` | none | — |
| page.js → bridge | `tabvolume:ready` | none | bridge re-sends its current level, marks `applied` |
| bridge → page.js | `tabvolume:hello` | none | page.js answers `tabvolume:ready` (covers a page.js installed earlier) |
| bridge → background | `{type:"tv:getTabState"}` | — | `{site: string\|null, overrideLevel: int\|null}` |
| popup → bridge (frame 0) | `{type:"tv:ping"}` | — | `{site, level, applied: bool}` |
| popup → background | `{type:"tv:setTabLevel", tabId, level}` | — | `{ok:true}` |
| popup → background | `{type:"tv:clearTabLevel", tabId}` | — | `{ok:true}` |
| background → all frames of a tab | `{type:"tv:setLevel", level}` | — | — |

Global flags on `window`: `Symbol.for("tabvolume.installed")` (set by page.js) and `Symbol.for("tabvolume.startMuted")` (set by start-muted.js).

---

### Task 1: Pure logic library

**Files:**
- Create: `package.json`, `.gitignore`, `extension/lib/domain.js`, `extension/lib/registrations.js`
- Test: `test/unit/domain.test.js`, `test/unit/registrations.test.js`

**Interfaces:**
- Produces (on `globalThis.TabVolume` and `module.exports` of each file, merged into the same object):
  - `siteOf(host: string) -> string|null`
  - `isValidSite(site: string) -> boolean`
  - `patternsForSite(site: string) -> string[]`
  - `clampLevel(v: unknown) -> number|null` (integer 0–100, rounds; null if not finite)
  - `levelFor(domains: Record<string,number>, host: string) -> number|null`
  - `normaliseImport(text: string) -> {domains: Record<string,number>, dropped: string[]}` (throws `Error("Invalid JSON")` on parse failure)
  - `isRestrictedUrl(url: string|undefined) -> boolean`
  - `classifyTab(url: string|undefined, pingOk: boolean) -> "restricted"|"needs-reload"|"ok"`
  - `buildRegistrations(sites: string[]) -> chrome.scripting.RegisteredContentScript[]`

- [ ] **Step 1: Set up `package.json`** with `"private": true`, devDependency `playwright`, and scripts `test:unit` = `node --test test/unit/`, `test:page` = `node --test test/page/`, `test:e2e` = `node --test --test-concurrency=1 test/e2e/`, `package` = `node scripts/package.mjs`. Run `npm install`.

- [ ] **Step 2: Write the failing tests** in `test/unit/domain.test.js`:

```js
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
});
test("isValidSite", () => { /* true: "facebook.com","localhost","10.0.0.1","xn--bcher-kva.ch"; false: "", "a b.com", "*.x.com", "x.com.", "[::1]", "-x.com" */ });
test("patternsForSite", () => {
  assert.deepEqual(T.patternsForSite("facebook.com"), ["*://*.facebook.com/*"]);
  assert.deepEqual(T.patternsForSite("localhost"), ["*://localhost/*"]);
  assert.deepEqual(T.patternsForSite("10.0.0.1"), ["*://10.0.0.1/*"]);
});
test("clampLevel", () => { /* 6→6, 6.4→6, 6.5→7, -3→0, 140→100, "12"→12, NaN→null, null→null */ });
test("levelFor", () => {
  const d = { "facebook.com": 6 };
  assert.equal(T.levelFor(d, "web.facebook.com"), 6);
  assert.equal(T.levelFor(d, "notfacebook.com"), null);
  assert.equal(T.levelFor(d, "youtube.com"), null);
});
test("normaliseImport own shape", () => {
  assert.deepEqual(T.normaliseImport('{"www.facebook.com": 6}'), { domains: { "facebook.com": 6 }, dropped: [] });
});
test("normaliseImport Volume Master shape", () => {
  assert.deepEqual(T.normaliseImport('{"www.facebook.com":{"volume":6},"m.youtube.com":{"volume":40}}').domains, { "facebook.com": 6, "youtube.com": 40 });
});
test("normaliseImport drops junk", () => {
  const r = T.normaliseImport('{"[::1]":5,"x.com":"loud","y.com":{"volume":null},"null":3,"bücher.ch":20,"z.com":250}');
  assert.deepEqual(r.domains, { "xn--bcher-kva.ch": 20, "z.com": 100 });
  assert.deepEqual(r.dropped.sort(), ["[::1]", "null", "x.com", "y.com"]);
});
test("normaliseImport bad JSON", () => assert.throws(() => T.normaliseImport("{"), /Invalid JSON/));
test("isRestrictedUrl / classifyTab", () => {
  for (const u of ["chrome://settings", "brave://settings", "about:blank", "chrome-extension://abc/x.html", "view-source:https://a.com", "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/x", undefined, ""])
    assert.equal(T.isRestrictedUrl(u), true, u);
  assert.equal(T.isRestrictedUrl("https://www.facebook.com/reel/1"), false);
  assert.equal(T.classifyTab("chrome://settings", false), "restricted");
  assert.equal(T.classifyTab("https://a.com/", false), "needs-reload");
  assert.equal(T.classifyTab("https://a.com/", true), "ok");
});
```

Score `z.com: 250` clamps to 100, because clamping counts as normalising, not dropping. Unicode hosts are converted through `new URL("http://" + key).hostname`.

`test/unit/registrations.test.js`:

```js
test("no saved sites", () => {
  const r = T.buildRegistrations([]);
  assert.deepEqual(r.map(x => x.id).sort(), ["tv-bridge", "tv-page"]);
  const page = r.find(x => x.id === "tv-page");
  assert.equal(page.excludeMatches, undefined);
  assert.deepEqual(page.matches, ["<all_urls>"]);
  for (const x of r) { assert.equal(x.runAt, "document_start"); assert.equal(x.allFrames, true); assert.equal(x.matchOriginAsFallback, true); assert.equal(x.persistAcrossSessions, true); }
  assert.deepEqual(r.find(x => x.id === "tv-bridge"), { id: "tv-bridge", matches: ["<all_urls>"], js: ["lib/domain.js", "content/bridge.js"], world: "ISOLATED", runAt: "document_start", allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true });
  assert.deepEqual(page.js, ["content/page.js"]); assert.equal(page.world, "MAIN");
});
test("saved sites", () => {
  const r = T.buildRegistrations(["facebook.com", "localhost"]);
  const saved = r.find(x => x.id === "tv-page-saved");
  assert.deepEqual(saved.matches, ["*://*.facebook.com/*", "*://localhost/*"]);
  assert.deepEqual(saved.js, ["content/start-muted.js", "content/page.js"]);
  assert.deepEqual(r.find(x => x.id === "tv-page").excludeMatches, saved.matches);
});
test("invalid sites are skipped", () => {
  const r = T.buildRegistrations(["facebook.com", "a b", "[::1]"]);
  assert.deepEqual(r.find(x => x.id === "tv-page-saved").matches, ["*://*.facebook.com/*"]);
});
```

- [ ] **Step 3: Run `npm run test:unit`.** Expected: FAIL (cannot find module).

- [ ] **Step 4: Implement `extension/lib/domain.js` and `extension/lib/registrations.js`.** The `siteOf` rule:
  - Lowercase the host, strip a trailing dot, and reject anything that fails `isValidSite`.
  - If the host is IPv4 or has no dot, return it as is.
  - If there are three or more labels, the TLD is 2 letters, and the second-to-last label is in `["co","com","net","org","gov","edu","ac"]`, keep the last 3 labels. Otherwise keep the last 2.

  The bottom of each file does:

  ```js
  globalThis.TabVolume = Object.assign(globalThis.TabVolume || {}, api);
  if (typeof module === "object") module.exports = api;
  ```

  `registrations.js` reads `isValidSite` and `patternsForSite` from `globalThis.TabVolume` or `require("./domain.js")`.

- [ ] **Step 5: Run `npm run test:unit`.** Expected: all PASS.

- [ ] **Step 6: Commit** `package.json package-lock.json .gitignore extension/lib test/unit` with message `feat: domain and registration logic`.

---

### Task 2: page.js and start-muted.js (MAIN-world patch)

**Files:**
- Create: `extension/content/page.js`, `extension/content/start-muted.js`, `test/fixtures/server.mjs`, `test/fixtures/media.html`, `test/page/harness.mjs`, `test/page/page.test.js`

**Interfaces:**
- Consumes: the events contract above.
- Produces:
  - Behaviour, not exports. Both files are IIFEs with no globals except the two `Symbol.for` flags.
  - `test/fixtures/server.mjs` exports `startServer() -> Promise<{url: string, close(): Promise<void>}>`. It serves `test/fixtures/*` and `/tone.wav`, a 2 s 440 Hz mono 16-bit WAV generated in memory.
  - `test/page/harness.mjs` exports:
    - `openPage({startMuted?: boolean, injectPageJs?: boolean}) -> {page, browser, nativeVolume(sel), setLevel(n), connections()}`. It launches `BROWSER_PATH` or Brave headless with `--autoplay-policy=no-user-gesture-required` (an option allows `document-user-activation-required` instead).
    - Init script 1 captures the native `volume` descriptor as `window.__native(el)` and wraps `AudioNode.prototype.connect` to log `{from: ctorName, to: ctorName, gain?: number}` into `window.__conns`.
    - Init script 2 is `start-muted.js` when asked. Init script 3 is `page.js`.
    - `setLevel(n)` dispatches `tabvolume:level` with `detail: n`.

- [ ] **Step 1: Write the failing tests** in `test/page/page.test.js`. Each uses a fresh page from the harness. All volumes are checked with `nativeVolume()`, which reads through the captured native descriptor. Floats are compared with a tolerance of 1e-6.
  - **"unset element is scaled":** create `<video src=/tone.wav>`, then `setLevel(6)`. Native volume is 0.06 and `el.volume === 1`.
  - **"page-set volume is scaled":** `setLevel(6)`, then `el.volume = 0.5`. Native volume is 0.03 and the getter returns 0.5.
  - **"level change rescales all known elements":** a DOM `<audio>`, plus a `new Audio("/tone.wav")` that was `play()`ed but never inserted. `setLevel(50)` then `setLevel(10)`: both have native volume 0.1.
  - **"site resets volume":** at level 6, the page creates 5 elements in turn, setting `volume = 1` and calling `play()` on each. Every native volume is 0.06 at its `playing` event (recorded by a capture listener the test adds).
  - **"autoplay attribute element"** parsed from HTML: `media.html?autoplay`, then `setLevel(6)` in an init script before load. Native volume at the first `play` event is 0.06.
  - **"shadow DOM element":** `attachShadow` then append `<audio autoplay>` inside the shadow root. Native volume at `playing` is the level.
  - **"start-muted mutes until level":** start-muted on, element plays, native volume 0. `setLevel(6)` gives 0.06.
  - **"start-muted after level is ignored":** with no start-muted init script, `setLevel(6)`, then dispatch `tabvolume:start-muted`. Native volume stays 0.06. With no prior level, dispatching `tabvolume:start-muted` gives native volume 0.
  - **"double install is a no-op":** evaluate the page.js source a second time, then `setLevel(50)` and set `el.volume = 0.5`. Native volume is 0.25, not 0.125.
  - **"late install seeds from native":** load without page.js, set native volume 0.4 on an element, evaluate the page.js source, `setLevel(50)`. Native volume is 0.2 and the getter returns 0.4.
  - **"reconcile does not loop":** at level 50, set native volume 0.3 through the captured native setter. Within 200 ms the getter returns 0.6, native volume is still 0.3, and fewer than 3 `volumechange` events fired. At level 0, a native change leaves the getter value as it was.
  - **"ready handshake":** page.js dispatches `tabvolume:ready` on install, and again on each `tabvolume:hello`. Check it with a listener added in init script 1.
  - **"Web Audio routed through gain":** at level 25, `osc.connect(ctx.destination)`. The log shows `OscillatorNode→GainNode` and `GainNode(gain 0.25)→AudioDestinationNode`. `setLevel(50)` makes that GainNode's `gain.value` 0.5. `osc.disconnect(ctx.destination)` doesn't throw, and nothing is connected afterwards (the oscillator was disconnected from the gain node). `connect()` returns the destination argument.
  - **"OfflineAudioContext untouched":** `osc.connect(offline.destination)` logs a direct `OscillatorNode→AudioDestinationNode`.
  - **"MediaElementSource scaled exactly once":** see Step 3.
  - **"volume 0 does not bypass autoplay policy":** under `document-user-activation-required`, with start-muted on, an unmuted `play()` without a gesture rejects with `NotAllowedError`, the same as with page.js absent.

- [ ] **Step 2: Run `npm run test:page`.** Expected: FAIL (page.js missing).

- [ ] **Step 3: Probe Chromium for MediaElementSource behaviour.** Write `test/page/probe-mes.test.js` without page.js. Route an element through `createMediaElementSource` into an `AnalyserNode`, play the tone, and compare RMS at native volume 1.0 versus 0.25. Record the result as an assertion (`affectsMES = ratio < 0.5`) and write a one-line comment with the finding in page.js.
  - If `element.volume` does affect the MES output, page.js patches `createMediaElementSource` to mark the element. A marked element gets native volume = page volume (unscaled), and only the destination gain applies.
  - Otherwise nothing extra is needed.
  - Then write the "scaled exactly once" test with the same Analyser technique, placed before the destination patch. Connect element → MES → analyser → `ctx.destination`, and assert that the RMS ratio between level 25 and level 100 measured at the analyser, multiplied by the destination GainNode's gain from the connection log, comes to 0.25 ± 0.03.

- [ ] **Step 4: Implement `content/page.js`:**
  - **Guard:** return if `window[Symbol.for("tabvolume.installed")]` is set; otherwise set it.
  - **State:** factor starts at 0 if the start-muted flag is set, otherwise 1. A `received` flag tracks whether a real level has arrived. A `WeakMap` element→pageVolume, a `Set` of `WeakRef`s of known elements, and a `Set` of gain nodes for each live AudioContext.
  - **First touch of an element:** seed pageVolume from the native volume, then register it.
  - **Patches:**
    - The `volume` accessor.
    - `play()`: apply, then call the original.
    - `attachShadow`: observe the new root.
    - A `MutationObserver` on the document root.
    - Capture listeners for `play`, `playing`, `loadstart` and `volumechange` on window and on each observed shadow root.
    - `AudioNode.prototype.connect` and `disconnect`, when the target is the destination of a non-Offline `BaseAudioContext`.
    - `createMediaElementSource`, only if the probe says so.
  - **Self-caused changes:** track volume writes the patch makes itself with a per-element "expected native value". A `volumechange` whose native value equals the expected one is ignored. Anything else is reconciled, unless factor is 0.
  - **Events:** listen for `tabvolume:level` (set factor, mark received, rescale all) and `tabvolume:start-muted` (set factor 0 and rescale, only if no level has been received). Dispatch `tabvolume:ready` at the end.
  - **`start-muted.js`:** set the flag, then dispatch `tabvolume:start-muted` (harmless if page.js isn't installed yet).

- [ ] **Step 5: Run `npm run test:page`.** Expected: all PASS.

- [ ] **Step 6: Commit** `extension/content/page.js extension/content/start-muted.js test/page test/fixtures` with message `feat: page-level volume patch`.

---

### Task 3: Background, bridge, manifest and icons

**Files:**
- Create: `extension/manifest.json`, `extension/background.js`, `extension/content/bridge.js`, `scripts/make-icons.mjs`, `extension/icons/*.png`, `test/e2e/harness.mjs`, `test/e2e/extension.test.js`

**Interfaces:**
- Consumes: Task 1 (`TabVolume.*`) and Task 2 (the events). `background.js` calls `importScripts("lib/domain.js", "lib/registrations.js")`.
- Produces:
  - Messages per the contract table.
  - `test/e2e/harness.mjs` exports `launch() -> {context, sw, serverUrl(host), extensionId, nativeLog(page), close()}`.
    - It uses `chromium.launchPersistentContext` with `--disable-extensions-except` and `--load-extension` pointing at `extension/`, and `--host-resolver-rules=MAP *.test 127.0.0.1`.
    - It tries `BROWSER_PATH`/Brave first. If no extension service worker appears within 5 s, it falls back to Playwright's bundled Chromium. Install that with `npx playwright install chromium` and note it in a test-file comment.
    - `nativeLog(page)` uses CDP `Page.addScriptToEvaluateOnNewDocument` with a `worldName`. In that isolated world the prototypes are untouched, so it records the native volume at every `play`/`playing` event and on demand.

- [ ] **Step 1: Write the failing tests** in `test/e2e/extension.test.js`. Pages are served as `http://www.loud.test:<port>/media.html` and `http://other.test:<port>/...`. Storage is seeded with `sw.evaluate(...)`.
  - **"saved domain never plays above level":** seed `domains: {"loud.test": 6}` and wait until `chrome.scripting.getRegisteredContentScripts` shows `tv-page-saved`. Open `media.html?autoplay`. Every native volume in the log is ≤ 0.06 and the last one is 0.06.
  - **"live update across tabs and cross-origin iframe":** two loud.test tabs, one of which embeds an other.test iframe with `<audio autoplay>`. Set the level to 20. Within 500 ms every element in every frame has native volume 0.2.
  - **"unsaved domain tab override":** on an other.test tab, send `tv:setTabLevel` for 30 from an extension page via `chrome.runtime.sendMessage`. Native volume is 0.3. It survives navigating to another other.test page, is cleared after navigating to `loud2.test`, and is gone after the tab closes (session storage key removed).
  - **"forgetting a domain restores 100":** remove `loud.test` from domains. Its elements go to 1.0.
  - **"badge":** `chrome.action.getBadgeText({tabId})` is `"6"` on the loud.test tab and `""` on other.test. It is still `"6"` after a reload.
  - **"already-open tab gets late injection":** open an other.test tab, then call the background's `injectIntoOpenTabs()` exposed on `self` for tests. Do this rather than reloading the extension. A `tv:ping` to that tab succeeds and the tab override applies.
  - **"junk import keeps registration working":** seed domains with an invalid key such as `"a b"` directly. After the registration sync, `tv-page` and `tv-bridge` are still registered and loud.test still works.

- [ ] **Step 2: Run `npm run test:e2e`.** Expected: FAIL (no manifest).

- [ ] **Step 3: Write `manifest.json`:**
  - `background.service_worker: "background.js"` (classic, not a module).
  - `action.default_popup: "popup/popup.html"`, with icons for every size.
  - Permissions as in Global Constraints.
  - No static `content_scripts`.

  Then generate the icons: a simple speaker glyph on a transparent background, from `node scripts/make-icons.mjs`, using `node:zlib` with no dependencies. Commit the PNGs.

- [ ] **Step 4: Implement `background.js`:**
  - **`syncRegistrations()`:** serialised through a promise chain. It reads `domains`, unregisters only ids starting with `tv-`, and registers `buildRegistrations(Object.keys(domains))`. It runs on `onInstalled`, `onStartup`, and `storage.onChanged` for `domains`. It catches and logs errors, never throws.
  - **`injectIntoOpenTabs()`:**
    - For every tab from `chrome.tabs.query({})` that isn't `isRestrictedUrl`, run `executeScript` for all frames with `injectImmediately`.
    - Inject `content/page.js` in MAIN, then `lib/domain.js` and `content/bridge.js` in ISOLATED.
    - Saved-site tabs get no start-muted, because late injection seeds from the native volume.
    - It runs on `onInstalled` and ignores per-tab failures. Expose it as `self.injectIntoOpenTabs`.
  - **Message handlers** follow the contract table. The site comes from `siteOf(new URL(sender.tab.url).hostname)`.
  - **Overrides:** `tabs.onUpdated` with `changeInfo.url` drops an override whose site no longer matches. `tabs.onRemoved` drops it. Both also refresh the badge.
  - **`updateBadge(tabId, url)`:** text = the effective level when below 100, otherwise `""`. It runs on `tabs.onUpdated` (status `loading`/`complete`), on override changes, and for all tabs on `domains` changes.

- [ ] **Step 5: Implement `content/bridge.js`:**
  - **Finding the site:** the top host is the last entry of `location.ancestorOrigins` if present and not `"null"`, otherwise `location.hostname` in the top frame. Use `siteOf` on it.
  - **Resolving the level:** use `domains[site]` if saved. Otherwise ask `tv:getTabState` and use `overrideLevel ?? 100`. If the site couldn't be found locally, use the background's `site` and its override instead.
  - **Sending:** dispatch `tabvolume:hello` and `tabvolume:level` immediately, and dispatch `tabvolume:level` again on every `tabvolume:ready`. Set `applied = true` once any `tabvolume:ready` has been seen.
  - **Changes:** handle `storage.onChanged` for `domains` by re-resolving. Handle `tv:setLevel` by applying it, but only while the site isn't saved.
  - **Ping:** answer `tv:ping` with `{site, level, applied}`, in the top frame only.
  - **Invalidated context:** wrap every `chrome.*` call in try/catch. After the extension is reloaded the old bridge goes quiet, and the new bridge or late injection takes over.

- [ ] **Step 6: Run `npm run test:e2e && npm run test:unit && npm run test:page`.** Expected: all PASS.

- [ ] **Step 7: Commit** `extension/manifest.json extension/background.js extension/content/bridge.js extension/icons scripts/make-icons.mjs test/e2e` with message `feat: background, bridge and manifest`.

---

### Task 4: Popup

**Files:**
- Create: `extension/popup/popup.html`, `extension/popup/popup.css`, `extension/popup/popup.js`, `test/e2e/popup.test.js`

**Interfaces:**
- Consumes: `TabVolume.*` (loaded with `<script src="../lib/domain.js">`) and the messages in the contract table.
- Produces: the UI. For tests, `popup.html?tabId=<n>` targets that tab instead of the active tab.

- [ ] **Step 1: Write the failing tests** in `test/e2e/popup.test.js`. Open the popup page in a tab of its own against a target tab.
  - **"slider and number stay in sync":** typing 6 in `#level-number` sets `#level-slider` to 6 and the target's native volume to 0.06 (as a tab override). Moving the slider to 40 updates the number to 40.
  - **"remember toggle":** at 40 on other.test, checking `#remember` stores `domains["other.test"] === 40` and clears the override. Moving to 12 updates storage. Unchecking removes the domain, and the target goes to native 1.0.
  - **"label shows site":** the `#remember` label text is `Remember for other.test` on `www.other.test`.
  - **"saved list":** with `{"a.test": 5, "b.test": 50}` saved, `#saved li` lists both, sorted by name. Editing b.test's number to 60 updates storage. The remove button deletes a.test.
  - **"import":** paste `{"www.c.test":{"volume":7},"[::1]":3}` into `#import-text` and click `#import-btn`. Storage gains `c.test: 7`, existing entries are kept, and `#import-result` says `Imported 1, skipped 1: [::1]`.
  - **"restricted tab":** with a target tab on `chrome://version`, `#status` says `Tab Volume can't control this page.` and the controls are disabled.
  - **"not applied":** a ping answer with `applied: false` (stub it by sending it from a fake bridge, or by blocking page.js) shows `#status` = `Volume not applied yet. Reload this tab.` plus `#reload`.
  - **"needs reload":** with a target tab where no bridge answers within 300 ms, `#status` says `Reload this tab to control its volume.` and a `#reload` button reloads it. To set this up without a bridge, unregister the content scripts in the test, open a tab, then re-register.

- [ ] **Step 2: Run `npm run test:e2e`.** Expected: the popup tests FAIL.

- [ ] **Step 3: Implement the popup:**
  - **Layout:** about 280 px wide, plain, light and dark through `prefers-color-scheme`.
  - **Top section:** the tab's site. A range slider (0–100, step 1) next to a number box (0–100). A `#remember` checkbox with label `Remember for <site>`. A `#status` line.
  - **Below:** a "Saved sites" list (site, number box, remove "×"). A collapsible "Import" section with `#import-text`, `#import-btn` and `#import-result`.
  - **Writes:** a saved level writes `domains` on `input` events. An unsaved level sends `tv:setTabLevel`.
  - **Toggle on:** write the domain, then send `tv:clearTabLevel`.
  - **Toggle off:** send `tv:clearTabLevel` first, then delete the domain.
  - **Tab state:** use `classifyTab(url, pingOk)` with a 300 ms ping timeout.

- [ ] **Step 4: Run all three test suites.** Expected: all PASS.

- [ ] **Step 5: Commit** `extension/popup test/e2e/popup.test.js` with message `feat: popup`.

---

### Task 5: Packaging and manual check

**Files:**
- Create: `scripts/package.mjs`, `docs/manual-test.md`, `README.md`

**Interfaces:**
- Consumes: the whole `extension/` folder.
- Produces: `dist/tab-volume-1.0.0.zip`, with `manifest.json` at the zip root and only the `extension/` contents inside.

- [ ] **Step 1: Write `scripts/package.mjs`.** Use the system `zip -r -X` from inside `extension/`. Read the version from the manifest and print the zip path and size.

- [ ] **Step 2: Run `npm run package && unzip -l dist/tab-volume-1.0.0.zip`.** Expected: `manifest.json`, `background.js`, `lib/`, `content/`, `popup/` and `icons/` at the root, and no `test/` or `docs/`.

- [ ] **Step 3: Write `docs/manual-test.md`.** It's the Brave checklist:
  - Load the unpacked zip with a facebook.com tab already open.
  - Set 6% and remember it. Scroll 10 Reels: never loud. Close and reopen Facebook: 6% from the first sound.
  - The badge shows 6.
  - YouTube with no saved level stays normal. A per-tab change resets when the tab closes.
  - brave://settings shows the restricted message.
  - Import Volume Master settings by pasting JSON.

  `README.md` covers install (unzip, brave://extensions, Developer mode, Load unpacked), the behaviour summary, and how to run the tests.

- [ ] **Step 4: Commit** `scripts/package.mjs docs/manual-test.md README.md` with message `chore: packaging and manual checklist`.
