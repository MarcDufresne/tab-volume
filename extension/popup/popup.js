(async () => {
  const { siteOf, clampLevel, classifyTab, normaliseImport } = globalThis.TabVolume;
  const $ = (id) => document.getElementById(id);
  const PING_TIMEOUT_MS = 300;
  const STATUS = {
    restricted: "Tab Volume can't control this page.",
    "needs-reload": "Reload this tab to control its volume.",
    "not-applied": "Volume not applied yet. Reload this tab.",
  };

  const slider = $("level-slider");
  const number = $("level-number");
  const remember = $("remember");

  function siteOfUrl(url) {
    try {
      return siteOf(new URL(url).hostname);
    } catch {
      return null;
    }
  }

  async function loadDomains() {
    const { domains } = await chrome.storage.local.get("domains");
    return domains && typeof domains === "object" ? { ...domains } : {};
  }

  const saveDomains = (domains) => chrome.storage.local.set({ domains });

  async function activeTab() {
    try {
      const param = new URLSearchParams(location.search).get("tabId");
      if (param) return await chrome.tabs.get(Number(param));
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch {
      return null;
    }
  }

  async function ping(tabId) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PING_TIMEOUT_MS));
    const reply = chrome.tabs.sendMessage(tabId, { type: "tv:ping" }, { frameId: 0 }).catch(() => null);
    return Promise.race([reply, timeout]);
  }

  const tab = await activeTab();
  const site = tab ? siteOfUrl(tab.url) : null;
  let domains = await loadDomains();
  const reply = tab ? await ping(tab.id) : null;

  let state = classifyTab(tab && tab.url, Boolean(reply));
  if (state !== "restricted" && !site) state = "restricted";
  if (state === "ok" && !reply.applied) state = "not-applied";

  const isSaved = () => site !== null && Object.prototype.hasOwnProperty.call(domains, site);

  function showLevel(level, source) {
    if (source !== slider) slider.value = String(level);
    if (source !== number) number.value = String(level);
  }

  function currentLevel() {
    if (isSaved()) return clampLevel(domains[site]);
    return reply && reply.level !== null && reply.level !== undefined ? reply.level : 100;
  }

  async function setLevel(raw, source) {
    const level = clampLevel(raw);
    if (level === null || !site) return;
    showLevel(level, source);
    if (isSaved()) {
      domains[site] = level;
      await saveDomains(domains);
    } else {
      await chrome.runtime.sendMessage({ type: "tv:setTabLevel", tabId: tab.id, level });
    }
  }

  async function setRemember(on) {
    const level = clampLevel(number.value) ?? 100;
    if (on) {
      domains[site] = level;
      await saveDomains(domains);
      await chrome.runtime.sendMessage({ type: "tv:clearTabLevel", tabId: tab.id });
    } else {
      await chrome.runtime.sendMessage({ type: "tv:clearTabLevel", tabId: tab.id });
      delete domains[site];
      await saveDomains(domains);
      showLevel(100);
    }
  }

  function renderSaved() {
    const list = $("saved");
    const sites = Object.keys(domains).sort();
    const existing = new Map([...list.children].map((li) => [li.dataset.site, li]));
    for (const [s, li] of existing) if (!sites.includes(s)) li.remove();
    sites.forEach((s, i) => {
      let li = existing.get(s);
      if (!li) {
        li = document.createElement("li");
        li.dataset.site = s;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = s;
        name.title = s;
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.max = "100";
        input.step = "1";
        input.setAttribute("aria-label", `Volume for ${s}`);
        input.addEventListener("input", async () => {
          const level = clampLevel(input.value);
          if (level === null) return;
          domains[s] = level;
          await saveDomains(domains);
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Forget ${s}`);
        remove.addEventListener("click", async () => {
          delete domains[s];
          await saveDomains(domains);
        });
        li.append(name, input, remove);
      }
      const input = li.querySelector("input");
      if (document.activeElement !== input) input.value = String(domains[s]);
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    });
    $("saved-empty").hidden = sites.length > 0;
  }

  function renderTab(focused) {
    $("site").textContent = site || "Tab Volume";
    $("remember-label").textContent = site ? `Remember for ${site}` : "Remember for this site";
    remember.checked = isSaved();
    showLevel(currentLevel(), focused);
  }

  const disabled = state === "restricted";
  for (const el of [slider, number, remember]) el.disabled = disabled;
  $("status").textContent = STATUS[state] || "";
  $("status").hidden = !STATUS[state];
  $("reload").hidden = state !== "needs-reload" && state !== "not-applied";

  renderTab();
  renderSaved();

  slider.addEventListener("input", () => setLevel(slider.value, slider));
  number.addEventListener("input", () => setLevel(number.value, number));
  remember.addEventListener("change", () => setRemember(remember.checked));

  $("reload").addEventListener("click", async () => {
    await chrome.tabs.reload(tab.id);
    window.close();
  });

  $("import-btn").addEventListener("click", async () => {
    const result = $("import-result");
    let imported;
    try {
      imported = normaliseImport($("import-text").value);
    } catch {
      result.textContent = "That isn't valid JSON.";
      return;
    }
    const count = Object.keys(imported.domains).length;
    domains = { ...domains, ...imported.domains };
    await saveDomains(domains);
    const skipped = imported.dropped.length ? `: ${imported.dropped.join(", ")}` : "";
    result.textContent = `Imported ${count}, skipped ${imported.dropped.length}${skipped}`;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.domains) return;
    const next = changes.domains.newValue;
    domains = next && typeof next === "object" ? { ...next } : {};
    renderSaved();
    renderTab(document.activeElement);
  });

  document.body.dataset.state = state;
})();
