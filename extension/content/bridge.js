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

  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function send() {
    if (level !== null) window.dispatchEvent(new CustomEvent("tabvolume:level", { detail: level }));
  }

  function setLevel(next) {
    if (next === null || next === level) return;
    level = next;
    send();
  }

  async function attempt(fn, fallback) {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  async function resolveLevel() {
    try {
      domains = (await chrome.storage.local.get("domains")).domains || {};
    } catch {
      // Without the saved levels a saved site can't be told apart; staying silent beats a blast.
      return;
    }
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

  function onReady() {
    if (!alive()) {
      window.removeEventListener("tabvolume:ready", onReady);
      return;
    }
    applied = true;
    send();
  }
  window.addEventListener("tabvolume:ready", onReady);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.domains) return;
      const wasSaved = isSaved();
      domains = changes.domains.newValue || {};
      if (isSaved()) setLevel(levelFor(domains, site));
      else if (wasSaved || site === null) resolveLevel();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === "tv:setLevel" && !isSaved()) {
        setLevel(clampLevel(msg.level));
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
