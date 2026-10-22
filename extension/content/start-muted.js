(() => {
  Object.defineProperty(window, Symbol.for("tabvolume.startMuted"), { value: true, configurable: true });
  // page.js may already be installed (overlapping registrations on about:blank/blob: frames), so tell it too.
  window.dispatchEvent(new Event("tabvolume:start-muted"));
})();
