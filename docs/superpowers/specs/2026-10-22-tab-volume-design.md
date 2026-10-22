# Tab Volume — design

## Intent

Marc uses Volume Master in Brave to turn down loud sites. Facebook needs about 6%. Facebook's own player control is useless because it resets on every Reel. Volume Master works, but it captures the tab's audio (tabCapture plus a GainNode in an offscreen document), and capture can only start after the user moves its popup slider. So it never re-applies a level on its own. Each reopened Facebook tab plays at full volume until Marc opens the popup again.

Tab Volume is a small personal Brave extension. It sets a tab's volume between 0 and 100% and remembers that level per domain, so a saved domain is always at its level from the first sound, with no clicks.

Success: Marc opens Facebook, scrolls Reels, and never hears full volume.

## Goals

- Set the volume of the current tab from 0 to 100% in 1% steps, with a slider and an exact number box.
- Save a level for a domain. Every tab of that domain, including already-open ones, plays at that level automatically.
- No full-volume "blast" at load or when a new video starts on a saved domain. This is the core requirement.
- Survive sites that reset the player volume (Facebook Reels).

## Non-goals

- Going above 100%, voice boost, equaliser, keyboard shortcuts, and other Volume Master features.
- Publishing to a store. It is loaded unpacked through brave://extensions.
- Firefox support. Chromium/Brave MV3 only.

## Anti-goals (failure even if it "works")

- Any audible full-volume moment on a saved domain before the level is applied.
- Breaking site players, for example a site's own volume UI showing nonsense or the site fighting the extension in a loop.
- A "sharing this tab" indicator, or anything else that needs a click per tab.

## Behaviour (agreed with Marc)

- **Popup** on the current tab: a slider (0–100, step 1), a number box synced with it, and a "Remember for <domain>" toggle.
- **Unsaved domain:** moving the slider changes only this tab. It is a tab override (see below).
- **Toggle on:** saves the current tab level for the domain and clears the tab override. All open tabs of that domain switch to the level live.
- **Saved domain:** moving the slider updates the saved value, and every open tab on that domain follows live.
- **Toggle off:** forgets the domain. Its tabs go back to 100% (normal), and any tab override on this tab is cleared too.
- **Subdomains are the same site.** A setting for `facebook.com` covers `www.`, `web.`, `m.facebook.com`, and so on. If several saved domains match a host, the longest match wins.
- **The tab's address decides.** Every frame in a tab, including cross-origin iframes (a YouTube embed in a news article), uses the level for the tab's top-level domain.
- **Saved-domains list** in the popup: each saved domain with its level, editable inline, plus a remove button.
- **Badge:** the toolbar icon shows the tab's effective level as text ("6") when it is below 100, and nothing at 100.
- **Import:** a small import box (in the popup or an options page) that accepts JSON either in our own shape, `{"facebook.com": 6}`, or in Volume Master's shape, `{"www.facebook.com": {"volume": 6}}`. Hosts are normalised to the domain rule below. This is a one-time convenience, not a sync.
- **Pages the extension can't touch** (brave://, chrome://, the Web Store, file:// without access): the popup says so and disables the controls.

## Decided "how" (Claude's calls, accepted by Marc)

Plain JavaScript, Manifest V3, no build step and no runtime dependencies. Brave is Chromium, so Chromium MV3 APIs apply.

**Mechanism: patch the page, don't capture the tab.** A script runs in the page's MAIN world at `document_start`, in all frames, before any site code runs. It changes how media volume works for the whole page:

- **The `volume` accessor on `HTMLMediaElement.prototype` is replaced.** The setter records the volume the page asked for, per element, and writes `pageVolume × factor` through the native setter. The getter returns the page's requested value, so the site's own UI stays consistent and doesn't fight back. An element the page never set counts as page volume 1.0.
- **Every element is scaled before it makes sound.** This covers `play()` (patched), parser-created and `autoplay` elements (MutationObserver plus capture-phase `play`/`playing`/`loadstart` listeners), elements inside shadow roots (for example by hooking `attachShadow`), and `new Audio()` elements never added to the DOM (through the `play()` patch). The script keeps a registry of elements it has seen, with weak references, so that a factor change rescales all of them.
- **Web Audio is covered too.** Calls that connect a node to an `AudioContext`'s destination are routed through a per-context GainNode set to the factor. `disconnect` of the destination must keep working. `OfflineAudioContext` is not touched. A media element routed into Web Audio (`createMediaElementSource`) must end up scaled exactly once, not twice. Check this in Brave rather than assuming it.
- The factor is linear amplitude (`percent / 100`), the same scale Volume Master uses, so Marc's "6%" means the same thing.

**Getting the level in time.** MAIN-world scripts have no `chrome.*` access, and storage is async, so:

