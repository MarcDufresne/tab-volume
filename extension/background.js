importScripts("lib/domain.js", "lib/registrations.js");

const { siteOf, clampLevel, isRestrictedUrl, buildRegistrations } = self.TabVolume;

const overrideKey = (tabId) => `tab:${tabId}`;

function siteOfUrl(url) {
  try {
    return siteOf(new URL(url).hostname);
  } catch {
    return null;
  }
}

async function getDomains() {
  const { domains } = await chrome.storage.local.get("domains");
  return domains && typeof domains === "object" ? domains : {};
}

async function getOverride(tabId) {
  const key = overrideKey(tabId);
  return (await chrome.storage.session.get(key))[key] || null;
}

let registrationChain = Promise.resolve();

function syncRegistrations() {
  registrationChain = registrationChain
    .then(async () => {
      const desired = buildRegistrations(Object.keys(await getDomains()));
      const existing = (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith("tv-"));
      const existingIds = new Set(existing.map((s) => s.id));
      const desiredIds = new Set(desired.map((s) => s.id));
      const stale = [...existingIds].filter((id) => !desiredIds.has(id));
      if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
      const updates = desired.filter((s) => existingIds.has(s.id)).map((s) => ({ excludeMatches: [], ...s }));
      if (updates.length) await chrome.scripting.updateContentScripts(updates);
      const added = desired.filter((s) => !existingIds.has(s.id));
      if (added.length) await chrome.scripting.registerContentScripts(added);
    })
    .catch((e) => console.error("Tab Volume: content script registration failed", e));
  return registrationChain;
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => !isRestrictedUrl(t.url))
      .map(async (t) => {
        const target = { tabId: t.id, allFrames: true };
        try {
          await chrome.scripting.executeScript({ target, files: ["content/page.js"], world: "MAIN", injectImmediately: true });
          await chrome.scripting.executeScript({ target, files: ["lib/domain.js", "content/bridge.js"], world: "ISOLATED", injectImmediately: true });
        } catch {
          // Tabs the extension may not script (error pages, discarded tabs) are skipped.
        }
      }),
  );
}

async function effectiveLevel(tabId, url) {
  const site = siteOfUrl(url);
  if (!site) return null;
  const domains = await getDomains();
  if (Object.prototype.hasOwnProperty.call(domains, site)) return clampLevel(domains[site]);
  const override = await getOverride(tabId);
  return override && override.site === site ? override.level : 100;
}

async function updateBadge(tabId, url) {
  const level = isRestrictedUrl(url) ? null : await effectiveLevel(tabId, url);
  const text = level !== null && level < 100 ? String(level) : "";
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

async function updateAllBadges() {
  for (const t of await chrome.tabs.query({})) await updateBadge(t.id, t.url);
}

async function setTabLevel(tabId, rawLevel) {
  const tab = await chrome.tabs.get(tabId);
  const site = siteOfUrl(tab.url);
  const level = clampLevel(rawLevel);
  if (!site || level === null) return { ok: false };
  await chrome.storage.session.set({ [overrideKey(tabId)]: { site, level } });
  await chrome.tabs.sendMessage(tabId, { type: "tv:setLevel", level }).catch(() => {});
  await updateBadge(tabId, tab.url);
  return { ok: true };
}

async function clearTabLevel(tabId) {
  await chrome.storage.session.remove(overrideKey(tabId));
  // Bridges on a saved site ignore this, so it only resets tabs that were following the override.
  await chrome.tabs.sendMessage(tabId, { type: "tv:setLevel", level: 100 }).catch(() => {});
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await updateBadge(tabId, tab.url);
  return { ok: true };
}

async function getTabState(tab) {
  if (!tab) return { site: null, overrideLevel: null };
  const site = siteOfUrl(tab.url);
  const override = await getOverride(tab.id);
  return { site, overrideLevel: override && site && override.site === site ? override.level : null };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    "tv:getTabState": () => getTabState(sender.tab),
    "tv:setTabLevel": () => setTabLevel(msg.tabId, msg.level),
    "tv:clearTabLevel": () => clearTabLevel(msg.tabId),
  };
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const override = await getOverride(tabId);
    if (override && override.site !== siteOfUrl(changeInfo.url)) await chrome.storage.session.remove(overrideKey(tabId));
  }
  if (changeInfo.url || changeInfo.status) await updateBadge(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(overrideKey(tabId)));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.domains) return;
  syncRegistrations();
  updateAllBadges();
});

chrome.runtime.onInstalled.addListener(async () => {
  await syncRegistrations();
  await injectIntoOpenTabs();
  await updateAllBadges();
});

chrome.runtime.onStartup.addListener(() => syncRegistrations());

self.tv = { syncRegistrations, injectIntoOpenTabs, setTabLevel, clearTabLevel };
