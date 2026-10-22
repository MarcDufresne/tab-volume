(() => {
  const domain = typeof module === "object" && module.exports ? require("./domain.js") : globalThis.TabVolume;

  const COMMON = { runAt: "document_start", allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true };

  function buildRegistrations(sites) {
    const patterns = sites.filter(domain.isValidSite).flatMap(domain.patternsForSite);
    const page = { id: "tv-page", matches: ["<all_urls>"], js: ["content/page.js"], world: "MAIN", ...COMMON };
    if (patterns.length) page.excludeMatches = patterns;
    const regs = [
      { id: "tv-bridge", matches: ["<all_urls>"], js: ["lib/domain.js", "content/bridge.js"], world: "ISOLATED", ...COMMON },
      page,
    ];
    if (patterns.length) {
      regs.push({ id: "tv-page-saved", matches: patterns, js: ["content/start-muted.js", "content/page.js"], world: "MAIN", ...COMMON });
    }
    return regs;
  }

  const api = { buildRegistrations };
  globalThis.TabVolume = Object.assign(globalThis.TabVolume || {}, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})();
