// Live counters for leak tests.
// installLeakTracker() wraps everything that a view binds and has to release. It does this before any page script runs:
//
// - event listeners (EventTarget.prototype.addEventListener / removeEventListener): one entry for each live (target, type,
//   capture, listener). A removeEventListener call, an aborted { signal } or a fired { once } drops the entry.
//   A duplicate add is a no-op, as in the DOM.
//
//   The counts are "global", "connected" and "media".
//   "global" means the target is window or document: they outlive every view.
//   "connected" means an element still in the document: the listeners of a detached node die with it.
//   "media" means a MediaQueryList, which the document keeps alive while it has a listener);
//
// - ResizeObserver, IntersectionObserver and MutationObserver: one entry for each live (observer, target).
//   unobserve() and disconnect() drop the entry.
//   The count is by observer type when the target is connected;
//
// - setInterval timers not cleared yet;
//
// - Worker, EventSource and BroadcastChannel objects not terminated or closed yet.
//
// leakStats(page, true) reads them. leakDiff(before, after) names what grew between two readings.
// A test runs a cycle once (everything built) and reads the counts.
// It then runs the cycle N times, reads again, and expects leakDiff(...) to be {}.
//
// installLeakTracker is idempotent.
// The window of a Worker is not visible to it. Only the page is tracked.

export async function installLeakTracker(page) {
  await page.addInitScript(() => {
    if (window.__leakStats) return;
    const proto = EventTarget.prototype;
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    const live = new Set();
    const byTarget = new WeakMap();
    const captureOf = (opts) => (typeof opts === 'boolean' ? opts : !!(opts && opts.capture));
    const slot = (target, type, capture) => {
      let types = byTarget.get(target);
      if (!types) { types = new Map(); byTarget.set(target, types); }
      const key = `${type}|${capture}`;
      let fns = types.get(key);
      if (!fns) { fns = new Map(); types.set(key, fns); }
      return fns;
    };
    const kindOf = (target) => {
      if (target === window || target === document) return 'global';
      if (target instanceof Node) return 'node';
      if (typeof MediaQueryList !== 'undefined' && target instanceof MediaQueryList) return 'media';
      return '';
    };
    proto.addEventListener = function (type, fn, opts) {
      add.call(this, type, fn, opts);
      if (!fn) return;
      const kind = kindOf(this);
      if (!kind) return;
      const signal = opts && typeof opts === 'object' ? opts.signal : null;
      if (signal && signal.aborted) return;
      const capture = captureOf(opts);
      const fns = slot(this, type, capture);
      if (fns.has(fn)) return;
      const entry = { ref: new WeakRef(this), type, kind };
      const drop = () => { if (fns.get(fn) === entry) { fns.delete(fn); live.delete(entry); } };
      fns.set(fn, entry);
      live.add(entry);
      if (signal) add.call(signal, 'abort', drop, { once: true });
      if (opts && typeof opts === 'object' && opts.once) add.call(this, type, drop, { once: true, capture });
      entry.drop = drop;
    };
    proto.removeEventListener = function (type, fn, opts) {
      remove.call(this, type, fn, opts);
      const types = byTarget.get(this);
      const entry = types?.get(`${type}|${captureOf(opts)}`)?.get(fn);
      if (entry) entry.drop();
    };

        // Observers: observer -> Map(WeakRef(target), keyed by target) of live observations.
    const observations = new Map();
    for (const name of ['ResizeObserver', 'IntersectionObserver', 'MutationObserver']) {
      const Ctor = window[name];
      if (!Ctor) continue;
      const { observe, unobserve, disconnect } = Ctor.prototype;
      Ctor.prototype.observe = function (target, ...rest) {
                // A MutationObserver can observe the same node with new options. Each target has one observation.
        let targets = observations.get(this);
        if (!targets) { targets = { type: name, refs: new Map() }; observations.set(this, targets); }
        if (!targets.refs.has(target)) targets.refs.set(target, new WeakRef(target));
        return observe.call(this, target, ...rest);
      };
      Ctor.prototype.unobserve = function (target) {
        observations.get(this)?.refs.delete(target);
        return unobserve.call(this, target);
      };
      Ctor.prototype.disconnect = function () {
        observations.delete(this);
        return disconnect.call(this);
      };
    }

    // Timers.
    const intervals = new Map();
    const setIntervalOriginal = window.setInterval;
    const clearIntervalOriginal = window.clearInterval;
    window.setInterval = function (fn, ...rest) {
      const id = setIntervalOriginal.call(window, fn, ...rest);
      intervals.set(id, typeof fn === 'function' ? (fn.name || String(fn).replace(/\s+/g, ' ').slice(0, 80)) : 'string');
      return id;
    };
    window.clearInterval = function (id) {
      intervals.delete(id);
      return clearIntervalOriginal.call(window, id);
    };

    // Channels: a Worker is live until terminate(), an EventSource and a BroadcastChannel until close().
    const channels = new Set();
    const track = (Base, name, closer) => {
      if (!Base) return;
      const original = Base.prototype[closer];
      Base.prototype[closer] = function (...args) { channels.delete(this); return original.apply(this, args); };
      const Wrapped = class extends Base { constructor(...args) { super(...args); channels.add(this); this.__leakName = name; } };
      Object.defineProperty(Wrapped, 'name', { value: name });
      window[name] = Wrapped;
    };
    track(window.Worker, 'Worker', 'terminate');
    track(window.EventSource, 'EventSource', 'close');
    track(window.BroadcastChannel, 'BroadcastChannel', 'close');

    window.__leakStats = (detail = false) => {
      const out = { global: 0, connected: 0, media: 0, types: {}, nodes: {}, observers: {}, intervals: {}, channels: {} };
      for (const entry of [...live]) {
        const target = entry.ref.deref();
        if (!target) { live.delete(entry); continue; }
        if (entry.kind === 'global') {
          out.global += 1;
          const name = `${target === window ? 'window' : 'document'}:${entry.type}`;
          out.types[name] = (out.types[name] || 0) + 1;
        } else if (entry.kind === 'media') {
          out.media += 1;
          out.types[`media:${entry.type}`] = (out.types[`media:${entry.type}`] || 0) + 1;
        } else if (target.isConnected) {
          out.connected += 1;
          if (detail) {
            const name = `${target.nodeName || 'node'}${target.id ? `#${target.id}` : ''}${target.classList?.[0] ? `.${target.classList[0]}` : ''}:${entry.type}`;
            out.nodes[name] = (out.nodes[name] || 0) + 1;
          }
        }
      }
      for (const { type, refs } of observations.values()) {
        for (const ref of refs.values()) {
          const target = ref.deref();
          if (target && (target.isConnected || target === document)) out.observers[type] = (out.observers[type] || 0) + 1;
        }
      }
      for (const name of intervals.values()) out.intervals[name] = (out.intervals[name] || 0) + 1;
      for (const channel of channels) out.channels[channel.__leakName] = (out.channels[channel.__leakName] || 0) + 1;
      return out;
    };
  });
}

