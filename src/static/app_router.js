// ns.router: the only owner of the address bar and the session history.
// No other module calls history.pushState / replaceState / back / go.
// No other module listens to popstate (tests/harness/test_ui_router_contract.py).
//
//   router.base() -> "" or the app's base path ("/chdash")
//   router.url(path) -> base + app path ("/explorer" -> "/chdash/explorer")
//   router.path(pathname?) -> the app path of a location ("/explorer/db")
//   router.current() -> { path, params, hash, state } (params: a copy)
//   router.href() -> pathname + search + hash of the current entry
//   router.state() -> the entry's state ({ chdash: 1, view, ...owner state })
//
//   router.push(update, opts) / router.replace(update, opts) -> written?
//     update: { name: value | [values] | null } merged into the params.
//             null, "" and [] drop the parameter. The update can also be a URLSearchParams or a
//             query string (the whole query), or fn(params) that changes a copy.
//     opts:   path  the app path to write (default: the current one)
//             params the params the update applies to (default: current)
//             href  a whole address (pathname?search#hash) instead
//             hash  the hash (the hash stays while the path stays the same)
//             view  the view the entry belongs to (state.view)
//             state the owner's own entry state (a key set to undefined
//                   is removed on replace)
//     A push to the current address replaces the entry. A write that
//     changes neither the address nor the state does nothing.
//   router.write(mode, update, opts): mode "push" | "replace" | "none"
//   router.back(steps = 1)
//
//   router.on(match, handler(route, event)) -> off()
//     Back / Forward: every handler whose match accepts the new entry runs.
//     The handlers run in registration order. The match is one of three kinds:
//     an app path prefix ("/observability" matches it and what is under it; "" matches every path),
//     a RegExp tested on the path, or fn(route). One popstate listener serves all handlers.
//
//   router.owner(name, { view, path, params }) -> handle (one per name)
//     view: the ns.lifecycle scope that must be visible for the owner to write.
//       The default is name. The value can also be a predicate, or null (always).
//     path / params: the owner's address and its full params (fn). They are the
//       base of every write.
//     handle.active(), handle.push(update?, opts), handle.replace(...),
//     handle.write(mode, update?, opts), handle.panel(param)
//     A hidden owner does not write. The calls return false.
//
//   router.panel(name, { owner }) -> the URL parameter of a detail panel
//     get()        the value in the address ("" when there is none)
//     open(value)  pushes an entry. It replaces the entry when another value is open.
//     move(value)  replaces the entry. Use it for next and previous inside the open panel.
//     close()      goes Back when the entry is the panel's own (pushed by open
//                  over the same address). Otherwise it replaces the entry without the parameter;
//                  it returns true when it goes Back
//     owned()      whether the entry is the panel's own
//
//   router.debug() -> { popstateListeners, routes, owners } (tests)
//
// Route vocabulary (docs/ui-foundations.md, "Routes"). The path names the page, the view and the entity.
// The ?tab= parameter names the sub-view of what the path shows.
// The ?mode= parameter names the presentation of the same scope.
// Each detail panel uses one parameter.
// Former names are read-only aliases. The router rewrites them with replace on load.

import { lifecycle } from "./app_ui_layers.js";

const loc = () => window.location;

function base() {
  const raw = String(window.__CHDASH_BASE_PATH__ || "/");
  return raw === "/" ? "" : raw.replace(/\/+$/, "");
}

function url(path) {
  const raw = String(path || "/");
  return `${base()}${raw.startsWith("/") ? raw : `/${raw}`}` || "/";
}

function path(pathname = loc().pathname) {
  let value = String(pathname || "/");
  const prefix = base();
  if (prefix && (value === prefix || value.startsWith(`${prefix}/`))) value = value.slice(prefix.length) || "/";
  return value;
}

function state() {
  const value = window.history.state;
  return value && typeof value === "object" ? value : {};
}

function href() {
  const l = loc();
  return `${l.pathname}${l.search}${l.hash}`;
}

function current() {
  const l = loc();
  return { path: path(l.pathname), params: new URLSearchParams(l.search), hash: l.hash, state: state() };
}

const isEmpty = (value) => value == null || value === "" || value === false;

function applyUpdate(params, update) {
  if (update == null) return params;
  if (typeof update === "function") {
    const out = update(params);
    return out instanceof URLSearchParams ? out : params;
  }
  if (update instanceof URLSearchParams || typeof update === "string") return new URLSearchParams(update);
  for (const [key, value] of Object.entries(update)) {
    params.delete(key);
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!isEmpty(item)) params.append(key, String(item));
    }
  }
  return params;
}

