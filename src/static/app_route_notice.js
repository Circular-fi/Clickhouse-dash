// The notice for an address that has no page. The server answers /observability/nope, /observability/logs (a view that is disabled)
// and /system/no-such-section with a redirect to the first page that exists. The server adds the mark ?redirected_from=<the path that
// was asked for> to the redirect (server.cpp). A shared link that no longer works then says so.
// It does not open another page as if nothing happened (UI-008). boot() (app_boot.js) removes the mark from the address before the page reads its address.
// Then boot() shows the notice when the page has started. The notice is a strip between the header rows and the page.
// It has info level and role status, with Dismiss.
//
//   routeNotice.take()      -> the path that was asked for, or "" (and the parameter is gone from the address bar)
//   routeNotice.show(from)  -> shows the notice for it (nothing for "")

import { dom } from "./app_dom.js";
import { router } from "./app_router.js";
import { uiState } from "./app_ui_state.js";

const PARAM = "redirected_from";
const MAX_PATH = 120;

// The page that opens in its place, by the last path segment that the redirect reached.
const PAGES = { traces: "Traces", logs: "Logs", metrics: "Metrics", system: "The System overview" };

function take() {
  const params = router.current().params;
  if (!params.has(PARAM)) return "";
  const from = String(params.get(PARAM) || "").slice(0, MAX_PATH);
  router.replace({ [PARAM]: null });
  return from;
}

function shownPage() {
  const segments = router.current().path.split("/").filter(Boolean);
  return PAGES[segments[segments.length - 1]] || "The first page";
}

function show(from) {
  const path = String(from || "");
  const main = dom.$("main");
  if (!path || !main) return null;
  let strip = dom.byId("routeNotice");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "routeNotice";
    main.before(strip);
  }
  const message = `${path} is not a page of this server. ${shownPage()} is shown instead.`;
  uiState.banner(strip, { message, level: "info" });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "button button--small uiBanner__retry";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => { strip.hidden = true; });
  strip.append(dismiss);
  uiState.announce(message);
  return strip;
}

export const routeNotice = Object.freeze({ take, show });
