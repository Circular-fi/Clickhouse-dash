// What the three Observability views (Traces, Logs, Metrics) and the trace page share, once (ARCH-F-158): the selected
// host, and the cycle of a view with its host. A view gives hostCycle() what is specific to it (the model to empty, the
// slots of util.latest to cancel, the loading) and gets the rest the same way in each page:
//
//   - a change of host stops everything of the old host at once (util.latest.cancelPrefix of the view's slots), empties
//     the model, and loads for the new host; an answer of the old host never reaches the screen (load() gets stale());
//   - the host change and the feature flags often arrive together (the first load): both ask for a reload, which runs
//     once per host;
//   - the first load runs when the host is known, and when the feature flags turn the view on after the page started.
//
//   const cycle = obsView.hostCycle({ feature: "logs", cancel: ["logs.", "facets."], reset, load, loaded });
//   cycle.start();     // in init(): binds chdash:host-changed and the feature flags, and loads when a host is selected
//   cycle.reload();    // Retry: the same cycle (a reload of the same host that is loading joins it)
//
// Every read of a view goes through read(slot), the one guard of a stale answer (ARCH-F-158):
//
//   const req = obsView.read("logs.search");
//   const payload = await api.getLogs("search", params, { signal: req.signal });
//   if (!req.isCurrent()) return;     // a newer read of the slot, a cancel, or another host: the answer is dropped
//
// reset() runs first, synchronously: it empties the model of the old host. load(stale) is async: stale() is true once the
// host differs from the one of this load. loaded() tells whether the view has data of a host (default: a load started);
// the feature flags start a load only when it is false.

import { features, state } from "./app_state.js";
import { util } from "./app_util.js";

const currentHost = () => String(state.selectedHostId || "");

// The read of a slot of util.latest (a newer read of the slot, or a cancel of it, aborts this one and makes it stale) that is also stale once
// the selected host is not the host it began with, whatever slot prefixes the view's host cycle cancels.
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
    // Everything of the old host stops now; a second change replaces this reload instead of racing it.
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