function sameState(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function clean(value) {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}

// The address that a write produces: [pathname, search, hash].
function target(update, opts) {
  const l = loc();
  let pathname = l.pathname;
  let params = new URLSearchParams(l.search);
  let hash = l.hash;
  if (opts.href != null) {
    const next = new URL(String(opts.href), l.href);
    pathname = next.pathname;
    params = next.searchParams;
    hash = next.hash;
  }
  if (opts.path != null) {
    const next = url(opts.path);
    if (next !== pathname) hash = "";
    pathname = next;
  }
  if (opts.params != null) params = new URLSearchParams(typeof opts.params === "function" ? opts.params() : opts.params);
  if (opts.hash != null) hash = String(opts.hash);
  params = applyUpdate(params, update);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

function write(mode, update, opts = {}) {
  if (mode !== "push" && mode !== "replace") return false;
  const next = target(update, opts || {});
  const before = href();
  const prev = state();
  const view = opts.view || prev.view || "";
  if (mode === "push" && next !== before) {
    window.history.pushState(clean({ chdash: 1, view, ...(opts.state || {}) }), "", next);
    return true;
  }
  const merged = clean({ ...prev, chdash: 1, view, ...(opts.state || {}) });
  if (next === before && sameState(prev, merged)) return false;
  window.history.replaceState(merged, "", next);
  return true;
}

const push = (update, opts) => write("push", update, opts);
const replace = (update, opts) => write("replace", update, opts);

function back(steps = 1) {
  const n = Math.max(1, Math.trunc(Number(steps) || 1));
  if (n === 1) window.history.back();
  else window.history.go(-n);
}

// ------------------------------------------------------------ popstate

const routes = [];

function matcher(match) {
  if (typeof match === "function") return match;
  if (match instanceof RegExp) return (route) => match.test(route.path);
  const prefix = String(match || "").replace(/\/+$/, "");
  if (!prefix) return () => true;
  return (route) => route.path === prefix || route.path.startsWith(`${prefix}/`);
}

function on(match, handler) {
  if (typeof handler !== "function") return () => {};
  const entry = { test: matcher(match), handler };
  routes.push(entry);
  return () => {
    const at = routes.indexOf(entry);
    if (at >= 0) routes.splice(at, 1);
  };
}

let listeners = 0;
function onPopState(event) {
  const route = current();
  for (const entry of [...routes]) {
    if (!routes.includes(entry)) continue;
    let hit = false;
    try { hit = !!entry.test(route); } catch (error) { console.error(error); }
    if (!hit) continue;
    try { entry.handler(route, event); } catch (error) { console.error(error); }
  }
}
window.addEventListener("popstate", onPopState);
listeners += 1;

// --------------------------------------------------------------- owners

const owners = new Map();

function makeOwner(name) {
  const config = { view: name, path: null, params: null };
  const active = () => {
    const view = config.view;
    if (view == null) return true;
    if (typeof view === "function") return !!view();
    const life = lifecycle;
    return !life || !!life.current(String(view));
  };
  const options = (opts = {}) => {
    const out = { ...opts };
    if (!out.view) out.view = typeof config.view === "string" ? config.view : name;
    if (out.href == null) {
      if (out.path == null && config.path != null) out.path = typeof config.path === "function" ? config.path() : config.path;
      if (out.params == null && config.params) out.params = config.params();
    }
    return out;
  };
  const handle = {
    name,
    active,
    write(mode, update = null, opts = {}) {
      if (mode === "none" || !active()) return false;
      return write(mode, update, options(opts));
    },
    push(update = null, opts = {}) { return handle.write("push", update, opts); },
    replace(update = null, opts = {}) { return handle.write("replace", update, opts); },
    panel(param) { return panel(param, { owner: handle }); },
  };
  return {
    handle: Object.freeze(handle),
    configure(next) {
      if (Object.prototype.hasOwnProperty.call(next, "view")) config.view = next.view;
      if (Object.prototype.hasOwnProperty.call(next, "path")) config.path = next.path;
      if (Object.prototype.hasOwnProperty.call(next, "params")) config.params = typeof next.params === "function" ? next.params : null;
    },
    config,
  };
}

function owner(name, opts = null) {
  const key = String(name || "");
  let entry = owners.get(key);
  if (!entry) {
    entry = makeOwner(key);
    owners.set(key, entry);
  }
  if (opts) entry.configure(opts);
  return entry.handle;
}

// --------------------------------------------------------------- panels

function panel(name, { owner: own = null } = {}) {
  const param = String(name);
  const marker = `detail:${param}`;
  const writable = () => !own || own.active();
  const view = () => (own ? { view: own.name } : {});
  // The address without the panel's parameter. open() records this address.
  // close() goes Back only when the entry still has this address. Nothing else must have changed.
  const under = () => {
    const params = new URLSearchParams(loc().search);
    params.delete(param);
    params.sort();
    return `${loc().pathname}?${params.toString()}`;
  };
  const api = {
    name: param,
    get(search = loc().search) {
      return new URLSearchParams(search).get(param) || "";
    },
    owned() {
      const entry = state();
      return entry.detail === marker && entry.detailOf === under();
    },
    open(value) {
      const next = String(value ?? "");
      if (!next) return api.close();
      if (api.get() === next || !writable()) return false;
      if (api.get()) return replace({ [param]: next }, view());
      const of = under();
      return push({ [param]: next }, { ...view(), state: { detail: marker, detailOf: of } });
    },
    move(value) {
      const next = String(value ?? "");
      if (api.get() === next || !writable()) return false;
      return replace({ [param]: next || null }, view());
    },
    close() {
      if (!api.get() || !writable()) return false;
      if (api.owned()) {
        back();
        return true;
      }
      replace({ [param]: null }, { ...view(), state: { detail: undefined, detailOf: undefined } });
      return false;
    },
  };
  return Object.freeze(api);
}

function debug() {
  return { popstateListeners: listeners, routes: routes.length, owners: [...owners.keys()] };
}

export const router = Object.freeze({ base, url, path, href, current, state, push, replace, write, back, on, owner, panel, debug });
