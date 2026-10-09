(() => {
  "use strict";
  // The MCP integration page (mcp.html, /mcp-integration, docs/mcp-integration-page.md): the endpoint
  // of the MCP server that is built into ChDash and the access keys of its clients. It is a page of
  // its own and not tied to a host: the header block and the keys table come from /api/mcp/meta and
  // /api/mcp/keys (ns.api, app_api.js), the key form and the one-time secret from app_mcp_form.js.
  //
  // This controller starts the page's modules (ns.loader), the header (ns.ui.init: page switcher,
  // theme), loads the two answers and runs the actions of a key: create and delete (a key is never
  // changed). The details of a key open under its row (app_mcp_view.js). The keys (#mcpKeys, with the New key and Refresh buttons in its heading) and
  // the side column (#mcpSide) are drawn again after every change; #mcpState holds the loading, the
  // error and the "MCP is off" states. The page list of the switcher shows MCP only when /api/version reports
  // features.mcp.enabled; a page opened with MCP off shows the HCL block that turns it on.
  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;

  const state = { meta: null, keys: [], status: "loading", error: null, access: null };
  let sequence = 0;
  const actions = () => ({
    onCreate: createKey,
    onDelete: deleteKey,
    onRefresh: (button) => reload(button),
    onRetry: () => load(),
  });

  // How many databases and tables each key reaches: asked once for all the keys, after the table is drawn, and written in
  // its cells (the table is not drawn again, so a key that is open stays open).
  let accessSerial = 0;
  async function loadAccess({ refresh = false } = {}) {
    const mine = ++accessSerial;
    if (state.status !== "ready" || !state.keys.length) return;
    try {
      const access = await ns.api.getMcpAccessSummary({ refresh });
      if (mine !== accessSerial) return;
      state.access = access;
      ns.mcpView.fillAccess(ns.dom.byId("mcpKeys"), access);
    } catch (error) {
      if (mine !== accessSerial) return;
      state.access = null;
      ns.mcpView.fillAccess(ns.dom.byId("mcpKeys"), null, ns.util.errorText(error, "The data of the keys could not be counted."));
    }
  }

  function renderKeys({ refresh = false } = {}) {
    ns.dom.byId("mcpLayout").hidden = false;
    ns.dom.byId("mcpState").replaceChildren();
    ns.mcpView.renderKeys(ns.dom.byId("mcpKeys"), { meta: state.meta, keys: state.keys, status: state.status, error: state.error }, actions());
    // The counts that are known show at once; they are asked again (the grants of a host are kept 60 s by the server).
    if (state.access) ns.mcpView.fillAccess(ns.dom.byId("mcpKeys"), state.access);
    void loadAccess({ refresh });
  }

  // Nothing of the keys or the side column shows: the state is loading, off or in error.
  function clearBody() {
    ns.dom.byId("mcpKeys").replaceChildren();
    ns.dom.byId("mcpSide").replaceChildren();
    ns.dom.byId("mcpLayout").hidden = true;
  }

  function renderStateError(error) {
    ns.uiState.error(ns.dom.byId("mcpState"), { title: "Could not load the MCP state", body: ns.util.errorText(error), retry: () => load() });
    clearBody();
  }

  // The first load: the header block and the keys, each with its own loading state.
  async function load() {
    const mine = ++sequence;
    state.status = "loading";
    state.error = null;
    ns.uiState.loading(ns.dom.byId("mcpState"), { label: "Loading the MCP state\u2026" });
    clearBody();
    let meta;
    try {
      meta = await ns.api.getMcpMeta();
    } catch (error) {
      if (mine === sequence) renderStateError(error);
      return;
    }
    if (mine !== sequence) return;
    state.meta = meta;
    if (!meta.enabled) {
      ns.mcpView.renderDisabled(ns.dom.byId("mcpState"));
      return;
    }
    state.keys = [];
    ns.mcpView.renderSide(ns.dom.byId("mcpSide"), meta);
    renderKeys();
    try {
      state.keys = await ns.api.getMcpKeys();
      state.status = "ready";
    } catch (error) {
      if (mine !== sequence) return;
      if (error?.mcp?.code === "mcp_disabled") {
        await load();
        return;
      }
      state.status = "error";
      state.error = error;
    }
    if (mine !== sequence) return;
    renderKeys();
  }

  // A reload that keeps what is on screen: after an action, and the Refresh button.
  async function reload(button = null) {
    const mine = ++sequence;
    if (button) ns.uiState.busy(button, true);
    try {
      const [meta, keys] = await Promise.all([ns.api.getMcpMeta(), ns.api.getMcpKeys()]);
      if (mine !== sequence) return;
      if (!meta.enabled) {
        state.meta = meta;
        ns.mcpView.renderDisabled(ns.dom.byId("mcpState"));
        clearBody();
        return;
      }
      state.meta = meta;
      state.keys = keys;
      state.status = "ready";
      ns.mcpView.renderSide(ns.dom.byId("mcpSide"), meta);
      // The Refresh button reads the grants of the MCP users again; an action (a key made or deleted) uses what is kept.
      renderKeys({ refresh: !!button });
    } catch (error) {
      if (mine !== sequence) return;
      showAlert(error);
    } finally {
      if (button?.isConnected) ns.uiState.busy(button, false);
    }
  }

  function showAlert(error) {
    const box = ns.dom.byId("mcpAlert");
    if (!box) return;
    ns.uiState.banner(box, { message: ns.util.errorText(error, "The change failed.") });
    box.hidden = !box.textContent;
    if (!box.hidden) box.scrollIntoView?.({ block: "nearest" });
  }

  function clearAlert() {
    const box = ns.dom.byId("mcpAlert");
    if (box) {
      box.replaceChildren();
      box.hidden = true;
    }
  }

  // The focus after a list that was drawn again: the same button of the same row, else New key.
  function focusRow(id, action) {
    const row = id ? ns.dom.$(`tr[data-key-id="${CSS.escape(id)}"]`, ns.dom.byId("mcpKeys")) : null;
    const target = (row && ns.dom.$(`[data-action="${action}"]:not(:disabled)`, row)) || ns.dom.byId("mcpNewKey");
    target?.focus();
  }

  // An action: the call, then a reload of the list. A failure shows above the table.
  async function run(call, { id = "", action = "", message = "" } = {}) {
    clearAlert();
    try {
      const result = await call();
      await reload();
      if (message) ns.uiState.announce(message);
      focusRow(id, action);
      return result;
    } catch (error) {
      // A key that is gone, or MCP turned off meanwhile: the list is stale. The reload draws the
      // table again, so the error shows after it.
      if (["not_found", "mcp_disabled", "storage_not_configured"].includes(error?.mcp?.code)) await reload();
      showAlert(error);
      return null;
    }
  }

  async function createKey(opener) {
    clearAlert();
    const result = await ns.mcpForm.openKeyForm({ meta: state.meta, submit: (input) => ns.api.createMcpKey(input) });
    if (!result) {
      opener?.focus?.();
      return;
    }
    await reload();
    ns.uiState.announce(`Key ${result.key.name} created`);
    await ns.mcpForm.showSecret({ meta: state.meta, key: result.key, secret: result.secret });
    focusRow(result.key.id, "open");
  }

  // What a destructive action touches: the hosts of the key.
  function reach(key) {
    const hosts = !key.hosts.length ? "no host" : key.hosts.includes("*") ? "all hosts" : key.hosts.join(", ");
    return `This key reads ${hosts}.`;
  }

  async function deleteKey(key) {
    const ok = await ns.dialog.confirm({
      title: `Delete key ${key.name}?`,
      message: `This cannot be undone. Clients that use this key lose access at once. ${reach(key)}`,
      confirmLabel: "Delete key",
      danger: true,
      className: "mcpDialog",
    });
    if (!ok) {
      focusRow(key.id, "remove");
      return;
    }
    await run(() => ns.api.deleteMcpKey(key.id), { message: `Key ${key.name} deleted` });
  }

  function bindShell() {
    const dom = ns.dom || {};
    const route = (path) => ns.api.resolveUrl(path);
    ns.ui?.setPageSelectorValue?.("mcp");
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer/catalog")));
  }

  async function start() {
    await ns.loader.startModules();
    bindShell();
    ns.ui?.init?.();
    await load();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start().catch(console.error), { once: true });
  else start().catch(console.error);
})();
