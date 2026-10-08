(() => {
  "use strict";
  // The MCP integration page (mcp.html, /mcp-integration, docs/mcp-integration-page.md): the endpoint
  // of the MCP server that is built into ChDash and the access keys of its clients. It is a page of
  // its own and not tied to a host: the header block and the keys table come from /api/mcp/meta and
  // /api/mcp/keys (ns.api, app_api.js), the key form and the one-time secret from app_mcp_form.js.
  //
  // This controller starts the page's modules (ns.loader), the header (ns.ui.init: page switcher,
  // theme), loads the two answers and runs the actions of a key: create, edit, disable, enable,
  // rotate, delete. The strip (#mcpHead: endpoint, Refresh, New key), the keys (#mcpKeys) and the
  // side column (#mcpSide) are drawn again after every change. The page list of the switcher shows MCP only when /api/version reports
  // features.mcp.enabled; a page opened with MCP off shows the HCL block that turns it on.
  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;

  const state = { meta: null, keys: [], status: "loading", error: null };
  let sequence = 0;
  const actions = () => ({
    onCreate: createKey,
    onEdit: editKey,
    onToggle: toggleKey,
    onRotate: rotateKey,
    onDelete: deleteKey,
    onRefresh: (button) => reload(button),
    onRetry: () => load(),
  });

  function renderKeys() {
    ns.dom.byId("mcpLayout").hidden = false;
    ns.mcpView.renderHead(ns.dom.byId("mcpHead"), state.meta, actions());
    ns.mcpView.renderKeys(ns.dom.byId("mcpKeys"), { meta: state.meta, keys: state.keys, status: state.status, error: state.error }, actions());
  }

  // Nothing of the keys or the side column shows: the state is loading, off or in error.
  function clearBody() {
    ns.dom.byId("mcpKeys").replaceChildren();
    ns.dom.byId("mcpSide").replaceChildren();
    ns.dom.byId("mcpLayout").hidden = true;
  }

  function renderHeadError(error) {
    ns.uiState.error(ns.dom.byId("mcpHead"), { title: "Could not load the MCP state", body: ns.util.errorText(error), retry: () => load() });
    clearBody();
  }

  // The first load: the header block and the keys, each with its own loading state.
  async function load() {
    const mine = ++sequence;
    state.status = "loading";
    state.error = null;
    ns.uiState.loading(ns.dom.byId("mcpHead"), { label: "Loading the MCP state\u2026" });
    clearBody();
    let meta;
    try {
      meta = await ns.api.getMcpMeta();
    } catch (error) {
      if (mine === sequence) renderHeadError(error);
      return;
    }
    if (mine !== sequence) return;
    state.meta = meta;
    if (!meta.enabled) {
      ns.mcpView.renderDisabled(ns.dom.byId("mcpHead"));
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
        ns.mcpView.renderDisabled(ns.dom.byId("mcpHead"));
        clearBody();
        return;
      }
      state.meta = meta;
      state.keys = keys;
      state.status = "ready";
      ns.mcpView.renderSide(ns.dom.byId("mcpSide"), meta);
      renderKeys();
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
    const result = await ns.mcpForm.openKeyForm({ meta: state.meta, key: null, submit: (input) => ns.api.createMcpKey(input) });
    if (!result) {
      opener?.focus?.();
      return;
    }
    await reload();
    ns.uiState.announce(`Key ${result.key.name} created`);
    await ns.mcpForm.showSecret({ meta: state.meta, key: result.key, secret: result.secret });
    focusRow(result.key.id, "edit");
  }

  async function editKey(key) {
    clearAlert();
    const saved = await ns.mcpForm.openKeyForm({ meta: state.meta, key, submit: (input) => ns.api.updateMcpKey(key.id, input) });
    if (!saved) {
      focusRow(key.id, "edit");
      return;
    }
    await reload();
    ns.uiState.announce(`Key ${key.name} saved`);
    focusRow(key.id, "edit");
  }

  // What a destructive action touches: the hosts of the key and its last use (since ChDash started).
  function reach(key) {
    const hosts = !key.hosts.length ? "no host" : key.hosts.includes("*") ? "all hosts" : key.hosts.join(", ");
    const ms = Date.parse(key.lastUsedAt || "");
    const used = Number.isFinite(ms) ? `Last used ${ns.format.time(ms)}.` : "No use since ChDash started.";
    return `This key reads ${hosts}. ${used}`;
  }

  async function toggleKey(key) {
    if (key.enabled) {
      const ok = await ns.dialog.confirm({
        title: `Disable key ${key.name}?`,
        message: `Clients that use this key get an authorization error until you enable it again. ${reach(key)}`,
        confirmLabel: "Disable key",
        className: "mcpDialog",
      });
      if (!ok) {
        focusRow(key.id, "toggle");
        return;
      }
    }
    await run(() => ns.api.updateMcpKey(key.id, { enabled: !key.enabled }), { id: key.id, action: "toggle", message: `Key ${key.name} ${key.enabled ? "disabled" : "enabled"}` });
  }

  async function rotateKey(key) {
    const ok = await ns.dialog.confirm({
      title: `Rotate the secret of ${key.name}?`,
      message: `The old secret stops working at once. Every client that uses it needs the new secret. ${reach(key)}`,
      confirmLabel: "Rotate secret",
      danger: true,
      className: "mcpDialog",
    });
    if (!ok) {
      focusRow(key.id, "rotate");
      return;
    }
    const result = await run(() => ns.api.rotateMcpKey(key.id), { id: key.id, action: "rotate" });
    if (!result) return;
    await ns.mcpForm.showSecret({ meta: state.meta, key: result.key, secret: result.secret, rotated: true });
    focusRow(key.id, "rotate");
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