- Scripts are registered dynamically with `chrome.scripting.registerContentScripts` (persisting across sessions). The registration is re-synced whenever the saved domains change, and on install and startup.
- For **saved domains** (match patterns `*://*.<domain>/*`), the MAIN-world script list is `[start-muted.js, page.js]`. `start-muted.js` sets a flag so `page.js` starts with factor 0 until the real level arrives. The worst case is a few milliseconds of silence, never a blast.
- For **all other URLs** (`<all_urls>`, with `excludeMatches` for the saved patterns), the list is just `[page.js]`, starting at factor 1, a pass-through.
- All registrations use `allFrames: true` and `matchOriginAsFallback: true`, and include a guard so that `page.js` never installs twice in one frame.
- An ISOLATED-world bridge script runs in every frame. It works out the tab's top-level host (`location.ancestorOrigins` for iframes, `location` for the top frame). It reads the saved domains from `chrome.storage.local` directly, so it doesn't need to wake the service worker, and sends the factor to `page.js`, for example through a window CustomEvent. If no saved domain matches, it asks the background for a tab override. It listens to `storage.onChanged` (so saved-domain edits apply live to every tab) and to `runtime.onMessage` (for tab-override changes).
- **Accepted gap:** a cross-origin iframe inside a saved tab, whose own origin is not saved, starts at pass-through and gets corrected within milliseconds. The browser's autoplay policy makes an instant-sound embed unlikely. A frame whose origin is saved but whose tab isn't starts muted and is un-muted the same way.

**Tab overrides** (unsaved domains) live in `chrome.storage.session`, keyed by tab id, as `{domain, volume}`. They are kept across same-domain navigations in the tab, dropped when the tab moves to a different domain, and cleared when the tab closes. The background answers the bridge's "what's my tab's level" request using `sender.tab`.

**Domain rule:** a host is normalised to its "site" with a heuristic, not the full Public Suffix List. Take the last two labels, or the last three when the second-to-last label is a common second-level label (`co`, `com`, `net`, `org`, `gov`, `edu`, `ac`) and the TLD is two letters (so `bbc.co.uk` works). IP addresses and single-label hosts such as `localhost` stay as they are. The same function is used for saving, lookup and import. Lookup matches a host when `host === d` or `host.endsWith('.' + d)`.

**Permissions:** `storage`, `scripting`, and `host_permissions: ["<all_urls>"]`. Add `tabs` or `webNavigation` only if actually needed.

## Settled after the builder review (Claude's calls)

- **Native `<video controls>` UI** changes volume through the browser's own internals and bypasses the patched accessor. Facebook and most sites use their own player UI, so this is acceptable. `page.js` reconciles: a `volumechange` that it didn't cause itself sets `pageVolume = native / factor` (skipped while factor is 0). It must never loop.
- **Tabs already open at install or extension reload** don't get registered content scripts. On install, startup and extension reload, the background late-injects the bridge and `page.js` into all existing tabs with `scripting.executeScript` (all frames). A late `page.js` seeds each existing element's `pageVolume` from its current native volume, so it never blasts or mis-scales. The popup still separates "no bridge answered (offer reload)" from "restricted page" with an explicit restricted-URL list plus a ping timeout. Don't rely on `tab.url` being undefined.
- **If the real level never arrives on a saved domain**, the frame stays muted. Silence beats a blast. The popup shows that the level isn't applied and offers a reload. There is no timeout fallback to 100%.
- **Domains are always normalised to the site**, so saved entries never nest. The "longest match wins" rule is dropped. Collapsing shared hosts such as `*.github.io` into one entry is accepted.
- **Start-muted must not depend on script order.** If `page.js` is already installed when `start-muted.js` runs (possible with overlapping registrations on `about:blank`/`data:`/`blob:` fallback frames), `start-muted.js` pushes factor 0 into it instead of only setting a flag.
- **Registration must never fail as a whole.** Match patterns are generated only from sanitised domains: lowercase, punycode, no trailing dot, valid characters. IPs and single-label hosts get exact-host patterns (no `*.`). Invalid import entries are dropped and reported.
- **The badge is re-set after navigation**, because per-tab badge text clears on navigation.
- **To verify in a real Brave, not assume:** whether `element.volume` affects a `MediaElementAudioSourceNode` path. The Web Audio patch must give exactly one factor of scaling in either case. Also check that native volume 0 doesn't change autoplay-policy behaviour. Chromium's policy keys on `muted`, but confirm it.

## Constraints

- Brave on macOS, current version, Manifest V3.
- No build step, no npm runtime dependencies. Dev-only test tooling is fine.
- Built and quick-tested on this Mac (`~/projects/tab-volume`), then shipped as a zip to another computer, where Marc reviews it and loads it unpacked.

## Left to the builder

- File layout, UI styling (keep it small and plain, light and dark), icon.
- The exact CustomEvent and message names and payloads.
- Whether import lives in the popup or a separate options page.
- The test approach. Pure logic (domain rule, lookup, volume math) should get unit tests with `node --test`. For the page patch, an automated check in a real Chromium is preferred: for example `playwright-core` driving the installed Brave with the unpacked extension and a local test page that reads native volume through the original descriptor. Then a manual check on Facebook Reels.
- The zip: the extension folder only (manifest at the zip root), no docs or tests.
