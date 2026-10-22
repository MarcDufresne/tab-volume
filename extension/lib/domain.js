(() => {
  const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
  const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const RESTRICTED_SCHEMES = ["chrome:", "brave:", "edge:", "about:", "chrome-extension:", "chrome-search:", "chrome-untrusted:", "devtools:", "view-source:", "data:", "javascript:", "blob:", "filesystem:"];
  const RESTRICTED_PREFIXES = ["https://chromewebstore.google.com/", "https://chrome.google.com/webstore"];

  function isValidSite(site) {
    if (typeof site !== "string" || site === "") return false;
    if (IPV4.test(site)) return site.split(".").every((n) => Number(n) <= 255);
    return site.split(".").every((label) => LABEL.test(label));
  }

  function siteOf(host) {
    if (typeof host !== "string") return null;
    const h = host.toLowerCase().replace(/\.$/, "");
    if (!isValidSite(h)) return null;
    if (IPV4.test(h) || !h.includes(".")) return h;
    const labels = h.split(".");
    const n = labels.length;
    const keep = n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL.has(labels[n - 2]) ? 3 : 2;
    return labels.slice(-keep).join(".");
  }

  function patternsForSite(site) {
    return IPV4.test(site) || !site.includes(".") ? [`*://${site}/*`] : [`*://*.${site}/*`];
  }

  function clampLevel(v) {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  function levelFor(domains, host) {
    const site = siteOf(host);
    if (site === null || !domains || !Object.prototype.hasOwnProperty.call(domains, site)) return null;
    return clampLevel(domains[site]);
  }

  function hostToSite(key) {
    // "null" is how opaque origins are serialised; it is never a real site.
    if (key === "null") return null;
    try {
      return siteOf(new URL(`http://${key}`).hostname);
    } catch {
      return null;
    }
  }

  function normaliseImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid JSON");
    const domains = {};
    const dropped = [];
    for (const [key, value] of Object.entries(data)) {
      const raw = value && typeof value === "object" ? value.volume : value;
      const level = typeof raw === "number" || typeof raw === "string" ? clampLevel(raw) : null;
      const site = hostToSite(key);
      if (site === null || level === null) dropped.push(key);
      else domains[site] = level;
    }
    return { domains, dropped };
  }

  function isRestrictedUrl(url) {
    if (typeof url !== "string" || url === "") return true;
    const lower = url.toLowerCase();
    return RESTRICTED_SCHEMES.some((s) => lower.startsWith(s)) || RESTRICTED_PREFIXES.some((p) => lower.startsWith(p));
  }

  function classifyTab(url, pingOk) {
    if (isRestrictedUrl(url)) return "restricted";
    return pingOk ? "ok" : "needs-reload";
  }

  const api = { siteOf, isValidSite, patternsForSite, clampLevel, levelFor, normaliseImport, isRestrictedUrl, classifyTab };
  globalThis.TabVolume = Object.assign(globalThis.TabVolume || {}, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
