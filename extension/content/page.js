(() => {
  const INSTALLED = Symbol.for("tabvolume.installed");
  const START_MUTED = Symbol.for("tabvolume.startMuted");
  if (window[INSTALLED]) return;
  Object.defineProperty(window, INSTALLED, { value: true });

  const mediaProto = HTMLMediaElement.prototype;
  const volumeDesc = Object.getOwnPropertyDescriptor(mediaProto, "volume");
  const nativeGet = volumeDesc.get;
  const nativeSet = volumeDesc.set;
  const nativePlay = mediaProto.play;
  const nativeAttachShadow = Element.prototype.attachShadow;
  const nodeProto = AudioNode.prototype;
  const nativeConnect = nodeProto.connect;
  const nativeDisconnect = nodeProto.disconnect;
  const nativeCreateMES = AudioContext.prototype.createMediaElementSource;
  const GainNodeCtor = GainNode;
  const MEDIA_EVENTS = ["play", "playing", "loadstart"];

  let factor = window[START_MUTED] ? 0 : 1;
  let received = false;

  const pageVolume = new WeakMap();
  const expectedNative = new WeakMap();
  const knownElements = new Set();
  // Chromium applies element.volume to a MediaElementAudioSourceNode's output, so an element
  // routed into Web Audio keeps its page volume and the destination gain applies the level once.
  const routedToWebAudio = new WeakSet();
  const destinationGains = new WeakMap();
  const knownGains = new Set();

  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function apply(el) {
    const target = routedToWebAudio.has(el) ? pageVolume.get(el) : clamp01(pageVolume.get(el) * factor);
    expectedNative.set(el, target);
    if (nativeGet.call(el) !== target) nativeSet.call(el, target);
  }

  function track(el) {
    if (pageVolume.has(el)) return;
    pageVolume.set(el, nativeGet.call(el));
    knownElements.add(new WeakRef(el));
    apply(el);
  }

  function rescaleAll() {
    for (const ref of knownElements) {
      const el = ref.deref();
      if (el) apply(el);
      else knownElements.delete(ref);
    }
    for (const ref of knownGains) {
      const gain = ref.deref();
      if (gain) gain.gain.value = factor;
      else knownGains.delete(ref);
    }
  }

  function trackTree(node) {
    if (node instanceof HTMLMediaElement) track(node);
    if (node.querySelectorAll) for (const el of node.querySelectorAll("audio, video")) track(el);
  }

  function reconcile(el) {
    if (!pageVolume.has(el)) return track(el);
    const native = nativeGet.call(el);
    if (native === expectedNative.get(el)) return;
    if (routedToWebAudio.has(el)) {
      pageVolume.set(el, native);
      return apply(el);
    }
    if (factor === 0) return apply(el);
    pageVolume.set(el, clamp01(native / factor));
    expectedNative.set(el, native);
  }

  function onMediaEvent(e) {
    if (e.target instanceof HTMLMediaElement) track(e.target);
  }

  function onVolumeChange(e) {
    if (e.target instanceof HTMLMediaElement) reconcile(e.target);
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) trackTree(n);
  });

  function watch(root) {
    observer.observe(root, { childList: true, subtree: true });
    for (const type of MEDIA_EVENTS) root.addEventListener(type, onMediaEvent, true);
    root.addEventListener("volumechange", onVolumeChange, true);
    trackTree(root);
  }

  Object.defineProperty(mediaProto, "volume", {
    configurable: true,
    enumerable: volumeDesc.enumerable,
    get() {
      track(this);
      return pageVolume.get(this);
    },
    set(value) {
      const v = Number(value);
      if (!Number.isFinite(v)) throw new TypeError("Failed to set the 'volume' property on 'HTMLMediaElement': The provided double value is non-finite.");
      if (v < 0 || v > 1) throw new DOMException(`Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${v}) is outside the range [0, 1].`, "IndexSizeError");
      track(this);
      pageVolume.set(this, v);
      apply(this);
    },
  });

  mediaProto.play = function play() {
    track(this);
    return nativePlay.apply(this, arguments);
  };

  Element.prototype.attachShadow = function attachShadow() {
    const root = nativeAttachShadow.apply(this, arguments);
    watch(root);
    return root;
  };

  AudioContext.prototype.createMediaElementSource = function createMediaElementSource(el) {
    const node = nativeCreateMES.apply(this, arguments);
    if (el instanceof HTMLMediaElement) {
      track(el);
      routedToWebAudio.add(el);
      apply(el);
    }
    return node;
  };

  function gainFor(destination) {
    if (!(destination instanceof AudioDestinationNode)) return null;
    if (!(destination.context instanceof AudioContext)) return null;
    let gain = destinationGains.get(destination);
    if (!gain) {
      gain = new GainNodeCtor(destination.context, { gain: factor });
      nativeConnect.call(gain, destination);
      destinationGains.set(destination, gain);
      knownGains.add(new WeakRef(gain));
    }
    return gain;
  }

  nodeProto.connect = function connect(target, ...rest) {
    const gain = gainFor(target);
    if (!gain) return nativeConnect.call(this, target, ...rest);
    nativeConnect.call(this, gain, ...rest);
    return target;
  };

  nodeProto.disconnect = function disconnect(...args) {
    if (args.length && destinationGains.has(args[0])) args[0] = destinationGains.get(args[0]);
    return nativeDisconnect.apply(this, args);
  };

  window.addEventListener("tabvolume:level", (e) => {
    const level = Number(e.detail);
    if (!Number.isFinite(level)) return;
    factor = clamp01(level / 100);
    received = true;
    rescaleAll();
  });

  window.addEventListener("tabvolume:start-muted", () => {
    if (received) return;
    factor = 0;
    rescaleAll();
  });

  const announce = () => window.dispatchEvent(new Event("tabvolume:ready"));
  window.addEventListener("tabvolume:hello", announce);

  watch(document);
  announce();
})();
