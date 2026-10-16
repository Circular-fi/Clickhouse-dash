// This module holds what the three Observability views (Traces, Logs, Metrics) and the trace page share (ARCH-F-158).
// It holds the selected host and the cycle of a view with its host. A view gives hostCycle() its specific parts: the model to empty, the slots of util.latest to cancel, and the loading.
// Each page gets the rest in the same way:
//
//   - A change of host stops all work of the old host at once (util.latest.cancelPrefix of the view's slots). It empties the model and loads the data of the new host.
//     An answer of the old host never reaches the screen, because load() gets stale().
//   - The host change and the feature flags often arrive together at the first load. Both ask for a reload. The reload runs once per host.
//   - The first load runs when the host is known. It also runs when the feature flags turn the view on after the page starts.
//
//   const cycle = obsView.hostCycle({ feature: "logs", cancel: ["logs.", "facets."], reset, load, loaded });
//   cycle.start();     // in init(): bind chdash:host-changed and the feature flags, and load when a host is selected
//   cycle.reload();    // Retry: the same cycle. A reload of the same host joins the load that runs
//
// Each read of a view goes through read(slot). This is the only guard against a stale answer (ARCH-F-158):
//
//   const req = obsView.read("logs.search");
//   const payload = await api.getLogs("search", params, { signal: req.signal });
//   if (!req.isCurrent()) return;     // A newer read of the slot, a cancel, or another host drops the answer
//
// reset() runs first and synchronously. It empties the model of the old host. load(stale) is async.
// stale() is true when the host differs from the host of this load. loaded() tells whether the view has data of a host (default: a load started).
// The feature flags start a load only when loaded() is false.

import { features, state } from "./app_state.js";
import { util } from "./app_util.js";

const currentHost = () => String(state.selectedHostId || "");

// A read of a slot of util.latest is also stale when the selected host differs from the host it began with.
// A newer read of the slot, or a cancel of it, aborts this read and makes it stale. This applies to every slot prefix that the host cycle of the view cancels.
function read(slot) {
  const host = currentHost();
  const req = util.latest(slot);
  return Object.freeze({ signal: req.signal, isCurrent: () => req.isCurrent() && currentHost() === host });
}

function hostCycle({ feature, cancel = [], reset = null, load, loaded = null }) {
  let started = false;
  let running = null;
  const hasData = loaded || (() => started);

  function reload() {
    const host = currentHost();
    if (running && running.host === host) return running.promise;
    started = true;
    // Stop all work of the old host now. A second change replaces this reload. It does not race it.
    for (const prefix of cancel) util.latest.cancelPrefix(prefix);
    reset?.();
    const promise = Promise.resolve(load(() => currentHost() !== host)).finally(() => {
      if (running?.promise === promise) running = null;
    });
    running = { host, promise };
    return promise;
  }

  function start() {
    window.addEventListener("chdash:host-changed", () => { void reload(); });
    features.on((flags) => {
      if (flags?.[feature]?.enabled === false) return;
      if (!hasData() && currentHost()) void reload();
    });
    if (currentHost()) void reload();
  }

  return Object.freeze({ reload, start });
}

export const obsView = Object.freeze({ currentHost, hostCycle, read });
