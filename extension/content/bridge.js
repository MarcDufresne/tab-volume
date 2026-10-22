(() => {
  const { siteOf, levelFor, clampLevel } = globalThis.TabVolume;
  const isTop = window === window.top;

  function topHost() {
    if (isTop) return location.hostname;
    const ancestors = location.ancestorOrigins;
    const top = ancestors && ancestors.length ? ancestors[ancestors.length - 1] : null;
    if (!top || top === "null") return null;
    try {
      return new URL(top).hostname;
    } catch {
      return null;
    }
  }

  let site = siteOf(topHost());
  let domains = {};
  let level = null;
  let applied = false;

  const isSaved = () => site !== null && levelFor(domains, site) !== null;

  function send() {
    if (level !== null) window.dispatchEvent(new CustomEvent("tabvolume:level", { detail: level }));
  }

  async function attempt(fn, fallback) {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  async function resolveLevel() {
    domains = await attempt(async () => (await chrome.storage.local.get("domains")).domains || {}, domains);
    let next = site ? levelFor(domains, site) : null;
    if (next === null) {
      const state = await attempt(() => chrome.runtime.sendMessage({ type: "tv:getTabState" }), null);
      if (!site && state && state.site) {
        site = state.site;
        next = levelFor(domains, site);
      }
      if (next === null) next = state && state.overrideLevel !== null && state.overrideLevel !== undefined ? state.overrideLevel : 100;
    }
    level = next;
    send();
  }

  window.addEventListener("tabvolume:ready", () => {
    applied = true;
    send();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.domains) resolveLevel();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === "tv:setLevel" && !isSaved()) {
        const next = clampLevel(msg.level);
        if (next !== null) {
          level = next;
          send();
        }
      } else if (msg.type === "tv:ping" && isTop) {
        sendResponse({ site, level, applied });
      }
      return false;
    });
  } catch {
    // The extension was reloaded; a fresh bridge takes over this frame.
    return;
  }

  window.dispatchEvent(new Event("tabvolume:hello"));
  resolveLevel();
})();