export function leakStats(page, detail = false) {
  return page.evaluate((d) => window.__leakStats(d), detail);
}

// What grew between two detailed readings: "<group>:<name>" -> the increase of the count.
// Only an increase is a leak.
// A worker that ended, or a listener that went away between the two readings, shows that the page released what it held.
// The Worker of the kernels ends when it has been idle for a while.
// Listeners are named by node and event (node:), by event on window or document (global:), and on a media query (types).
export function leakDiff(before, after) {
  const out = {};
  const groups = { node: 'nodes', global: 'types', observer: 'observers', interval: 'intervals', channel: 'channels' };
  for (const [prefix, field] of Object.entries(groups)) {
    for (const key of new Set([...Object.keys(before[field] || {}), ...Object.keys(after[field] || {})])) {
      const delta = (after[field]?.[key] || 0) - (before[field]?.[key] || 0);
      if (delta > 0) out[`${prefix}:${key}`] = delta;
    }
  }
  return out;
}

// A one-line summary of a reading, for a test log.
export function leakSummary(stats) {
  const sum = (counts) => Object.values(counts || {}).reduce((total, n) => total + n, 0);
  return `${stats.global} global / ${stats.connected} connected / ${stats.media} media listeners, ${sum(stats.observers)} observations, ${sum(stats.intervals)} intervals, ${sum(stats.channels)} channels`;
}
