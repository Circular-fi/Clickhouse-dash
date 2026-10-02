// Live event-listener counter for leak tests. installListenerTracker() wraps
// EventTarget.prototype.addEventListener / removeEventListener before any page
// script runs and keeps one entry per live (target, type, capture, listener):
// a removeEventListener, an aborted { signal } or a fired { once } drops it, a
// duplicate add is a no-op (as in the DOM). listenerStats() counts the
// entries whose target is window or document ("global": they outlive every
// view) and those whose target is an element still in the document
// ("connected"); listeners on detached nodes die with them and are not counted.

export async function installListenerTracker(page) {
  await page.addInitScript(() => {
    if (window.__listenerStats) return;
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
    proto.addEventListener = function (type, fn, opts) {
      add.call(this, type, fn, opts);
      if (!fn) return;
      const signal = opts && typeof opts === 'object' ? opts.signal : null;
      if (signal && signal.aborted) return;
      const capture = captureOf(opts);
      const fns = slot(this, type, capture);
      if (fns.has(fn)) return;
      const entry = { ref: new WeakRef(this), type, global: this === window || this === document };
      const drop = () => { if (fns.get(fn) === entry) { fns.delete(fn); live.delete(entry); } };
      entry.drop = drop;
      fns.set(fn, entry);
      live.add(entry);
      if (signal) add.call(signal, 'abort', drop, { once: true });
      if (opts && typeof opts === 'object' && opts.once) add.call(this, type, drop, { once: true, capture });
    };
    proto.removeEventListener = function (type, fn, opts) {
      remove.call(this, type, fn, opts);
      const types = byTarget.get(this);
      const entry = types?.get(`${type}|${captureOf(opts)}`)?.get(fn);
      if (entry) entry.drop();
    };
    window.__listenerStats = (detail = false) => {
      const out = { global: 0, connected: 0, types: {}, nodes: {} };
      for (const entry of [...live]) {
        const target = entry.ref.deref();
        if (!target) { live.delete(entry); continue; }
        if (entry.global) {
          out.global += 1;
          const name = `${target === window ? 'window' : 'document'}:${entry.type}`;
          out.types[name] = (out.types[name] || 0) + 1;
        } else if (target.isConnected) {
          out.connected += 1;
          if (detail) {
            const name = `${target.nodeName || 'node'}${target.id ? `#${target.id}` : ''}${target.classList?.[0] ? `.${target.classList[0]}` : ''}:${entry.type}`;
            out.nodes[name] = (out.nodes[name] || 0) + 1;
          }
        }
      }
      return out;
    };
  });
}

export function listenerStats(page, detail = false) {
  return page.evaluate((d) => window.__listenerStats(d), detail);
}

// The node:type keys whose count changed between two detailed stats.
export function listenerDiff(before, after) {
  const out = {};
  for (const key of new Set([...Object.keys(before.nodes || {}), ...Object.keys(after.nodes || {})])) {
    const delta = (after.nodes?.[key] || 0) - (before.nodes?.[key] || 0);
    if (delta) out[key] = delta;
  }
  return out;
}
