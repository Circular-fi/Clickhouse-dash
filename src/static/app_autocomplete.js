(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { state } = ns;

  const maxSuggestions = 20;
  const visibleSuggestionRows = 8;
  const minAutoPrefix = 1;
  const showEmptyQualifiedAfterDot = true;
  const relationStarters = new Set(["FROM", "JOIN", "INTO", "UPDATE", "DESCRIBE", "DESC", "TABLE"]);
  const expressionClauses = new Set(["SELECT", "WITH", "WHERE", "PREWHERE", "HAVING", "QUALIFY", "ON", "GROUP BY", "ORDER BY", "BY", "WINDOW"]);
  const aliasStopWords = new Set([
    "ARRAY", "GLOBAL", "FINAL", "SAMPLE", "PREWHERE", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET",
    "SETTINGS", "FORMAT", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "ANY", "ALL", "ASOF", "SEMI", "ANTI", "ON", "USING",
  ]);
  const clauseRegex = /\b(GLOBAL\s+ARRAY\s+JOIN|ARRAY\s+JOIN|SHOW\s+CREATE|PREWHERE|GROUP\s+BY|ORDER\s+BY|LIMIT\s+BY|SETTINGS|FORMAT|QUALIFY|WINDOW|HAVING|WHERE|FROM|JOIN|INTO|SELECT|WITH|RENAME|ALTER|DROP|DETACH|ATTACH|TRUNCATE|OPTIMIZE|CHECK|EXISTS|DESCRIBE|DESC|TABLE|ON|BY)\b/gi;
  const identReSource = String.raw`(?:\`[^\`]+\`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
  const aliasIdentReSource = String.raw`(?:\`[^\`]+\`|"[^"]+"|\'[^\']+\'|[A-Za-z_][A-Za-z0-9_$]*)`;
  const qualifiedIdentReSource = `${identReSource}(?:\\s*\\.\\s*${identReSource})*`;

  let textarea = null;
  let menu = null;
  let activeIndex = 0;
  let suggestions = [];
  let replaceRange = null;
  let closeTimer = 0;
  let lastExplicit = false;
  let lastUpdateKey = "";
  let ghostFrame = 0;
  let ghostKey = "";
  const autocompleteStorageKey = "chdash.autocomplete.enabled";
  const autocompletePartialStorageKey = "chdash.autocomplete.partial_match.enabled";
  const copyButtonStorageKey = "chdash.editor.copy_button.enabled";
  const lineNumbersStorageKey = "chdash.editor.line_numbers.enabled";
  const warningsStorageKey = "chdash.editor.warnings.enabled";
  const warningTablesStorageKey = "chdash.editor.warnings.tables.enabled";
  const warningFunctionsStorageKey = "chdash.editor.warnings.functions.enabled";
  const warningColumnsStorageKey = "chdash.editor.warnings.columns.enabled";
  const legacyWarningsStorageKeys = ["chdash.editor.reference_diagnostics.enabled"];
  const legacyAutocompletePartialStorageKeys = ["chdash.autocomplete.fuzzy_matching.enabled", "chdash.autocomplete.contains_matches.enabled"];
  function loadStoredBoolWithLegacy(key, legacyKeys, fallback = true) {
    try {
      if (window.localStorage) {
        const raw = window.localStorage.getItem(key);
        if (raw != null) return raw !== "false" && raw !== "0";

        const keys = Array.isArray(legacyKeys) ? legacyKeys : (legacyKeys ? [legacyKeys] : []);
        for (const legacyKey of keys) {
          const legacyRaw = window.localStorage.getItem(legacyKey);
          if (legacyRaw != null) {
            const value = legacyRaw !== "false" && legacyRaw !== "0";
            window.localStorage.setItem(key, value ? "true" : "false");
            return value;
          }
        }
      }
    } catch {
      // ignore storage failures; fallback applies.
    }
    return fallback;
  }
  let autocompleteEnabled = loadStoredBool(autocompleteStorageKey, true);
  let autocompletePartialEnabled = loadStoredBoolWithLegacy(autocompletePartialStorageKey, legacyAutocompletePartialStorageKeys, false);
  let copyButtonEnabled = loadStoredBool(copyButtonStorageKey, true);
  let lineNumbersEnabled = loadStoredBool(lineNumbersStorageKey, true);
  let warningsEnabled = loadStoredBoolWithLegacy(warningsStorageKey, legacyWarningsStorageKeys, true);
  let warningTablesEnabled = loadStoredBool(warningTablesStorageKey, true);
  let warningFunctionsEnabled = loadStoredBool(warningFunctionsStorageKey, true);
  let warningColumnsEnabled = loadStoredBool(warningColumnsStorageKey, true);
  let diagnosticsLayer = null;
  let diagnosticsTooltip = null;
  let diagnosticsTimer = 0;
  let diagnosticsRaf = 0;
  let currentDiagnostics = [];
  let autocompleteControl = null;
  let autocompleteControlButton = null;
  let autocompleteControlMenu = null;
  let lastPointerX = null;
  let lastPointerY = null;
  let pointerTrackingBound = false;

  function loadStoredBool(key, fallback = true) {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(key) : null;
      return raw == null ? fallback : raw !== "false" && raw !== "0";
    } catch {
      return fallback;
    }
  }

  function saveStoredBool(key, value) {
    try {
      if (window.localStorage) window.localStorage.setItem(key, value ? "true" : "false");
    } catch {
      // ignore storage failures; runtime state still applies.
    }
  }

  function isAutocompleteEnabled() {
    return autocompleteEnabled !== false;
  }

  function isAutocompletePartialEnabled() {
    return autocompletePartialEnabled !== false;
  }

  function isCopyButtonEnabled() {
    return copyButtonEnabled !== false;
  }

  function isLineNumbersEnabled() {
    return lineNumbersEnabled !== false;
  }

  function isWarningsEnabled() {
    return warningsEnabled !== false;
  }

  function isTableWarningsEnabled() {
    return isWarningsEnabled() && warningTablesEnabled !== false;
  }

  function isFunctionWarningsEnabled() {
    return isWarningsEnabled() && warningFunctionsEnabled !== false;
  }

  function isColumnWarningsEnabled() {
    return isWarningsEnabled() && warningColumnsEnabled !== false;
  }

  function isReferenceDiagnosticsEnabled() {
    return isWarningsEnabled() && (isTableWarningsEnabled() || isFunctionWarningsEnabled() || isColumnWarningsEnabled());
  }

  function renderAutocompleteSettingsButton() {
    if (!autocompleteControlButton) return;
    autocompleteControlButton.textContent = "";
    const icon = document.createElement("span");
    icon.className = "editorAutocompleteControl__gear";
    icon.setAttribute("aria-hidden", "true");
    autocompleteControlButton.appendChild(icon);
    autocompleteControlButton.title = "Editor options";
    autocompleteControlButton.setAttribute("aria-label", "Editor options");
  }

  function setMenuToggleState(selector, enabled) {
    if (!autocompleteControlMenu) return;
    const item = autocompleteControlMenu.querySelector(selector);
    if (!item) return;
    item.setAttribute("aria-checked", String(enabled));
    item.classList.toggle("is-checked", !!enabled);
  }

  function applyEditorOptionClasses() {
    const root = document.documentElement;
    const hideCopy = !isCopyButtonEnabled();
    const hideLines = !isLineNumbersEnabled();

    // Keep the early pre-paint classes from index.html in sync after the app is running.
    // Those root classes prevent a flash of the copy button / line numbers during reload.
    if (root && root.classList) {
      root.classList.toggle("chdash-copy-button-hidden", hideCopy);
      root.classList.toggle("chdash-line-numbers-hidden", hideLines);
    }

    if (!textarea) return;
    const wrap = textarea.closest ? textarea.closest(".editorWrap") : null;
    if (!wrap) return;
    wrap.classList.toggle("is-copy-button-hidden", hideCopy);
    wrap.classList.toggle("is-line-numbers-hidden", hideLines);
  }

  function updateAutocompleteControlUi() {
    if (!autocompleteControlButton) return;
    const enabled = isAutocompleteEnabled();
    renderAutocompleteSettingsButton();
    autocompleteControlButton.removeAttribute("aria-pressed");
    autocompleteControlButton.classList.toggle("has-disabled-autocomplete", !enabled);
    if (autocompleteControlMenu) {
      autocompleteControlMenu.classList.toggle("has-disabled-autocomplete", !enabled);
      const submenu = autocompleteControlMenu.querySelector("[data-autocomplete-submenu]");
      if (submenu) {
        submenu.hidden = !enabled;
        submenu.setAttribute("aria-hidden", String(!enabled));
      }
      const autoToggle = autocompleteControlMenu.querySelector("[data-autocomplete-toggle]");
      if (autoToggle) {
        autoToggle.setAttribute("aria-expanded", String(enabled));
        autoToggle.classList.toggle("is-expanded", enabled);
      }
      const warningsEnabledNow = isWarningsEnabled();
      const warningsSubmenu = autocompleteControlMenu.querySelector("[data-warnings-submenu]");
      if (warningsSubmenu) {
        warningsSubmenu.hidden = !warningsEnabledNow;
        warningsSubmenu.setAttribute("aria-hidden", String(!warningsEnabledNow));
      }
      const warningsToggle = autocompleteControlMenu.querySelector("[data-warnings-toggle]");
      if (warningsToggle) {
        warningsToggle.setAttribute("aria-expanded", String(warningsEnabledNow));
        warningsToggle.classList.toggle("is-expanded", warningsEnabledNow);
      }
    }
    setMenuToggleState("[data-autocomplete-toggle]", enabled);
    setMenuToggleState("[data-autocomplete-partial-toggle]", isAutocompletePartialEnabled());
    setMenuToggleState("[data-copy-button-toggle]", isCopyButtonEnabled());
    setMenuToggleState("[data-line-numbers-toggle]", isLineNumbersEnabled());
    setMenuToggleState("[data-warnings-toggle]", isWarningsEnabled());
    setMenuToggleState("[data-warning-tables-toggle]", isTableWarningsEnabled());
    setMenuToggleState("[data-warning-functions-toggle]", isFunctionWarningsEnabled());
    setMenuToggleState("[data-warning-columns-toggle]", isColumnWarningsEnabled());
    applyEditorOptionClasses();
  }

  function closeAutocompleteControlMenu() {
    if (!autocompleteControl || !autocompleteControlButton || !autocompleteControlMenu) return;
    autocompleteControl.classList.remove("is-open");
    autocompleteControlButton.setAttribute("aria-expanded", "false");
    autocompleteControlMenu.hidden = true;
  }

  function openAutocompleteControlMenu() {
    if (!autocompleteControl || !autocompleteControlButton || !autocompleteControlMenu) return;
    autocompleteControl.classList.add("is-open");
    autocompleteControlButton.setAttribute("aria-expanded", "true");
    autocompleteControlMenu.hidden = false;
    autocompleteControlMenu.focus({ preventScroll: true });
  }

  function toggleAutocompleteControlMenu() {
    if (!autocompleteControlMenu) return;
    if (autocompleteControlMenu.hidden) openAutocompleteControlMenu();
    else closeAutocompleteControlMenu();
  }

  function setAutocompleteEnabled(value) {
    autocompleteEnabled = value !== false;
    saveStoredBool(autocompleteStorageKey, autocompleteEnabled);
    updateAutocompleteControlUi();
    if (!autocompleteEnabled) {
      close();
    } else if (textarea && document.activeElement === textarea) {
      scheduleUpdate(true);
    }
  }

  function setAutocompletePartialEnabled(value) {
    autocompletePartialEnabled = value !== false;
    saveStoredBool(autocompletePartialStorageKey, autocompletePartialEnabled);
    updateAutocompleteControlUi();
    hideGhost();
    if (textarea && document.activeElement === textarea && isAutocompleteEnabled()) {
      scheduleUpdate(true);
    }
  }

  function setCopyButtonEnabled(value) {
    copyButtonEnabled = value !== false;
    saveStoredBool(copyButtonStorageKey, copyButtonEnabled);
    updateAutocompleteControlUi();
  }

  function setLineNumbersEnabled(value) {
    lineNumbersEnabled = value !== false;
    saveStoredBool(lineNumbersStorageKey, lineNumbersEnabled);
    updateAutocompleteControlUi();
    if (window.ChDash && window.ChDash.highlight && typeof window.ChDash.highlight.update === "function") {
      window.ChDash.highlight.update();
    }
    scheduleDiagnostics();
  }

  function setWarningsEnabled(value) {
    warningsEnabled = value !== false;
    saveStoredBool(warningsStorageKey, warningsEnabled);
    updateAutocompleteControlUi();
    scheduleDiagnostics(true);
  }

  // Backward-compatible alias for older callers / return objects.
  function setReferenceDiagnosticsEnabled(value) {
    setWarningsEnabled(value);
  }

  function setTableWarningsEnabled(value) {
    warningTablesEnabled = value !== false;
    saveStoredBool(warningTablesStorageKey, warningTablesEnabled);
    updateAutocompleteControlUi();
    scheduleDiagnostics(true);
  }

  function setFunctionWarningsEnabled(value) {
    warningFunctionsEnabled = value !== false;
    saveStoredBool(warningFunctionsStorageKey, warningFunctionsEnabled);
    updateAutocompleteControlUi();
    scheduleDiagnostics(true);
  }

  function setColumnWarningsEnabled(value) {
    warningColumnsEnabled = value !== false;
    saveStoredBool(warningColumnsStorageKey, warningColumnsEnabled);
    updateAutocompleteControlUi();
    scheduleDiagnostics(true);
  }

  function buildEditorOption(label, attrName) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "editorAutocompleteControl__opt";
    btn.setAttribute("role", "menuitemcheckbox");
    btn.setAttribute(attrName, "true");

    const check = document.createElement("span");
    check.className = "editorAutocompleteControl__check";
    check.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "editorAutocompleteControl__text";
    text.textContent = label;

    btn.appendChild(check);
    btn.appendChild(text);
    return btn;
  }

  function enhanceAutocompleteToggle() {
    if (!autocompleteControlMenu) return null;
    const autoToggle = autocompleteControlMenu.querySelector("[data-autocomplete-toggle]");
    if (!autoToggle) return null;
    autoToggle.classList.add("editorAutocompleteControl__opt--parent");
    autoToggle.setAttribute("aria-controls", "editorAutocompleteSubmenu");
    autoToggle.querySelectorAll(".editorAutocompleteControl__caret").forEach((caret) => caret.remove());
    return autoToggle;
  }

  function buildAutocompleteSubmenu() {
    const wrap = document.createElement("div");
    wrap.id = "editorAutocompleteSubmenu";
    wrap.className = "editorAutocompleteControl__submenu";
    wrap.setAttribute("data-autocomplete-submenu", "true");

    const partial = buildEditorOption("Partial match", "data-autocomplete-partial-toggle");
    partial.classList.add("editorAutocompleteControl__opt--sub");
    wrap.appendChild(partial);
    return wrap;
  }

  function ensureAutocompleteSubmenu() {
    if (!autocompleteControlMenu) return;
    const autoToggle = enhanceAutocompleteToggle();
    let submenu = autocompleteControlMenu.querySelector("[data-autocomplete-submenu]");
    if (!submenu) {
      submenu = buildAutocompleteSubmenu();
      if (autoToggle && autoToggle.nextSibling) autocompleteControlMenu.insertBefore(submenu, autoToggle.nextSibling);
      else if (autoToggle) autocompleteControlMenu.appendChild(submenu);
      else autocompleteControlMenu.appendChild(submenu);
    }
    submenu.id = submenu.id || "editorAutocompleteSubmenu";
    if (!submenu.querySelector("[data-autocomplete-partial-toggle]")) {
      const partial = buildEditorOption("Partial match", "data-autocomplete-partial-toggle");
      partial.classList.add("editorAutocompleteControl__opt--sub");
      submenu.appendChild(partial);
    }
    const legacyTitle = submenu.querySelector(".editorAutocompleteControl__subtitle");
    if (legacyTitle) legacyTitle.remove();
    const partialText = submenu.querySelector("[data-autocomplete-partial-toggle] .editorAutocompleteControl__text");
    if (partialText) partialText.textContent = "Partial match";
  }

  function enhanceWarningsToggle() {
    if (!autocompleteControlMenu) return null;
    let warningsToggle = autocompleteControlMenu.querySelector("[data-warnings-toggle]");
    const legacy = autocompleteControlMenu.querySelector("[data-reference-diagnostics-toggle]");
    if (!warningsToggle && legacy) {
      warningsToggle = legacy;
      warningsToggle.removeAttribute("data-reference-diagnostics-toggle");
      warningsToggle.setAttribute("data-warnings-toggle", "true");
    }
    if (!warningsToggle) return null;
    warningsToggle.classList.add("editorAutocompleteControl__opt--parent");
    warningsToggle.setAttribute("aria-controls", "editorWarningsSubmenu");
    warningsToggle.querySelectorAll(".editorAutocompleteControl__caret").forEach((caret) => caret.remove());
    const text = warningsToggle.querySelector(".editorAutocompleteControl__text");
    if (text) text.textContent = "Warnings";
    return warningsToggle;
  }

  function buildWarningsSubmenu() {
    const wrap = document.createElement("div");
    wrap.id = "editorWarningsSubmenu";
    wrap.className = "editorAutocompleteControl__submenu editorAutocompleteControl__submenu--warnings";
    wrap.setAttribute("data-warnings-submenu", "true");

    const table = buildEditorOption("Tables", "data-warning-tables-toggle");
    table.classList.add("editorAutocompleteControl__opt--sub");
    wrap.appendChild(table);

    const fn = buildEditorOption("Functions", "data-warning-functions-toggle");
    fn.classList.add("editorAutocompleteControl__opt--sub");
    wrap.appendChild(fn);

    const col = buildEditorOption("Columns", "data-warning-columns-toggle");
    col.classList.add("editorAutocompleteControl__opt--sub");
    wrap.appendChild(col);
    return wrap;
  }

  function ensureWarningsSubmenu() {
    if (!autocompleteControlMenu) return;
    let warningsToggle = enhanceWarningsToggle();
    if (!warningsToggle) {
      warningsToggle = buildEditorOption("Warnings", "data-warnings-toggle");
      warningsToggle.classList.add("editorAutocompleteControl__opt--parent");
      warningsToggle.setAttribute("aria-controls", "editorWarningsSubmenu");
      autocompleteControlMenu.appendChild(warningsToggle);
    }
    let submenu = autocompleteControlMenu.querySelector("[data-warnings-submenu]");
    if (!submenu) {
      submenu = buildWarningsSubmenu();
      if (warningsToggle && warningsToggle.nextSibling) autocompleteControlMenu.insertBefore(submenu, warningsToggle.nextSibling);
      else autocompleteControlMenu.appendChild(submenu);
    }
    submenu.id = submenu.id || "editorWarningsSubmenu";
    const required = [
      ["[data-warning-tables-toggle]", "Tables", "data-warning-tables-toggle"],
      ["[data-warning-functions-toggle]", "Functions", "data-warning-functions-toggle"],
      ["[data-warning-columns-toggle]", "Columns", "data-warning-columns-toggle"],
    ];
    for (const [selector, label, attr] of required) {
      if (!submenu.querySelector(selector)) {
        const opt = buildEditorOption(label, attr);
        opt.classList.add("editorAutocompleteControl__opt--sub");
        submenu.appendChild(opt);
      }
    }
  }

  function ensureEditorOptionsMenuItems() {
    if (!autocompleteControlMenu) return;
    if (!autocompleteControlMenu.querySelector("[data-autocomplete-toggle]")) {
      autocompleteControlMenu.appendChild(buildEditorOption("Autocomplete", "data-autocomplete-toggle"));
    }
    ensureAutocompleteSubmenu();
    if (!autocompleteControlMenu.querySelector("[data-copy-button-toggle]")) {
      autocompleteControlMenu.appendChild(buildEditorOption("Copy button", "data-copy-button-toggle"));
    }
    if (!autocompleteControlMenu.querySelector("[data-line-numbers-toggle]")) {
      autocompleteControlMenu.appendChild(buildEditorOption("Line numbers", "data-line-numbers-toggle"));
    }
    ensureWarningsSubmenu();
  }

  function bindAutocompleteControlEvents() {
    if (!autocompleteControl || !autocompleteControlButton || !autocompleteControlMenu) return;
    if (autocompleteControl.dataset && autocompleteControl.dataset.bound === "1") return;
    if (autocompleteControl.dataset) autocompleteControl.dataset.bound = "1";

    autocompleteControlButton.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleAutocompleteControlMenu();
    });

    autocompleteControlMenu.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest(".editorAutocompleteControl__opt") : null;
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.hasAttribute("data-autocomplete-toggle")) {
        setAutocompleteEnabled(!isAutocompleteEnabled());
      } else if (btn.hasAttribute("data-autocomplete-partial-toggle")) {
        setAutocompletePartialEnabled(!isAutocompletePartialEnabled());
      } else if (btn.hasAttribute("data-copy-button-toggle")) {
        setCopyButtonEnabled(!isCopyButtonEnabled());
      } else if (btn.hasAttribute("data-line-numbers-toggle")) {
        setLineNumbersEnabled(!isLineNumbersEnabled());
      } else if (btn.hasAttribute("data-warnings-toggle")) {
        setWarningsEnabled(!isWarningsEnabled());
      } else if (btn.hasAttribute("data-warning-tables-toggle")) {
        setTableWarningsEnabled(!isTableWarningsEnabled());
      } else if (btn.hasAttribute("data-warning-functions-toggle")) {
        setFunctionWarningsEnabled(!isFunctionWarningsEnabled());
      } else if (btn.hasAttribute("data-warning-columns-toggle")) {
        setColumnWarningsEnabled(!isColumnWarningsEnabled());
      } else if (btn.hasAttribute("data-reference-diagnostics-toggle")) {
        setWarningsEnabled(!isWarningsEnabled());
      }
      // Keep the editor options menu open when toggling options.
      // This menu is meant to host several settings, so changing one should not close it.
    });

    autocompleteControlMenu.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeAutocompleteControlMenu();
        autocompleteControlButton.focus({ preventScroll: true });
      }
    });
  }

  function ensureAutocompleteControl() {
    if (!textarea) return null;
    const wrap = textarea.closest ? textarea.closest(".editorWrap") : null;
    if (!wrap) return null;

    autocompleteControl = wrap.querySelector(".editorAutocompleteControl");
    if (!autocompleteControl) {
      autocompleteControl = document.createElement("div");
      autocompleteControl.className = "editorAutocompleteControl";

      autocompleteControlButton = document.createElement("button");
      autocompleteControlButton.type = "button";
      autocompleteControlButton.className = "editorAutocompleteControl__button";
      autocompleteControlButton.setAttribute("aria-haspopup", "menu");
      autocompleteControlButton.setAttribute("aria-expanded", "false");
      renderAutocompleteSettingsButton();

      autocompleteControlMenu = document.createElement("div");
      autocompleteControlMenu.className = "editorAutocompleteControl__menu";
      autocompleteControlMenu.setAttribute("role", "menu");
      autocompleteControlMenu.tabIndex = -1;
      autocompleteControlMenu.hidden = true;

      const menuTitle = document.createElement("div");
      menuTitle.className = "editorAutocompleteControl__title";
      menuTitle.textContent = "Editor options";
      autocompleteControlMenu.appendChild(menuTitle);

      ensureEditorOptionsMenuItems();
      autocompleteControl.appendChild(autocompleteControlButton);
      autocompleteControl.appendChild(autocompleteControlMenu);
      wrap.appendChild(autocompleteControl);

    } else {
      autocompleteControlButton = autocompleteControl.querySelector(".editorAutocompleteControl__button");
      autocompleteControlMenu = autocompleteControl.querySelector(".editorAutocompleteControl__menu");
      renderAutocompleteSettingsButton();
      if (autocompleteControlMenu && !autocompleteControlMenu.querySelector(".editorAutocompleteControl__title")) {
        const menuTitle = document.createElement("div");
        menuTitle.className = "editorAutocompleteControl__title";
        menuTitle.textContent = "Editor options";
        autocompleteControlMenu.insertBefore(menuTitle, autocompleteControlMenu.firstChild);
      }
      ensureEditorOptionsMenuItems();
    }

    bindAutocompleteControlEvents();
    updateAutocompleteControlUi();
    return autocompleteControl;
  }

  function ensureMenu() {
    if (menu && menu.isConnected) return menu;
    menu = document.getElementById("autocompleteMenu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "autocompleteMenu";
      document.body.appendChild(menu);
    }
    menu.className = "autocompleteMenu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    bindPointerTracking();
    return menu;
  }

  function bindPointerTracking() {
    if (pointerTrackingBound) return;
    pointerTrackingBound = true;
    document.addEventListener("pointermove", (ev) => {
      lastPointerX = ev.clientX;
      lastPointerY = ev.clientY;
    }, { passive: true });
  }

  function hoveredAutocompleteRow() {
    if (!menu || menu.hidden || lastPointerX == null || lastPointerY == null) return null;
    const el = document.elementFromPoint(lastPointerX, lastPointerY);
    if (!(el instanceof Element) || !menu.contains(el)) return null;
    return el.closest(".autocompleteItem");
  }

  function syncGhostWithPointer() {
    if (!menu || menu.hidden || !suggestions.length) {
      hideGhost();
      return;
    }
    const row = hoveredAutocompleteRow();
    if (!row) {
      hideGhost();
      return;
    }
    const index = Number(row.dataset.index);
    if (!Number.isFinite(index) || !suggestions[index]) {
      hideGhost();
      return;
    }
    activeIndex = index;
    const rows = menu.querySelectorAll(".autocompleteItem");
    rows.forEach((candidate, i) => candidate.setAttribute("aria-selected", String(i === index)));
    showGhostForSuggestion(suggestions[index]);
  }

  function currentHostMeta() {
    const hostId = String(state.selectedHostId || "");
    return hostId && state.meta && state.meta.hosts ? state.meta.hosts[hostId] : null;
  }

  function norm(s) {
    return String(s || "").toLowerCase();
  }

  function stripQuotes(s) {
    const text = String(s || "").trim();
    if (text.length >= 2 && ((text[0] === "`" && text[text.length - 1] === "`") || (text[0] === '"' && text[text.length - 1] === '"') || (text[0] === "'" && text[text.length - 1] === "'"))) {
      const inner = text.slice(1, -1);
      if (text[0] === "`") return inner.replace(/``/g, "`");
      if (text[0] === "'") return inner.replace(/''/g, "'");
      return inner;
    }
    return text;
  }

  function normalizeQualifiedName(token) {
    return String(token || "")
      .split(".")
      .map((p) => stripQuotes(p.trim()))
      .filter((p) => p.length > 0)
      .join(".");
  }

  function splitQualified(token) {
    const parts = String(token || "").split(".").map(stripQuotes);
    const prefix = parts.length ? parts[parts.length - 1] : "";
    const qualifier = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
    return { parts, prefix, qualifier };
  }

  function getTokenAtCursor(ta) {
    const value = String(ta.value || "");
    const pos = ta.selectionStart == null ? value.length : ta.selectionStart;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const m = before.match(/[A-Za-z0-9_.$`"]+$/);
    const raw = m ? m[0] : "";
    const end = pos;
    const start = end - raw.length;
    const nextChar = after[0] || "";
    const prevChar = before[before.length - 1] || "";
    const inMiddleOfIdentifier = /[A-Za-z0-9_.$]/.test(nextChar) && /[A-Za-z0-9_.$]/.test(prevChar);
    const q = splitQualified(raw);
    const lastDot = raw.lastIndexOf(".");
    const replaceStart = lastDot >= 0 ? start + lastDot + 1 : start;
    return {
      raw,
      start,
      end,
      replaceStart,
      replaceEnd: end,
      prefix: q.prefix,
      qualifier: q.qualifier,
      parts: q.parts,
      inMiddleOfIdentifier,
    };
  }

  function maskSql(sql) {
    const text = String(sql || "");
    let out = "";
    let quote = "";
    let lineComment = false;
    let blockComment = false;
    let escaped = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1] || "";

      if (lineComment) {
        if (ch === "\n") {
          lineComment = false;
          out += "\n";
        } else {
          out += " ";
        }
        continue;
      }
      if (blockComment) {
        if (ch === "*" && next === "/") {
          out += "  ";
          blockComment = false;
          i += 1;
        } else {
          out += ch === "\n" ? "\n" : " ";
        }
        continue;
      }
      if (quote) {
        if (quote === "'" && ch === "\\" && !escaped) {
          escaped = true;
          out += " ";
          continue;
        }
        if (ch === quote && !escaped) quote = "";
        escaped = false;
        out += ch === "\n" ? "\n" : " ";
        continue;
      }

      if (ch === "-" && next === "-") {
        lineComment = true;
        out += "  ";
        i += 1;
        continue;
      }
      if (ch === "#") {
        lineComment = true;
        out += " ";
        continue;
      }
      if (ch === "/" && next === "*") {
        blockComment = true;
        out += "  ";
        i += 1;
        continue;
      }
      if (ch === "'") {
        quote = ch;
        escaped = false;
        out += " ";
        continue;
      }
      out += ch;
    }

    return out;
  }

  function sanitizeLight(sql) {
    return maskSql(sql).replace(/`[^`]*`/g, " ").replace(/"[^"]*"/g, " ");
  }

  function currentStatementBefore(sql) {
    const text = String(sql || "");
    let start = 0;
    let quote = "";
    let lineComment = false;
    let blockComment = false;
    let escaped = false;
    let depth = 0;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1] || "";

      if (lineComment) {
        if (ch === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (ch === "*" && next === "/") {
          blockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (quote === "'" && ch === "\\" && !escaped) {
          escaped = true;
          continue;
        }
        if (ch === quote && !escaped) quote = "";
        escaped = false;
        continue;
      }

      if (ch === "-" && next === "-") { lineComment = true; i += 1; continue; }
      if (ch === "#") { lineComment = true; continue; }
      if (ch === "/" && next === "*") { blockComment = true; i += 1; continue; }
      if (ch === "'" || ch === "`" || ch === '"') { quote = ch; escaped = false; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === ";" && depth === 0) start = i + 1;
    }

    return text.slice(start);
  }

  function currentStatementAt(sql, pos) {
    const text = String(sql || "");
    const cursor = Math.max(0, Math.min(text.length, pos == null ? text.length : pos));
    const before = currentStatementBefore(text.slice(0, cursor));
    const start = cursor - before.length;
    const after = text.slice(cursor);
    const maskedAfter = maskSql(after);
    let depth = 0;
    let end = text.length;
    for (let i = 0; i < maskedAfter.length; i += 1) {
      const ch = maskedAfter[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === ";" && depth === 0) {
        end = cursor + i;
        break;
      }
    }
    return text.slice(start, end);
  }

  function currentStatementInfoAt(sql, pos) {
    const text = String(sql || "");
    const cursor = Math.max(0, Math.min(text.length, pos == null ? text.length : pos));
    const before = currentStatementBefore(text.slice(0, cursor));
    const start = cursor - before.length;
    const statement = currentStatementAt(text, cursor);
    return { statement, start, cursor: cursor - start };
  }

  function lastTopLevelComma(masked, from, to) {
    let depth = 0;
    let last = -1;
    for (let i = Math.max(0, from); i < Math.min(masked.length, to); i += 1) {
      const ch = masked[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) last = i;
    }
    return last;
  }

  function isBlankSelectProjectionSlot(sql, pos) {
    const active = activeSelectProjectionAt(sql, pos);
    return !!active?.isBlank;
  }

  function lastClause(before) {
    const text = sanitizeLight(currentStatementBefore(before));
    let match = null;
    clauseRegex.lastIndex = 0;
    let m;
    while ((m = clauseRegex.exec(text))) match = { kw: m[1].replace(/\s+/g, " ").toUpperCase(), index: m.index };
    return match;
  }

  function isRelationCommandTail(tailText) {
    const t = String(tailText || "").replace(/\s+/g, " ").trim().toUpperCase();
    if (!t) return false;

    // DDL / metadata commands where the next token is usually a database/table/view/dictionary.
    if (/\bSHOW CREATE FUNCTION$/.test(t)) return "function";
    if (/\bSHOW CREATE(?: (?:TABLE|VIEW|DICTIONARY|DATABASE))?$/.test(t)) return true;
    if (/\b(?:DESC|DESCRIBE)(?: TABLE)?$/.test(t)) return true;
    if (/\b(?:EXISTS|DROP|DETACH|ATTACH|TRUNCATE|OPTIMIZE|CHECK)(?: (?:TABLE|VIEW|DICTIONARY|DATABASE))?$/.test(t)) return true;
    if (/\bALTER (?:TABLE|VIEW|DICTIONARY|DATABASE)$/.test(t)) return true;
    if (/\bINSERT INTO$/.test(t)) return true;

    // RENAME TABLE old TO new, old2 TO new2. Suggest existing relations for the left side.
    if (/\bRENAME(?: TABLE| DATABASE)?$/.test(t)) return true;
    if (/\bRENAME TABLE(?: [^,;]+ TO [^,;]+,)*$/.test(t) && !/\bTO\s+$/.test(t)) return true;

    return false;
  }

  function contextAtCursor(ta, token) {
    const value = String(ta.value || "");
    const beforeToken = value.slice(0, token.start);
    const beforeStatement = currentStatementBefore(beforeToken);
    const clause = lastClause(beforeStatement);
    const tail = sanitizeLight(beforeStatement).slice(-260).toUpperCase();

    if (!token.raw && isBlankSelectProjectionSlot(value, token.end)) return { kind: "select_blank_slot", clause };
    if (token.qualifier) return { kind: "qualified", qualifier: token.qualifier, clause };
    const relationTail = isRelationCommandTail(tail);
    if (relationTail === "function") return { kind: "function_name", clause };
    if (relationTail) return { kind: "relation", clause };
    if (/\bCAST\s*\([\s\S]*\bAS\s*$/i.test(tail)) return { kind: "data_type", clause };
    if (clause && clause.kw === "FORMAT") return { kind: "format", clause };
    if (clause && clause.kw === "SETTINGS") return { kind: "setting", clause };
    if (clause && (clause.kw === "ARRAY JOIN" || clause.kw === "GLOBAL ARRAY JOIN")) return { kind: "expression", clause };
    if (clause && (relationStarters.has(clause.kw) || (clause.kw.endsWith("JOIN") && clause.kw !== "ARRAY JOIN" && clause.kw !== "GLOBAL ARRAY JOIN"))) return { kind: "relation", clause };
    if (clause && expressionClauses.has(clause.kw)) return { kind: "expression", clause };
    return { kind: "generic", clause };
  }

  function findMatchingParen(text, openIndex) {
    let quote = "";
    let escaped = false;
    let depth = 0;
    for (let i = openIndex; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (quote === "'" && ch === "\\" && !escaped) { escaped = true; continue; }
        if (ch === quote && !escaped) quote = "";
        escaped = false;
        continue;
      }
      if (ch === "'" || ch === "`" || ch === '"') { quote = ch; escaped = false; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function readIdentifierAt(text, index) {
    const rest = String(text || "").slice(index);
    const m = rest.match(/^\s*((?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*)/);
    if (!m) return null;
    return { raw: m[1], name: normalizeQualifiedName(m[1]), end: index + m[0].length };
  }

  function readOptionalAlias(text, index) {
    const rest = String(text || "").slice(index);
    const m = rest.match(new RegExp(`^\\s+(?:AS\\s+)?(${aliasIdentReSource})`, "i"));
    if (!m) return { alias: "", end: index };
    const alias = stripQuotes(m[1]);
    if (!alias || aliasStopWords.has(alias.toUpperCase())) return { alias: "", end: index };
    return { alias, end: index + m[0].length };
  }

  function splitTopLevel(text, separator = ",") {
    const out = [];
    let start = 0;
    let quote = "";
    let escaped = false;
    let depth = 0;
    const s = String(text || "");
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (quote) {
        if (quote === "'" && ch === "\\" && !escaped) { escaped = true; continue; }
        if (ch === quote && !escaped) quote = "";
        escaped = false;
        continue;
      }
      if (ch === "'" || ch === "`" || ch === '"') { quote = ch; escaped = false; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === separator && depth === 0) {
        out.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(s.slice(start).trim());
    return out.filter((x) => x.length > 0);
  }

  function findTopLevelKeyword(text, keyword, startIndex = 0) {
    const s = String(text || "");
    const masked = maskSql(s);
    let depth = 0;
    const kw = String(keyword || "").toUpperCase();
    for (let i = startIndex; i < masked.length; i += 1) {
      const ch = masked[i];
      if (ch === "(") { depth += 1; continue; }
      if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
      if (depth !== 0) continue;
      if (masked.slice(i, i + kw.length).toUpperCase() === kw) {
        const prev = i === 0 ? " " : masked[i - 1];
        const next = masked[i + kw.length] || " ";
        if (!/[A-Za-z0-9_$]/.test(prev) && !/[A-Za-z0-9_$]/.test(next)) return i;
      }
    }
    return -1;
  }

  function topLevelDepthAt(maskedText, index) {
    const masked = String(maskedText || "");
    let depth = 0;
    const end = Math.max(0, Math.min(masked.length, index));
    for (let i = 0; i < end; i += 1) {
      const ch = masked[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
    }
    return depth;
  }


  function findKeywordAtDepth(maskedText, keyword, startIndex, targetDepth, limitIndex = null) {
    const masked = String(maskedText || "");
    const kw = String(keyword || "").toUpperCase();
    const limit = limitIndex == null ? masked.length : Math.min(masked.length, Math.max(0, limitIndex));
    for (let i = Math.max(0, startIndex || 0); i < limit; i += 1) {
      if (topLevelDepthAt(masked, i) !== targetDepth) continue;
      if (masked.slice(i, i + kw.length).toUpperCase() !== kw) continue;
      const prev = i === 0 ? " " : masked[i - 1];
      const next = masked[i + kw.length] || " ";
      if (!/[A-Za-z0-9_$]/.test(prev) && !/[A-Za-z0-9_$]/.test(next)) return i;
    }
    return -1;
  }

  function lastCommaAtDepth(maskedText, from, to, targetDepth) {
    const masked = String(maskedText || "");
    let last = -1;
    for (let i = Math.max(0, from); i < Math.min(masked.length, to); i += 1) {
      if (masked[i] === "," && topLevelDepthAt(masked, i) === targetDepth) last = i;
    }
    return last;
  }

  function findSelectScopeEndAtDepth(maskedText, selectPos, selectDepth) {
    const masked = String(maskedText || "");
    for (let i = Math.max(0, selectPos + 6); i < masked.length; i += 1) {
      const depth = topLevelDepthAt(masked, i);
      if (masked[i] === ";" && depth === selectDepth) return i;
      if (masked[i] === ")" && depth === selectDepth) return i;
    }
    return masked.length;
  }

  function activeSelectProjectionAt(sql, pos) {
    const value = String(sql || "");
    const cursor = Math.max(0, Math.min(value.length, pos == null ? value.length : pos));
    const info = currentStatementInfoAt(value, cursor);
    const stmtStart = cursor - info.cursor;
    const stmt = String(info.statement || "");
    const localCursor = Math.max(0, Math.min(stmt.length, info.cursor));
    const masked = maskSql(stmt);
    const cursorDepth = topLevelDepthAt(masked, localCursor);

    let selectPos = -1;
    const re = /\bSELECT\b/gi;
    let m;
    while ((m = re.exec(masked))) {
      if (m.index > localCursor) break;
      if (topLevelDepthAt(masked, m.index) === cursorDepth) selectPos = m.index;
    }
    if (selectPos < 0) return null;

    const scopeEnd = findSelectScopeEndAtDepth(masked, selectPos, cursorDepth);
    const fromPos = findKeywordAtDepth(masked, "FROM", selectPos + 6, cursorDepth, scopeEnd);
    if (fromPos < 0 || localCursor < selectPos + 6 || localCursor > fromPos) return null;

    const comma = lastCommaAtDepth(masked, selectPos + 6, localCursor, cursorDepth);
    const slotStart = comma >= 0 ? comma + 1 : selectPos + 6;
    const beforeSlot = masked.slice(slotStart, localCursor);
    const afterSlot = masked.slice(localCursor, fromPos);
    const isBlank = /^\s*$/.test(beforeSlot) && /^\s*$/.test(afterSlot);
    return {
      isBlank,
      statement: stmt,
      statementStart: stmtStart,
      selectPos,
      fromPos,
      scopeEnd,
      cursor: localCursor,
      depth: cursorDepth,
      scopeText: stmt.slice(selectPos, scopeEnd),
    };
  }

  function sourceInfoForCursor(sql, pos, meta) {
    const value = String(sql || "");
    const cursor = Math.max(0, Math.min(value.length, pos == null ? value.length : pos));
    const stmt = currentStatementAt(value, cursor);
    const active = activeSelectProjectionAt(value, cursor);
    if (active) {
      const outerCtes = parseCtes(stmt, meta);
      const scopeSources = parseSources(active.scopeText, meta, 0, outerCtes);
      return { ...scopeSources, activeSelect: active };
    }
    return { ...parseSources(stmt, meta), activeSelect: active };
  }

  function tableFunctionColumnsFromMeta(meta, name) {
    const n = norm(name);
    const items = Array.isArray(meta?.table_functions?.items) ? meta.table_functions.items : [];
    const tf = items.find((it) => norm(it.name) === n);
    return Array.isArray(tf?.columns) ? tf.columns : [];
  }

  function isKnownTableFunction(meta, name) {
    const n = norm(name);
    return (Array.isArray(meta?.table_functions?.items) ? meta.table_functions.items : []).some((tf) => norm(tf.name) === n);
  }

  function topLevelColumns(cols) {
    return (cols || []).filter((c) => !String(c.name || "").includes("."));
  }

  function subcolumnsFor(cols, path) {
    const base = String(path || "");
    if (!base) return topLevelColumns(cols);
    const prefix = `${base}.`;
    const direct = [];
    const seen = new Set();
    for (const c of cols || []) {
      const name = String(c.name || "");
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (!rest) continue;
      const first = rest.split(".")[0];
      if (!first || seen.has(first)) continue;
      seen.add(first);
      const full = `${prefix}${first}`;
      const exact = (cols || []).find((x) => String(x.name || "") === full);
      direct.push({ ...(exact || c), name: first, insertName: first, fullName: full });
    }
    return direct;
  }

  function columnsFor(meta, database, table) {
    const key = `${database || ""}.${table || ""}`.toLowerCase();
    const idx = meta?.autocomplete?.columnsByTable;
    if (idx && idx.has(key)) return idx.get(key) || [];
    const cols = Array.isArray(meta?.columns?.items) ? meta.columns.items : [];
    return cols.filter((c) => norm(c.database) === norm(database) && norm(c.table) === norm(table));
  }

  function tablesForDatabase(meta, database) {
    const db = String(database || "");
    const idx = meta?.autocomplete?.tablesByDatabase;
    if (idx && idx.has(norm(db))) return idx.get(norm(db)) || [];
    const tables = Array.isArray(meta?.tables?.items) ? meta.tables.items : [];
    return tables.filter((t) => norm(t.database) === norm(db));
  }

  function uniqueTablesByName(meta) {
    const tables = Array.isArray(meta?.tables?.items) ? meta.tables.items : [];
    const byName = new Map();
    const dup = new Set();
    for (const t of tables) {
      const key = norm(t.name);
      if (!key) continue;
      if (byName.has(key)) dup.add(key);
      else byName.set(key, t);
    }
    for (const k of dup) byName.delete(k);
    return byName;
  }

  function columnFromName(name, type = "", source = null) {
    return {
      name: String(name || ""),
      insertName: String(name || ""),
      type: String(type || ""),
      database: source?.database || "",
      table: source?.table || "",
    };
  }

  function sourceDisplayName(source) {
    if (!source) return "";
    const alias = String(source.alias || "");
    const name = String(source.name || "");
    const table = String(source.table || "");
    const database = String(source.database || "");
    if (alias) return alias;
    if (name) return name;
    if (table && database) return `${database}.${table}`;
    if (table) return table;
    return "";
  }

  function sourceColumns(source, meta) {
    if (!source) return [];
    if (Array.isArray(source.columns)) return source.columns;
    if (source.database || source.table) return columnsFor(meta, source.database, source.table);
    return [];
  }

  function findColumnInSources(name, sources, meta) {
    const key = norm(name);
    if (!key) return null;
    for (const src of sources || []) {
      const cols = sourceColumns(src, meta);
      const found = cols.find((c) => norm(c.name) === key || norm(c.insertName) === key);
      if (found) return found;
    }
    return null;
  }

  function inferAliasFromSelectItem(item) {
    const s = String(item || "").trim();
    const asMatch = s.match(new RegExp(`\\s+AS\\s+(${aliasIdentReSource})\\s*$`, "i"));
    if (asMatch) return stripQuotes(asMatch[1]);
    const trailing = s.match(new RegExp(`\\s+(${aliasIdentReSource})\\s*$`));
    if (trailing && /[()\s+\-*/%]/.test(s.slice(0, trailing.index))) return stripQuotes(trailing[1]);
    const ident = s.match(new RegExp(`^${qualifiedIdentReSource}$`));
    if (ident) {
      const parts = normalizeQualifiedName(s).split(".");
      return parts[parts.length - 1] || "";
    }
    return "";
  }

  function expressionBeforeSelectAlias(item, alias) {
    const s = String(item || "").trim();
    if (!s || !alias) return s;
    const asRe = new RegExp(`\\s+AS\\s+${aliasIdentReSource}\\s*$`, "i");
    if (asRe.test(s)) return s.replace(asRe, "").trim();
    const trailingRe = new RegExp(`\\s+${aliasIdentReSource}\\s*$`);
    if (trailingRe.test(s)) {
      const cut = s.replace(trailingRe, "").trim();
      if (cut && /[()\s+\-*/%]/.test(cut)) return cut;
    }
    return s;
  }

  function columnTypeForSelectExpression(expr, sourceInfo, meta) {
    const s = String(expr || "").trim();
    if (!s) return "";
    if (/^'(?:''|[^'])*'$/.test(s) || /^"(?:""|[^"])*"$/.test(s)) return "String";
    if (/^\d+$/i.test(s)) return "UInt64";
    if (/^\d+\.\d+$/i.test(s)) return "Float64";
    if (/^(?:true|false)$/i.test(s)) return "Bool";

    const ident = s.match(new RegExp(`^${qualifiedIdentReSource}$`));
    if (!ident) return "";
    const q = normalizeQualifiedName(s);
    const parts = q.split(".").filter(Boolean);
    if (!parts.length) return "";

    if (parts.length >= 2) {
      const first = parts[0];
      const src = sourceInfo?.aliases?.get(norm(first));
      if (src) {
        const colPath = parts.slice(1).join(".");
        const cols = sourceColumns(src, meta);
        const found = cols.find((c) => norm(c.name) === norm(colPath) || norm(c.insertName) === norm(colPath));
        if (found) return found.type || "";
      }
    }

    const found = findColumnInSources(q, sourceInfo?.sources || [], meta)
      || findColumnInSources(parts[parts.length - 1], sourceInfo?.sources || [], meta);
    return found?.type || "";
  }

  function parseSources(sql, meta, depth = 0, externalCtes = null) {
    const aliases = new Map();
    const sources = [];
    if (depth > 5) return { aliases, sources };

    const text = String(sql || "");
    const masked = maskSql(text);
    const uniqueTables = uniqueTablesByName(meta);
    const ctes = externalCtes || parseCtes(text, meta, depth + 1);

    const addSource = (source) => {
      if (!source) return;
      sources.push(source);
      const tableName = String(source.table || source.name || "");
      const alias = String(source.alias || tableName || "");
      if (alias && !aliasStopWords.has(alias.toUpperCase())) aliases.set(norm(alias), source);
      if (tableName && !aliases.has(norm(tableName))) aliases.set(norm(tableName), { ...source, alias: tableName });
    };

    const re = /\b(?:FROM|JOIN)\b/gi;
    let m;
    while ((m = re.exec(masked))) {
      // Only parse relation sources for the query level we are currently
      // analyzing. WITH bodies and nested subqueries are parsed recursively
      // when they become the current source, otherwise their columns leak into
      // the outer SELECT (for example `number` leaking from a CTE renamed as
      // `test`).
      if (topLevelDepthAt(masked, m.index) !== 0) continue;

      let i = re.lastIndex;
      while (i < text.length && /\s/.test(text[i])) i += 1;

      if (text[i] === "(") {
        const close = findMatchingParen(text, i);
        if (close < 0) continue;
        const inner = text.slice(i + 1, close);
        const aliasInfo = readOptionalAlias(text, close + 1);
        const alias = aliasInfo.alias || "";
        const cols = columnsForSelect(inner, meta, depth + 1);
        addSource({ alias, name: alias || "subquery", virtual: true, columns: cols });
        re.lastIndex = Math.max(re.lastIndex, close + 1);
        continue;
      }

      const ref = readIdentifierAt(text, i);
      if (!ref || !ref.name) continue;

      const nextNonWs = (() => {
        let j = ref.end;
        while (j < text.length && /\s/.test(text[j])) j += 1;
        return { ch: text[j] || "", index: j };
      })();

      if (!ref.name.includes(".") && nextNonWs.ch === "(" && isKnownTableFunction(meta, ref.name)) {
        const close = findMatchingParen(text, nextNonWs.index);
        const aliasInfo = close >= 0 ? readOptionalAlias(text, close + 1) : { alias: "", end: ref.end };
        const alias = aliasInfo.alias || ref.name;
        addSource({ alias, name: ref.name, tableFunction: true, virtual: true, columns: tableFunctionColumnsFromMeta(meta, ref.name) });
        if (close >= 0) re.lastIndex = Math.max(re.lastIndex, close + 1);
        continue;
      }

      const aliasInfo = readOptionalAlias(text, ref.end);
      const alias = aliasInfo.alias || "";
      const parts = ref.name.split(".");
      const refKey = norm(ref.name);
      const cte = ctes.get(refKey) || ctes.get(norm(parts[parts.length - 1] || ""));
      if (cte) {
        addSource({ ...cte, alias: alias || cte.name, virtual: true });
        continue;
      }

      let database = "";
      let table = "";
      if (parts.length >= 2) {
        database = parts[parts.length - 2];
        table = parts[parts.length - 1];
      } else {
        table = parts[0];
        const known = uniqueTables.get(norm(table));
        if (known) database = String(known.database || "");
      }
      if (!table) continue;
      addSource({ alias: alias || table, database, table, name: table });
    }

    return { aliases, sources };
  }

  function parseCtes(sql, meta, depth = 0) {
    const ctes = new Map();
    if (depth > 5) return ctes;
    const text = String(sql || "");
    const start = text.search(/\bWITH\b/i);
    const selectPos = text.search(/\bSELECT\b/i);
    if (start < 0 || (selectPos >= 0 && start > selectPos)) return ctes;

    const nameAsRe = new RegExp(`(?:\\bWITH\\b|,)\\s*(${identReSource})\\s+AS\\s*\\(`, "gi");
    let m;
    while ((m = nameAsRe.exec(text))) {
      const name = stripQuotes(m[1]);
      const open = nameAsRe.lastIndex - 1;
      const close = findMatchingParen(text, open);
      if (close < 0) continue;
      const inner = text.slice(open + 1, close);
      ctes.set(norm(name), { name, alias: name, virtual: true, columns: columnsForSelect(inner, meta, depth + 1) });
      nameAsRe.lastIndex = close + 1;
    }

    const subqueryAsRe = /(?:\bWITH\b|,)\s*\(/gi;
    while ((m = subqueryAsRe.exec(text))) {
      const open = subqueryAsRe.lastIndex - 1;
      const close = findMatchingParen(text, open);
      if (close < 0) continue;
      const after = text.slice(close + 1).match(new RegExp(`^\\s+AS\\s+(${aliasIdentReSource})`, "i"));
      if (!after) continue;
      const name = stripQuotes(after[1]);
      const inner = text.slice(open + 1, close);
      ctes.set(norm(name), { name, alias: name, virtual: true, columns: columnsForSelect(inner, meta, depth + 1) });
      subqueryAsRe.lastIndex = close + 1;
    }

    return ctes;
  }

  function topLevelSelectPositionAfterWith(text) {
    const s = String(text || "");
    const start = s.search(/\bWITH\b/i);
    if (start < 0) return -1;
    return findTopLevelKeyword(s, "SELECT", start + 4);
  }

  function parseWithScalars(sql) {
    const scalars = new Map();
    const text = String(sql || "");
    const start = text.search(/\bWITH\b/i);
    const selectPos = topLevelSelectPositionAfterWith(text);
    if (start < 0 || selectPos < 0 || start > selectPos) return scalars;
    const segment = text.slice(start + 4, selectPos);
    for (const item of splitTopLevel(segment, ",")) {
      const s = String(item || "").trim();
      if (!s) continue;
      if (new RegExp(`^${identReSource}\\s+AS\\s*\\(`, "i").test(s)) continue;
      if (/^\s*\(/.test(s) && new RegExp(`\\)\\s+AS\\s+${aliasIdentReSource}\\s*$`, "i").test(s)) continue;
      const alias = inferAliasFromSelectItem(s);
      if (!alias || aliasStopWords.has(alias.toUpperCase())) continue;
      scalars.set(norm(alias), columnFromName(alias, "", { virtual: true }));
    }
    return scalars;
  }

  function columnsForSelect(sql, meta, depth = 0) {
    if (depth > 5) return [];
    const text = String(sql || "").trim();
    const selectPos = findTopLevelKeyword(text, "SELECT", 0);
    if (selectPos < 0) return [];
    const fromPos = findTopLevelKeyword(text, "FROM", selectPos + 6);
    const selectList = fromPos >= 0 ? text.slice(selectPos + 6, fromPos) : text.slice(selectPos + 6);
    const sourceInfo = fromPos >= 0 ? parseSources(text.slice(fromPos), meta, depth + 1) : { aliases: new Map(), sources: [] };
    const items = splitTopLevel(selectList, ",");
    const cols = [];

    for (const item of items) {
      const s = item.trim();
      if (!s) continue;
      if (s === "*") {
        for (const src of sourceInfo.sources) cols.push(...topLevelColumns(sourceColumns(src, meta)));
        continue;
      }
      const star = s.match(new RegExp(`^(${qualifiedIdentReSource})\\s*\\.\\s*\\*$`, "i"));
      if (star) {
        const q = normalizeQualifiedName(star[1]);
        const src = sourceInfo.aliases.get(norm(q));
        if (src) cols.push(...topLevelColumns(sourceColumns(src, meta)));
        continue;
      }
      const alias = inferAliasFromSelectItem(s);
      if (!alias) continue;
      const expr = expressionBeforeSelectAlias(s, alias);
      const inferredType = columnTypeForSelectExpression(expr, sourceInfo, meta);
      const found = findColumnInSources(alias, sourceInfo.sources, meta);
      cols.push(columnFromName(alias, inferredType || found?.type || "", found || null));
    }

    return cols;
  }

  function addSuggestion(list, seen, item) {
    if (!item || !item.label) return;
    const key = `${item.kind || ""}:${item.label}:${item.insert || ""}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(item);
  }

  function matchPrefix(name, prefix) {
    const n = norm(name);
    const p = norm(prefix);
    if (!p) return true;
    if (/^\d/.test(p)) return n.startsWith(p);
    if (n.startsWith(p)) return true;
    return isAutocompletePartialEnabled() && n.includes(p);
  }

  function matchFunctionName(name, prefix, rawToken) {
    const full = String(rawToken || prefix || "");
    if (!full) return matchPrefix(name, prefix);
    return matchPrefix(name, full) || matchPrefix(name, prefix);
  }

  function tokenLooksNumeric(token) {
    const raw = String(token?.raw || "");
    return /^\d[\d.]*$/.test(raw) && !/[A-Za-z_$`"]/.test(raw);
  }

  function previousSemanticWordBefore(sql, index) {
    const masked = sanitizeLight(String(sql || "").slice(0, Math.max(0, index)));
    const m = masked.match(/([A-Za-z_][A-Za-z0-9_$]*)\s*$/);
    return m ? String(m[1] || "") : "";
  }

  function isAfterAliasKeywordContext(ta, token) {
    const value = String(ta?.value || "");
    const beforeToken = value.slice(0, Math.max(0, token?.start || 0));
    const prev = previousSemanticWordBefore(value, token?.start || 0).toUpperCase();
    if (prev !== "AS") return false;

    // CAST(x AS Type) is the main AS-context where completion is desirable.
    const tail = sanitizeLight(currentStatementBefore(beforeToken)).slice(-320).toUpperCase();
    if (/\bCAST\s*\([\s\S]*\bAS\s*$/.test(tail)) return false;

    // After a real alias marker in SELECT/WITH/CTE definitions, the next token is
    // a new alias name, not an existing function/column/table.
    return true;
  }

  function suggestionPriority(kind) {
    return {
      column: 0,
      table: 1,
      table_function: 2,
      database: 3,
      function: 4,
      keyword: 5,
      data_type: 6,
      format: 7,
      setting: 8,
    }[kind] ?? 20;
  }

  function commonSqlBoost(label, kind) {
    const n = norm(label);
    if (kind === "function") {
      if (["count", "sum", "avg", "min", "max", "uniq", "any", "argmax", "argmin"].includes(n)) return -12;
      if (/^(count|sum|avg|min|max|uniq)(if|merge|state|foreach)?$/i.test(label)) return -7;
    }
    if (kind === "keyword") {
      if (["select", "from", "where", "group", "order", "limit", "with", "join", "array join", "settings", "format"].includes(n)) return -8;
    }
    return 0;
  }

  function scoreSuggestion(s, prefix) {
    const p = norm(prefix);
    const label = norm(s.label);
    let score = 0;

    // 1) The textual match dominates: exact > startsWith > word-boundary startsWith > partial.
    if (p) {
      if (label === p) score -= 1000;
      else if (label.startsWith(p)) score -= 800;
      else {
        const boundaryIndex = label.search(new RegExp(`(?:^|[._])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        if (boundaryIndex >= 0) score -= 520;
        else if (label.includes(p)) score -= 240;
      }
    }

    // 2) Then the current SQL context decides the family priority.
    score += suggestionPriority(s.kind) * 35;

    // 3) Then boost items that are more likely in day-to-day SQL.
    score += commonSqlBoost(s.label, s.kind);
    if (s.kind === "column" && s.fromCurrentSource) score -= 25;
    if (s.kind === "table" && s.database) score -= 6;
    if (s.kind === "function" && s.is_aggregate) score -= 4;

    // 4) Shorter, cleaner names win ties. This keeps the top 10 readable.
    score += Math.min(80, String(s.label || "").length * 0.6);
    return score;
  }

  function normalizeCompletionText(value) {
    return stripQuotes(String(value || "")).trim().toLowerCase();
  }

  function isNoopSuggestionForToken(s, token, value) {
    if (!s || !token) return false;
    const start = Number.isFinite(s.replaceStart) ? s.replaceStart : token.replaceStart;
    const end = Number.isFinite(s.replaceEnd) ? s.replaceEnd : token.replaceEnd;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;

    const current = String(value || "").slice(start, end);
    if (!current.trim()) return false;

    // Function suggestions can still be useful when the function name is already
    // fully typed because accepting it adds parentheses, e.g. `sum` -> `sum()`.
    if (s.kind === "function") {
      const after = String(value || "").slice(end);
      if (!/^\s*\(/.test(after)) return false;
    }

    const insert = String(s.insert || s.label || "");
    if (!insert) return false;

    return normalizeCompletionText(current) === normalizeCompletionText(insert);
  }

  function sortAndLimit(list, prefix) {
    list.sort((a, b) => {
      const sa = scoreSuggestion(a, prefix);
      const sb = scoreSuggestion(b, prefix);
      if (sa !== sb) return sa - sb;
      const ka = suggestionPriority(a.kind);
      const kb = suggestionPriority(b.kind);
      if (ka !== kb) return ka - kb;
      return String(a.label).localeCompare(String(b.label));
    });
    return { items: list.slice(0, maxSuggestions), total: list.length };
  }

  function kindBadgeText(kind) {
    const k = String(kind || "generic");
    const map = {
      function: "func",
      keyword: "key",
      column: "col",
      table: "tbl",
      database: "db",
      table_function: "tf",
      data_type: "type",
      setting: "set",
      format: "fmt",
    };
    return map[k] || k.slice(0, 4);
  }

  function peelWrapper(type, wrapper) {
    const t = String(type || "").trim();
    const prefix = `${wrapper}(`;
    if (!t.toLowerCase().startsWith(prefix.toLowerCase()) || !t.endsWith(")")) return null;
    return t.slice(prefix.length, -1).trim();
  }

  function typeBadges(type) {
    let t = String(type || "").trim();
    if (!t) return [];
    if (/^Array\s*\(/i.test(t)) return ["array"];
    if (/^Tuple\s*\(/i.test(t)) return ["tuple"];
    if (/^Map\s*\(/i.test(t)) return ["map"];

    const badges = [];
    let changed = true;
    while (changed) {
      changed = false;
      const nullable = peelWrapper(t, "Nullable");
      if (nullable != null) { badges.push("nullable"); t = nullable; changed = true; continue; }
      const lowCard = peelWrapper(t, "LowCardinality");
      if (lowCard != null) { badges.push("lowcard"); t = lowCard; changed = true; continue; }
    }

    if (/^Array\s*\(/i.test(t)) return ["array"];
    if (/^Tuple\s*\(/i.test(t)) return ["tuple"];
    if (/^Map\s*\(/i.test(t)) return ["map"];
    const base = t.replace(/\(.*/, "").trim();
    if (base) badges.push(base.length > 16 ? `${base.slice(0, 15)}…` : base);
    return badges;
  }

  function originBadge(origin) {
    const o = String(origin || "");
    if (o === "SQLUserDefined") return "sql udf";
    if (o === "ExecutableUserDefined") return "exec udf";
    if (o === "WasmUserDefined") return "wasm udf";
    return "";
  }

  function defaultBadgesForSuggestion(s) {
    if (Array.isArray(s.badges)) return s.badges.map((x) => String(x || "")).filter(Boolean);
    const badges = [];
    if (s.kind === "function") {
      const o = originBadge(s.origin);
      if (o) badges.push(o);
      else if (s.is_user_defined) badges.push("user");
      if (s.is_aggregate) badges.push("agg");
    }
    if (s.kind === "column" && s.type) badges.push(...typeBadges(s.type));
    if (s.kind === "table" && s.detail) badges.push(compactEngineName(s.detail));
    if (s.kind === "data_type" && s.parent) badges.push("alias");
    return badges.filter(Boolean);
  }

  function compactEngineName(engine) {
    const e = String(engine || "").trim();
    if (!e) return "";
    return e.replace(/MergeTree$/i, "MT").replace(/^Replicated/i, "Repl");
  }

  function badgeClassSuffix(text) {
    const s = String(text || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return s || "generic";
  }

  function buildSuggestions(ta, explicit = false) {
    if (!isAutocompleteEnabled()) return { items: [], token: null, totalAvailable: 0 };
    const meta = currentHostMeta();
    if (!meta) return { items: [], token: null };

    const token = getTokenAtCursor(ta);
    if (token.inMiddleOfIdentifier) return { items: [], token, totalAvailable: 0 };
    if (tokenLooksNumeric(token)) return { items: [], token, totalAvailable: 0 };
    if (isAfterAliasKeywordContext(ta, token)) return { items: [], token, totalAvailable: 0 };
    const ctx = contextAtCursor(ta, token);
    const prefix = token.prefix || "";
    const qualified = !!token.qualifier;
    const value = String(ta.value || "");
    const pos = ta.selectionStart || 0;
    const statement = currentStatementAt(value, pos);
    const parsed = sourceInfoForCursor(value, pos, meta);
    const aliases = parsed.aliases;
    const sources = parsed.sources;
    const ctes = parseCtes(statement, meta);
    const scalarCtes = parseWithScalars(statement);
    const list = [];
    const seen = new Set();

    const addCteRelations = () => {
      for (const cte of ctes.values()) {
        if (!cte || !cte.name) continue;
        if (!matchPrefix(cte.name, prefix)) continue;
        addSuggestion(list, seen, { label: cte.name, insert: cte.name, kind: "table", detail: "CTE", badges: ["cte"] });
      }
    };

    const addScalarCtes = () => {
      for (const c of scalarCtes.values()) {
        const name = String(c.name || "");
        if (!matchPrefix(name, prefix)) continue;
        addSuggestion(list, seen, { label: name, insert: name, kind: "column", type: c.type || "", badges: ["cte"], fromCurrentSource: true });
      }
    };

    const addKeywords = () => {
      const keywords = Array.isArray(meta.keywords?.items) ? meta.keywords.items : Array.from(meta.keywords?.set || []);
      for (const kw of keywords) {
        if (!matchPrefix(kw, prefix)) continue;
        addSuggestion(list, seen, { label: kw, insert: kw, kind: "keyword", detail: "keyword" });
      }
    };

    const addFunctions = (rawPrefix = "") => {
      const functions = Array.isArray(meta.functions?.items) ? meta.functions.items : Array.from(meta.functions?.meta?.values?.() || []);
      for (const fn of functions) {
        const name = String(fn.name || "");
        if (!matchFunctionName(name, prefix, rawPrefix)) continue;
        const badges = [];
        const ob = originBadge(fn.origin);
        if (ob) badges.push(ob);
        else if (fn.is_user_defined) badges.push("user");
        if (fn.is_aggregate) badges.push("agg");
        addSuggestion(list, seen, {
          label: name,
          insert: name,
          kind: "function",
          is_aggregate: Boolean(fn.is_aggregate),
          is_user_defined: Boolean(fn.is_user_defined),
          origin: fn.origin || "",
          badges,
          replaceStart: String(rawPrefix || "").includes(".") ? token.start : undefined,
        });
      }
    };

    const addDatabases = () => {
      for (const db of Array.isArray(meta.databases?.items) ? meta.databases.items : []) {
        const name = String(db.name || "");
        if (!matchPrefix(name, prefix)) continue;
        addSuggestion(list, seen, { label: name, insert: name, kind: "database" });
      }
    };

    const addTables = (tables, insertQualified, options = {}) => {
      const displayQualified = options.displayQualified == null ? insertQualified : !!options.displayQualified;
      const insertQualifiedName = options.insertQualified == null ? insertQualified : !!options.insertQualified;
      for (const t of tables || []) {
        const name = String(t.name || "");
        const db = String(t.database || "");
        if (!name) continue;
        const full = db ? `${db}.${name}` : name;
        const label = displayQualified && db ? full : name;
        const insert = insertQualifiedName && db ? full : name;
        const matchName = displayQualified && db ? full : name;
        // In db-qualified context (`system.`), the prefix is the part after the dot.
        // Match both `one` and `system.one`, but insert only `one` after the dot.
        if (!matchPrefix(matchName, prefix) && !matchPrefix(name, prefix) && !(qualified && !prefix)) continue;
        addSuggestion(list, seen, { label, insert, kind: "table", database: db, detail: t.detail || "", badges: t.detail ? [compactEngineName(t.detail)] : [] });
      }
    };

    const addColumns = (cols, qualifiedLabel = false, stripPath = "", extra = {}) => {
      for (const c of cols || []) {
        const rawName = String(c.insertName || c.name || "");
        const name = stripPath && rawName.startsWith(`${stripPath}.`) ? rawName.slice(stripPath.length + 1) : rawName;
        const label = qualifiedLabel && c.table ? `${c.table}.${name}` : name;
        if (!matchPrefix(name, prefix) && !matchPrefix(label, prefix)) continue;
        addSuggestion(list, seen, { label, insert: name, kind: "column", type: c.type || "", database: c.database || "", table: c.table || "", badges: c.type ? typeBadges(c.type) : [], ...extra });
      }
    };

    const addColumnsFromSources = (all = false) => {
      const seenSources = new Set();
      for (const src of sources) {
        const key = `${src.alias || ""}:${src.database || ""}.${src.table || ""}:${src.name || ""}`.toLowerCase();
        if (seenSources.has(key)) continue;
        seenSources.add(key);
        const cols = sourceColumns(src, meta);
        const sourceLabel = sourceDisplayName(src);
        addColumns(all ? cols : topLevelColumns(cols), false, "", { fromCurrentSource: true, sourceLabel });
      }
    };

    const addTableFunctions = () => {
      for (const tf of Array.isArray(meta.table_functions?.items) ? meta.table_functions.items : []) {
        const name = String(tf.name || "");
        if (!matchPrefix(name, prefix)) continue;
        addSuggestion(list, seen, { label: name, insert: name, kind: "table_function" });
      }
    };

    const addFormats = () => {
      for (const f of Array.isArray(meta.formats?.items) ? meta.formats.items : []) {
        const name = String(f.name || "");
        if (!matchPrefix(name, prefix)) continue;
        addSuggestion(list, seen, { label: name, insert: name, kind: "format" });
      }
    };

    const addSettings = () => {
      for (const s of Array.isArray(meta.settings?.items) ? meta.settings.items : []) {
        const name = String(s.name || "");
        if (!matchPrefix(name, prefix)) continue;
        addSuggestion(list, seen, { label: name, insert: name, kind: "setting", type: s.type || "", badges: s.type ? typeBadges(s.type) : [] });
      }
    };

    const addDataTypes = () => {
      for (const dt of Array.isArray(meta.data_types?.items) ? meta.data_types.items : []) {
        const name = String(dt.name || "");
        if (!matchPrefix(name, prefix)) continue;
        addSuggestion(list, seen, { label: name, insert: name, kind: "data_type", parent: dt.parent || "", badges: dt.parent ? ["alias"] : [] });
      }
    };

    if (qualified) {
      const q = stripQuotes(token.qualifier);
      const qParts = q.split(".").filter(Boolean);
      const first = qParts[0] || q;
      const alias = aliases.get(norm(first));
      const isKnownDatabase = (Array.isArray(meta.databases?.items) ? meta.databases.items : []).some((db) => norm(db.name) === norm(q));
      const dbTables = tablesForDatabase(meta, q);
      const tokenEndsWithDot = String(token.raw || "").endsWith(".");

      if (alias) {
        const cols = sourceColumns(alias, meta);
        const path = qParts.length > 1 ? qParts.slice(1).join(".") : "";
        addColumns(path ? subcolumnsFor(cols, path) : topLevelColumns(cols), false, path, { sourceLabel: sourceDisplayName(alias) });
      } else if (isKnownDatabase || dbTables.length || tokenEndsWithDot) {
        // `system.` / `db.` must always propose tables from that database, even with an empty prefix after the dot.
        // Some restricted users may not see the database in SHOW DATABASES but can still see tables from SHOW TABLES.
        addTables(dbTables, false, { displayQualified: true, insertQualified: false });
      } else {
        let matchedColumnPath = false;
        for (const src of sources) {
          const cols = sourceColumns(src, meta);
          const subs = subcolumnsFor(cols, q);
          if (subs.length) {
            matchedColumnPath = true;
            addColumns(subs, false, q, { sourceLabel: sourceDisplayName(src) });
          }
        }
        if (!matchedColumnPath) {
          const uniqueTables = uniqueTablesByName(meta);
          const table = uniqueTables.get(norm(q));
          if (table) addColumns(topLevelColumns(columnsFor(meta, table.database, table.name)), false, "", { sourceLabel: table.database ? `${table.database}.${table.name}` : table.name });
        }
        if (!matchedColumnPath && (ctx.kind === "expression" || ctx.kind === "generic")) {
          // Dotted UDF names such as custom.func: after `custom.` suggest matching functions.
          addFunctions(token.raw);
        }
      }
    } else if (ctx.kind === "select_blank_slot") {
      // The only implicit empty-prefix completion: projection slot before FROM.
      // Suggest only columns from the following relation/CTE and scalar WITH aliases.
      addScalarCtes();
      addColumnsFromSources(false);
    } else if (ctx.kind === "relation") {
      addCteRelations();
      addDatabases();
      addTables(Array.isArray(meta.tables?.items) ? meta.tables.items : [], true);
      addTableFunctions();
    } else if (ctx.kind === "function_name") {
      addFunctions();
    } else if (ctx.kind === "format") {
      addFormats();
    } else if (ctx.kind === "setting") {
      addSettings();
    } else if (ctx.kind === "data_type") {
      addDataTypes();
    } else {
      addScalarCtes();
      addColumnsFromSources(false);
      if (!sources.length && explicit) addColumns(Array.isArray(meta.columns?.items) ? topLevelColumns(meta.columns.items) : [], true);
      addFunctions();
      addKeywords();
    }

    const tokenEndsWithDot = String(token.raw || "").endsWith(".");
    const shouldShow = explicit || ctx.kind === "select_blank_slot" || prefix.length >= minAutoPrefix || (qualified && showEmptyQualifiedAfterDot && tokenEndsWithDot);
    if (!shouldShow) return { items: [], token, totalAvailable: 0 };
    const nonNoop = list.filter((s) => !isNoopSuggestionForToken(s, token, ta.value));
    const ranked = sortAndLimit(nonNoop, prefix);
    return { items: ranked.items, token, totalAvailable: ranked.total };
  }



  function ensureDiagnosticsTooltip() {
    if (diagnosticsTooltip && diagnosticsTooltip.isConnected) return diagnosticsTooltip;
    diagnosticsTooltip = document.createElement("div");
    diagnosticsTooltip.className = "editorDiagnosticTooltip";
    diagnosticsTooltip.setAttribute("role", "tooltip");
    diagnosticsTooltip.hidden = true;
    document.body.appendChild(diagnosticsTooltip);
    return diagnosticsTooltip;
  }

  function hideDiagnosticsTooltip() {
    if (!diagnosticsTooltip) return;
    diagnosticsTooltip.hidden = true;
    diagnosticsTooltip.textContent = "";
    diagnosticsTooltip.style.left = "0px";
    diagnosticsTooltip.style.top = "0px";
  }

  function placeDiagnosticsTooltip(mark) {
    if (!mark || !mark.isConnected) return;
    const msg = mark.dataset.message || "Unknown reference";
    const tip = ensureDiagnosticsTooltip();
    tip.textContent = msg;
    tip.hidden = false;

    const rect = mark.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - tip.offsetWidth - margin);
    const left = Math.min(Math.max(margin, rect.left), maxLeft);
    let top = rect.top - tip.offsetHeight - 8;
    if (top < margin) top = rect.bottom + 8;
    if (top + tip.offsetHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - tip.offsetHeight - margin);
    }
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function ensureDiagnosticsLayer() {
    if (!textarea) return null;
    const wrap = textarea.closest ? textarea.closest(".editorWrap") : null;
    if (!wrap) return null;
    if (diagnosticsLayer && diagnosticsLayer.isConnected) return diagnosticsLayer;
    diagnosticsLayer = wrap.querySelector(".editorDiagnosticsLayer");
    if (!diagnosticsLayer) {
      diagnosticsLayer = document.createElement("div");
      diagnosticsLayer.className = "editorDiagnosticsLayer";
      diagnosticsLayer.setAttribute("aria-hidden", "true");
      wrap.appendChild(diagnosticsLayer);
    }
    return diagnosticsLayer;
  }

  function clearDiagnostics() {
    currentDiagnostics = [];
    if (diagnosticsTimer) { clearTimeout(diagnosticsTimer); diagnosticsTimer = 0; }
    if (diagnosticsRaf) { cancelAnimationFrame(diagnosticsRaf); diagnosticsRaf = 0; }
    if (diagnosticsLayer) diagnosticsLayer.innerHTML = "";
    hideDiagnosticsTooltip();
  }

  function splitTopLevelWithSpans(text, baseIndex = 0, separator = ",") {
    const out = [];
    let start = 0;
    let quote = "";
    let escaped = false;
    let depth = 0;
    const s = String(text || "");
    const push = (end) => {
      let a = start;
      let b = end;
      while (a < b && /\s/.test(s[a])) a += 1;
      while (b > a && /\s/.test(s[b - 1])) b -= 1;
      if (b > a) out.push({ text: s.slice(a, b), start: baseIndex + a, end: baseIndex + b });
    };
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (quote) {
        if (quote === "'" && ch === "\\" && !escaped) { escaped = true; continue; }
        if (ch === quote && !escaped) quote = "";
        escaped = false;
        continue;
      }
      if (ch === "'" || ch === "`" || ch === '"') { quote = ch; escaped = false; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === separator && depth === 0) {
        push(i);
        start = i + 1;
      }
    }
    push(s.length);
    return out;
  }

  function autocompleteKeywordSet(meta) {
    const out = new Set();
    const keywords = Array.isArray(meta?.keywords?.items) ? meta.keywords.items : Array.from(meta?.keywords?.set || []);
    for (const kw of keywords) out.add(norm(kw));
    for (const kw of [
      "select", "from", "where", "prewhere", "and", "or", "not", "in", "is", "null", "as", "with", "join", "on", "using",
      "group", "by", "order", "having", "limit", "offset", "format", "settings", "array", "global", "case", "when", "then", "else", "end", "asc", "desc"
    ]) out.add(kw);
    return out;
  }

  function collectLambdaParams(expr) {
    const params = new Set();
    const text = String(expr || "");
    let m;
    const single = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*->/g;
    while ((m = single.exec(text))) params.add(norm(m[1]));
    const tuple = /\(([^)]{1,160})\)\s*->/g;
    while ((m = tuple.exec(text))) {
      for (const part of String(m[1] || "").split(",")) {
        const name = part.trim().match(/^[A-Za-z_][A-Za-z0-9_$]*$/);
        if (name) params.add(norm(name[0]));
      }
    }
    return params;
  }

  function findSelectAliasRange(itemText, itemStart) {
    const s = String(itemText || "");
    const asMatch = s.match(new RegExp(`\\s+AS\\s+(${aliasIdentReSource})\\s*$`, "i"));
    if (asMatch) {
      const raw = asMatch[1] || "";
      const idx = s.lastIndexOf(raw);
      return idx >= 0 ? { start: itemStart + idx, end: itemStart + idx + raw.length } : null;
    }
    const trailing = s.match(new RegExp(`\\s+(${aliasIdentReSource})\\s*$`));
    if (trailing && /[()\s+\-*/%]/.test(s.slice(0, trailing.index))) {
      const raw = trailing[1] || "";
      const idx = s.lastIndexOf(raw);
      return idx >= 0 ? { start: itemStart + idx, end: itemStart + idx + raw.length } : null;
    }
    return null;
  }

  function expressionSpanBeforeAlias(item) {
    const text = String(item?.text || "");
    const itemStart = Number.isFinite(item?.start) ? item.start : 0;

    // While an alias is being typed after AS, especially a quoted ClickHouse
    // alias like `foo without the closing quote yet, the partial alias must not
    // be linted as a missing column. Closed aliases are handled by
    // findSelectAliasRange(); this handles the in-progress quoted case.
    const unfinishedAlias = text.match(/\s+AS\s+(`[^`]*|"[^"]*|'[^']*)\s*$/i);
    if (unfinishedAlias) {
      let end = itemStart + unfinishedAlias.index;
      let a = itemStart;
      let b = end;
      const value = String(textarea?.value || "");
      while (a < b && /\s/.test(value[a])) a += 1;
      while (b > a && /\s/.test(value[b - 1])) b -= 1;
      return { text: value.slice(a, b), start: a, end: b };
    }

    const alias = inferAliasFromSelectItem(text);
    if (!alias) return { text, start: itemStart, end: item.end };
    const aliasRange = findSelectAliasRange(text, itemStart);
    if (!aliasRange) return { text, start: itemStart, end: item.end };
    let end = aliasRange.start;
    const beforeAlias = text.slice(0, Math.max(0, end - itemStart));
    const asMatch = beforeAlias.match(/\s+AS\s*$/i);
    if (asMatch) end = itemStart + asMatch.index;
    const expr = String(textarea?.value || "").slice(itemStart, end);
    let a = itemStart;
    let b = end;
    while (a < b && /\s/.test(String(textarea?.value || "")[a])) a += 1;
    while (b > a && /\s/.test(String(textarea?.value || "")[b - 1])) b -= 1;
    return { text: String(textarea?.value || "").slice(a, b), start: a, end: b };
  }

  function relationReferenceIsKnown(refName, meta, ctes) {
    const name = normalizeQualifiedName(refName);
    const parts = name.split(".").filter(Boolean);
    if (!parts.length) return { ok: true };
    if (parts.length > 2) return { ok: false, message: `Invalid table reference '${name}'. Expected table or database.table.` };
    const key = norm(name);
    const last = norm(parts[parts.length - 1] || "");
    if (ctes && (ctes.has(key) || ctes.has(last))) return { ok: true };
    if (parts.length === 2) {
      const [db, table] = parts;
      const tables = tablesForDatabase(meta, db);
      if (tables.some((t) => norm(t.name) === norm(table))) return { ok: true };
      const dbKnown = (Array.isArray(meta?.databases?.items) ? meta.databases.items : []).some((d) => norm(d.name) === norm(db));
      return { ok: false, message: dbKnown ? `Unknown table '${name}'.` : `Unknown database or table '${name}'.` };
    }
    const unique = uniqueTablesByName(meta);
    if (unique.has(norm(parts[0]))) return { ok: true };
    return { ok: false, message: `Unknown table '${name}'. Use database.table if the name is ambiguous.` };
  }

  function aliasDefinedBySelectItem(item) {
    const text = String(item?.text ?? item ?? "");
    const start = Number.isFinite(item?.start) ? item.start : 0;
    const range = findSelectAliasRange(text, start);
    if (!range) return "";
    return stripQuotes(String(text).slice(range.start - start, range.end - start));
  }

  function selectAliasesForSegment(selectList) {
    const set = new Set();
    for (const item of selectList || []) {
      const alias = aliasDefinedBySelectItem(item);
      if (alias) set.add(norm(alias));
    }
    return set;
  }

  function canValidateColumnsForSources(sources, meta, scalarCtes) {
    if (scalarCtes && scalarCtes.size) return true;
    for (const src of sources || []) {
      const cols = sourceColumns(src, meta);
      if (cols && cols.length) return true;
    }
    return false;
  }

  function isKnownReferenceName(name, sourceInfo, meta, scalarCtes, selectAliases, lambdaParams) {
    const q = normalizeQualifiedName(name);
    const parts = q.split(".").filter(Boolean);
    if (!parts.length) return true;
    const first = parts[0];
    if (lambdaParams && lambdaParams.has(norm(first))) return true;
    if (parts.length >= 2) {
      const src = sourceInfo.aliases.get(norm(first));
      if (src) {
        const colPath = parts.slice(1).join(".");
        const cols = sourceColumns(src, meta);
        return cols.some((c) => norm(c.name) === norm(colPath) || norm(c.insertName) === norm(colPath));
      }
      const direct = findColumnInSources(q, sourceInfo.sources, meta);
      if (direct) return true;
      return false;
    }
    if (scalarCtes && scalarCtes.has(norm(q))) return true;
    if (selectAliases && selectAliases.has(norm(q))) return true;
    return !!findColumnInSources(q, sourceInfo.sources, meta);
  }

  function collectIdentifierRefs(exprText, exprStart, meta) {
    const refs = [];
    const masked = maskSql(exprText);
    const re = new RegExp(qualifiedIdentReSource, "g");
    const keywords = autocompleteKeywordSet(meta);
    let m;
    while ((m = re.exec(masked))) {
      const rawMasked = m[0] || "";
      const raw = String(exprText || "").slice(m.index, m.index + rawMasked.length);
      const name = normalizeQualifiedName(raw);
      if (!name) continue;
      const before = masked[m.index - 1] || "";
      const afterIndex = m.index + rawMasked.length;
      const after = masked.slice(afterIndex).match(/^\s*([A-Za-z0-9_$.(]|->)/);
      if (before === ".") continue;
      if (after && after[1] === "(") continue; // function call
      if (keywords.has(norm(name)) || aliasStopWords.has(name.toUpperCase())) continue;
      if (/^\d/.test(name)) continue;
      refs.push({ raw, name, start: exprStart + m.index, end: exprStart + m.index + rawMasked.length });
    }
    return refs;
  }

  function collectSelectReferenceDiagnostics(text, meta) {
    const issues = [];
    const value = String(text || "");
    const masked = maskSql(value);
    const ctes = parseCtes(value, meta);
    const scalarCtes = parseWithScalars(value);
    const re = /\bSELECT\b/gi;
    let m;
    while ((m = re.exec(masked))) {
      const selectPos = m.index;
      const depth = topLevelDepthAt(masked, selectPos);
      const scopeEnd = findSelectScopeEndAtDepth(masked, selectPos, depth);
      const fromPos = findKeywordAtDepth(masked, "FROM", selectPos + 6, depth, scopeEnd);
      if (fromPos < 0) continue; // Do not lint references until the source context exists.
      const scopeText = value.slice(selectPos, scopeEnd);
      const sourceInfo = parseSources(scopeText, meta, 0, ctes);
      if (!canValidateColumnsForSources(sourceInfo.sources, meta, scalarCtes)) continue;
      const selectItems = splitTopLevelWithSpans(value.slice(selectPos + 6, fromPos), selectPos + 6);
      const aliasesBefore = new Set();
      for (const item of selectItems) {
        const span = expressionSpanBeforeAlias(item);
        if (span.text) {
          const lambdaParams = collectLambdaParams(span.text);
          for (const ref of collectIdentifierRefs(span.text, span.start, meta)) {
            if (isKnownReferenceName(ref.name, sourceInfo, meta, scalarCtes, aliasesBefore, lambdaParams)) continue;
            issues.push({
              start: ref.start,
              end: ref.end,
              kind: "unknown_column",
              message: `Unknown column or variable '${normalizeQualifiedName(ref.raw)}' in the current SELECT context.`,
            });
          }
        }

        // ClickHouse lets aliases defined earlier in the same SELECT be reused
        // later in the projection. But a plain identifier (`SELECT foo`) must
        // not be treated as a self-defined alias, otherwise unknown columns like
        // `anchor_valu` silently validate themselves.
        const alias = aliasDefinedBySelectItem(item);
        if (alias) aliasesBefore.add(norm(alias));
      }
    }
    return issues;
  }

  function isKnownFunctionName(meta, name) {
    const n = norm(normalizeQualifiedName(name));
    if (!n) return false;
    const items = Array.isArray(meta?.functions?.items) ? meta.functions.items : [];
    if (items.some((fn) => norm(fn.name) === n)) return true;
    const set = meta?.functions?.set;
    if (set && typeof set.has === "function" && set.has(n)) return true;
    return false;
  }

  function previousWordBefore(masked, index) {
    const part = String(masked || "").slice(0, Math.max(0, index));
    const m = part.match(/([A-Za-z_][A-Za-z0-9_$]*)\s*$/);
    return m ? m[1] : "";
  }

  function collectFunctionDiagnostics(text, meta) {
    const issues = [];
    const value = String(text || "");
    const masked = maskSql(value);
    const re = new RegExp(`${qualifiedIdentReSource}\\s*\\(`, "g");
    const keywords = autocompleteKeywordSet(meta);
    let m;
    while ((m = re.exec(masked))) {
      const rawWithParen = String(value || "").slice(m.index, m.index + (m[0] || "").length);
      const raw = rawWithParen.replace(/\s*\($/, "");
      const name = normalizeQualifiedName(raw);
      if (!name || /^\d/.test(name)) continue;
      if (keywords.has(norm(name)) || aliasStopWords.has(name.toUpperCase())) continue;

      const prev = previousWordBefore(masked, m.index).toUpperCase();
      if (relationStarters.has(prev) || prev === "AS") continue;
      if (isKnownFunctionName(meta, name)) continue;
      if (isKnownTableFunction(meta, name)) continue;

      issues.push({
        start: m.index,
        end: m.index + raw.length,
        kind: "unknown_function",
        message: `Unknown function '${name}' in the current ClickHouse context.`,
      });
    }
    return issues;
  }

  function collectRelationDiagnostics(text, meta) {
    const issues = [];
    const value = String(text || "");
    const masked = maskSql(value);
    const re = /\b(?:FROM|JOIN)\b/gi;
    let m;
    while ((m = re.exec(masked))) {
      let i = re.lastIndex;
      while (i < value.length && /\s/.test(value[i])) i += 1;
      if (value[i] === "(") continue;
      const ref = readIdentifierAt(value, i);
      if (!ref || !ref.name) continue;
      let j = ref.end;
      while (j < value.length && /\s/.test(value[j])) j += 1;
      if (value[j] === ".") continue; // incomplete db. while typing
      if (value[j] === "(" && isKnownTableFunction(meta, ref.name)) continue;
      const statement = currentStatementAt(value, m.index);
      const ctes = parseCtes(statement, meta);
      const known = relationReferenceIsKnown(ref.name, meta, ctes);
      if (!known.ok) issues.push({ start: i + (String(value).slice(i).match(/^\s*/)?.[0]?.length || 0), end: ref.end, kind: "unknown_table", message: known.message });
    }
    return issues;
  }

  function computeDiagnostics(text, meta) {
    if (!isReferenceDiagnosticsEnabled() || !meta) return [];
    const value = String(text || "");
    const masked = maskSql(value);
    const issues = [];
    if (isTableWarningsEnabled()) issues.push(...collectRelationDiagnostics(value, meta));
    if (isColumnWarningsEnabled() && /\bFROM\b/i.test(masked)) issues.push(...collectSelectReferenceDiagnostics(value, meta));
    if (isFunctionWarningsEnabled()) issues.push(...collectFunctionDiagnostics(value, meta));
    issues.sort((a, b) => a.start - b.start || a.end - b.end);
    const dedup = [];
    const seen = new Set();
    for (const issue of issues) {
      if (!Number.isFinite(issue.start) || !Number.isFinite(issue.end) || issue.end <= issue.start) continue;
      const key = `${issue.start}:${issue.end}:${issue.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(issue);
      if (dedup.length >= 200) break;
    }
    return dedup;
  }

  function lineRangeAtIndex(text, index) {
    const value = String(text || "");
    const start = value.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
    let end = value.indexOf("\n", index);
    if (end < 0) end = value.length;
    const before = value.slice(0, start);
    return { start, end, lineIndex: before ? before.split("\n").length - 1 : 0, line: value.slice(start, end) };
  }

  function renderDiagnosticsLayer(issues = currentDiagnostics) {
    const layer = ensureDiagnosticsLayer();
    if (!layer || !textarea || !isReferenceDiagnosticsEnabled()) {
      if (layer) layer.innerHTML = "";
      hideDiagnosticsTooltip();
      return;
    }
    currentDiagnostics = Array.isArray(issues) ? issues : [];
    layer.innerHTML = "";
    hideDiagnosticsTooltip();
    if (!currentDiagnostics.length) return;

    const wrap = textarea.closest ? textarea.closest(".editorWrap") : null;
    const visual = wrap ? wrap.querySelector(".editorHighlight") : null;
    const ref = visual || textarea;
    const cs = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(cs.lineHeight) || 21;
    const padLeft = Number.parseFloat(cs.paddingLeft) || 0;
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const charWidth = measureCharWidth(textarea);
    const value = String(textarea.value || "");
    const minY = -lineHeight;
    const maxY = (textarea.clientHeight || 0) + lineHeight;

    for (const issue of currentDiagnostics) {
      const r = lineRangeAtIndex(value, issue.start);
      if (issue.end > r.end) continue;
      const localStart = Math.max(0, issue.start - r.start);
      const localEnd = Math.max(localStart + 1, issue.end - r.start);
      const token = r.line.slice(localStart, localEnd);
      let top = padTop + r.lineIndex * lineHeight - textarea.scrollTop;
      if (top < minY || top > maxY) continue;
      let left = padLeft + measureRenderedTextWidth(ref, r.line.slice(0, localStart)) - textarea.scrollLeft;
      let width = Math.max(charWidth, measureRenderedTextWidth(ref, token));
      const domRect = highlightedRectForRange(visual, issue.start, issue.end);
      if (domRect && wrap) {
        const wrapRect = wrap.getBoundingClientRect();
        left = domRect.left - wrapRect.left;
        top = domRect.top - wrapRect.top;
        width = Math.max(charWidth, domRect.width);
      }
      const mark = document.createElement("span");
      mark.className = `editorDiagnostic editorDiagnostic--${issue.kind || "warning"}`;
      mark.style.left = `${left.toFixed(2)}px`;
      mark.style.top = `${top.toFixed(2)}px`;
      mark.style.width = `${Math.max(1, width).toFixed(2)}px`;
      mark.style.height = `${Math.ceil(lineHeight)}px`;
      mark.dataset.message = issue.message || "Unknown reference";
      mark.textContent = token || " ";
      mark.addEventListener("mouseenter", () => placeDiagnosticsTooltip(mark));
      mark.addEventListener("mousemove", () => placeDiagnosticsTooltip(mark));
      mark.addEventListener("mouseleave", hideDiagnosticsTooltip);
      layer.appendChild(mark);
    }
  }

  function runDiagnostics() {
    if (!textarea || !isReferenceDiagnosticsEnabled()) {
      clearDiagnostics();
      return;
    }
    const meta = currentHostMeta();
    if (!meta) {
      clearDiagnostics();
      return;
    }
    currentDiagnostics = computeDiagnostics(textarea.value || "", meta);
    renderDiagnosticsLayer(currentDiagnostics);
  }

  function scheduleDiagnostics(immediate = false) {
    if (!textarea) return;
    if (!isReferenceDiagnosticsEnabled()) {
      clearDiagnostics();
      return;
    }
    if (diagnosticsTimer) { clearTimeout(diagnosticsTimer); diagnosticsTimer = 0; }
    if (diagnosticsRaf) { cancelAnimationFrame(diagnosticsRaf); diagnosticsRaf = 0; }
    const delay = immediate ? 0 : 180;
    diagnosticsTimer = setTimeout(() => {
      diagnosticsTimer = 0;
      diagnosticsRaf = requestAnimationFrame(() => {
        diagnosticsRaf = 0;
        runDiagnostics();
      });
    }, delay);
  }

  function visualColumn(line) {
    let col = 0;
    for (const ch of line) {
      if (ch === "\t") col += 4 - (col % 4);
      else col += 1;
    }
    return col;
  }

  let cachedMeasure = null;
  function measureCharWidth(ta) {
    const cs = getComputedStyle(ta);
    const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}`;
    if (cachedMeasure && cachedMeasure.key === key) return cachedMeasure.value;
    const canvas = measureCharWidth.canvas || (measureCharWidth.canvas = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`;
    const value = ctx.measureText("M").width || 8;
    cachedMeasure = { key, value };
    return value;
  }

  function measureRenderedTextWidth(ref, text) {
    const el = ref || textarea;
    if (!el) return 0;
    const cs = getComputedStyle(el);
    const probe = measureRenderedTextWidth.probe || (measureRenderedTextWidth.probe = document.createElement("span"));
    if (!probe.isConnected) document.body.appendChild(probe);

    probe.className = "autocompleteGhost__measure";
    probe.style.position = "absolute";
    probe.style.left = "-100000px";
    probe.style.top = "-100000px";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.whiteSpace = "pre";
    probe.style.font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`;
    probe.style.letterSpacing = cs.letterSpacing || "0";
    probe.style.fontKerning = "none";
    probe.style.fontVariantLigatures = "none";
    probe.style.fontFeatureSettings = '"liga" 0, "calt" 0';
    probe.style.tabSize = cs.tabSize || "4";
    probe.style.MozTabSize = cs.MozTabSize || "4";
    // Use the same highlighter HTML as the visible layer. This avoids a one
    // character drift when token spans later get a slightly different visual
    // style than plain textarea text.
    probe.innerHTML = highlightedSegment(String(text || "")) || "";
    return probe.getBoundingClientRect().width || 0;
  }

  function caretPointForPosition(ta, pos) {
    const before = String(ta.value || "").slice(0, pos);
    const lines = before.split("\n");
    const row = Math.max(0, lines.length - 1);
    const col = visualColumn(lines[row] || "");
    const cs = getComputedStyle(ta);
    const rect = ta.getBoundingClientRect();
    const lineHeight = Number.parseFloat(cs.lineHeight) || 21;
    const padLeft = Number.parseFloat(cs.paddingLeft) || 0;
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const charWidth = measureCharWidth(ta);
    return {
      left: rect.left + padLeft + col * charWidth - ta.scrollLeft,
      top: rect.top + padTop + row * lineHeight - ta.scrollTop,
      lineHeight,
      rect,
    };
  }


  function textNodeRangeRectForChar(root, charIndex) {
    if (!root || !Number.isFinite(charIndex) || charIndex < 0) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || "";
      const next = offset + text.length;
      if (charIndex >= offset && charIndex < next) {
        const local = charIndex - offset;
        const range = document.createRange();
        try {
          range.setStart(node, local);
          range.setEnd(node, Math.min(text.length, local + 1));
          const rects = range.getClientRects();
          const rect = rects && rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
          range.detach?.();
          if (rect && Number.isFinite(rect.right) && Number.isFinite(rect.top) && rect.width >= 0) return rect;
        } catch (_) {
          try { range.detach?.(); } catch (_) {}
        }
        return null;
      }
      offset = next;
    }
    return null;
  }

  function textNodeRangeRectForRange(root, startIndex, endIndex) {
    if (!root || !Number.isFinite(startIndex) || !Number.isFinite(endIndex) || endIndex <= startIndex) return null;
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let offset = 0;
    let node;
    let startSet = false;
    try {
      while ((node = walker.nextNode())) {
        const text = node.nodeValue || "";
        const next = offset + text.length;
        if (!startSet && startIndex >= offset && startIndex <= next) {
          range.setStart(node, Math.max(0, Math.min(text.length, startIndex - offset)));
          startSet = true;
        }
        if (startSet && endIndex >= offset && endIndex <= next) {
          range.setEnd(node, Math.max(0, Math.min(text.length, endIndex - offset)));
          const rects = Array.from(range.getClientRects()).filter((r) => r && r.width > 0 && r.height > 0);
          const rect = rects.length ? rects[0] : range.getBoundingClientRect();
          range.detach?.();
          return rect && Number.isFinite(rect.left) ? rect : null;
        }
        offset = next;
      }
    } catch (_) {
      try { range.detach?.(); } catch (_) {}
      return null;
    }
    try { range.detach?.(); } catch (_) {}
    return null;
  }

  function highlightedRectForRange(highlight, startIndex, endIndex) {
    const rect = textNodeRangeRectForRange(highlight, startIndex, endIndex);
    if (!rect) return null;
    return rect;
  }

  function highlightedEndPointForIndex(highlight, absoluteIndex) {
    if (!highlight || !Number.isFinite(absoluteIndex) || absoluteIndex <= 0) return null;
    // Measure the previous rendered character in the highlight layer and use
    // its right edge. This is more accurate than textarea char-width math and
    // removes the one-character gap on suffix-only ghost completions.
    let idx = Math.min(absoluteIndex - 1, Math.max(0, (highlight.textContent || "").length - 1));
    let rect = textNodeRangeRectForChar(highlight, idx);
    // If the previous character is a newline or produces no rect, walk back to
    // the nearest visible character on the same rendered line.
    while ((!rect || !rect.width) && idx > 0) {
      idx -= 1;
      rect = textNodeRangeRectForChar(highlight, idx);
    }
    if (!rect) return null;
    return { left: rect.right, top: rect.top, height: rect.height || 0 };
  }

  function highlightedStartPointForIndex(highlight, absoluteIndex) {
    if (!highlight || !Number.isFinite(absoluteIndex) || absoluteIndex < 0) return null;
    const textLen = Math.max(0, (highlight.textContent || "").length);
    if (!textLen) return null;
    let idx = Math.min(absoluteIndex, textLen - 1);
    let rect = textNodeRangeRectForChar(highlight, idx);
    // If the token starts on a non-rendered position, walk forward to the next
    // visible character first, then backward as a last fallback. The important
    // part is that we anchor the preview on the rendered token start, never on
    // the preview prefix width. Otherwise long missing prefixes visually pull
    // the ghost to the left by their own length.
    let fwd = idx;
    while ((!rect || !rect.width) && fwd < textLen - 1) {
      fwd += 1;
      rect = textNodeRangeRectForChar(highlight, fwd);
    }
    let back = idx;
    while ((!rect || !rect.width) && back > 0) {
      back -= 1;
      rect = textNodeRangeRectForChar(highlight, back);
    }
    if (!rect) return null;
    return { left: rect.left, top: rect.top, height: rect.height || 0 };
  }

  function isAnchorVisible(ta) {
    if (!replaceRange) return true;
    const start = caretPointForPosition(ta, replaceRange.start);
    const end = caretPointForPosition(ta, replaceRange.end);
    const rect = start.rect;
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.top + start.lineHeight, end.top + end.lineHeight);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.left, end.left);
    const inset = 3;
    const inEditor = top >= rect.top + inset && bottom <= rect.bottom - inset && right >= rect.left + inset && left <= rect.right - inset;
    if (!inEditor) return false;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return bottom >= inset && top <= vh - inset && right >= inset && left <= vw - inset;
  }

  function positionMenu(ta) {
    const m = ensureMenu();
    if (!isAnchorVisible(ta)) {
      close();
      return false;
    }

    const pos = ta.selectionStart || 0;
    const point = caretPointForPosition(ta, pos);
    const rect = point.rect;

    let left = point.left;
    let top = point.top + point.lineHeight + 5;

    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const w = Math.min(960, Math.max(420, m.offsetWidth || 540));
    const h = Math.min(360, Math.max(160, m.offsetHeight || 240));

    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    if (top + h > vh - 8) top = Math.max(8, point.top - h - 5);
    if (!Number.isFinite(left)) left = rect.left;
    if (!Number.isFinite(top)) top = rect.bottom;

    m.style.left = `${Math.round(left)}px`;
    m.style.top = `${Math.round(top)}px`;
    return true;
  }

  function estimateSuggestionWidthPx(items) {
    const charPx = textarea ? measureCharWidth(textarea) : 8;
    let maxLabelChars = 0;
    let maxBadgeChars = 0;
    for (const s of items || []) {
      maxLabelChars = Math.max(maxLabelChars, visualColumn(String(s.label || "")));
      const badgeChars = defaultBadgesForSuggestion(s).reduce((n, b) => n + Math.max(4, visualColumn(String(b || ""))) + 2, 0);
      maxBadgeChars = Math.max(maxBadgeChars, badgeChars);
    }
    const typeBadge = 48;
    const gapsAndPadding = 64;
    const wanted = Math.ceil(typeBadge + maxLabelChars * charPx + maxBadgeChars * (charPx * 0.64) + gapsAndPadding);
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const minW = Math.min(360, Math.max(260, vw - 16));
    const maxW = Math.max(minW, Math.min(1180, Math.floor(vw * 0.86)));
    return Math.max(minW, Math.min(maxW, wanted));
  }

  function renderMenu(ta, items, token, totalAvailable = 0) {
    const m = ensureMenu();
    suggestions = items || [];
    replaceRange = token ? { start: token.replaceStart, end: token.replaceEnd } : null;
    const moreCount = Math.max(0, Number(totalAvailable || 0) - suggestions.length);
    activeIndex = Math.max(0, Math.min(activeIndex, suggestions.length - 1));
    // Suggestions are about to be rebuilt. Any ghost preview from the previous
    // menu is now stale until the current pointer position is reconciled against
    // the new rows. This prevents an old hovered suggestion from staying painted
    // while the user types a non-matching character.
    hideGhost();

    if (!suggestions.length) {
      close();
      return;
    }

    m.innerHTML = "";
    suggestions.forEach((s, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "autocompleteItem";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === activeIndex));
      row.dataset.index = String(index);

      const typeBadge = document.createElement("span");
      typeBadge.className = `autocompleteItem__badge autocompleteItem__badge--type autocompleteItem__badge--${s.kind || "generic"}`;
      typeBadge.textContent = kindBadgeText(s.kind);

      const label = document.createElement("span");
      label.className = "autocompleteItem__label";
      const labelText = document.createElement("span");
      labelText.className = "autocompleteItem__labelText";

      const labelName = document.createElement("span");
      labelName.className = "autocompleteItem__labelName";
      labelName.textContent = s.label;
      labelText.appendChild(labelName);

      const source = String(s.sourceLabel || "");
      if (s.kind === "column" && source) {
        const sourceText = document.createElement("span");
        sourceText.className = "autocompleteItem__source";
        sourceText.textContent = ` ${source}`;
        labelText.appendChild(sourceText);
      }

      labelText.setAttribute("data-marquee", `${String(s.label || "")}${source ? ` ${source}` : ""}`);
      label.appendChild(labelText);

      const badges = document.createElement("span");
      badges.className = "autocompleteItem__badges";
      for (const badgeText of defaultBadgesForSuggestion(s)) {
        const badge = document.createElement("span");
        badge.className = `autocompleteItem__badge autocompleteItem__badge--meta autocompleteItem__badge--${s.kind || "generic"} autocompleteItem__badge--tag-${badgeClassSuffix(badgeText)}`;
        badge.textContent = badgeText;
        badges.appendChild(badge);
      }

      row.appendChild(typeBadge);
      row.appendChild(label);
      row.appendChild(badges);
      row.addEventListener("pointerenter", () => {
        activeIndex = index;
        setActive(index, false);
        showGhostForSuggestion(s);
      });
      row.addEventListener("pointerleave", () => {
        hideGhost();
      });
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        commit(index);
      });
      m.appendChild(row);
    });

    if (moreCount > 0) {
      const more = document.createElement("div");
      more.className = "autocompleteMore";
      more.textContent = `${moreCount} more`;
      m.appendChild(more);
    }

    m.style.width = `${estimateSuggestionWidthPx(suggestions)}px`;
    m.hidden = false;
    if (!positionMenu(ta)) return;
    requestAnimationFrame(() => {
      m.style.width = `${estimateSuggestionWidthPx(suggestions)}px`;
      positionMenu(ta);
      for (const label of m.querySelectorAll(".autocompleteItem__label")) {
        const inner = label.querySelector(".autocompleteItem__labelText");
        if (inner && inner.scrollWidth > label.clientWidth + 2) {
          const shift = Math.ceil((inner.scrollWidth / 2) || (inner.scrollWidth - label.clientWidth + 16));
          label.style.setProperty("--ac-label-shift", `${shift}px`);
          label.style.setProperty("--ac-label-duration", `${Math.max(1.2, shift / 28).toFixed(2)}s`);
          label.classList.add("is-overflowing");
        } else {
          label.style.removeProperty("--ac-label-shift");
          label.style.removeProperty("--ac-label-duration");
          label.classList.remove("is-overflowing");
        }
      }
      syncGhostWithPointer();
    });
  }

  function ensureGhost() {
    const wrap = textarea && textarea.closest ? textarea.closest(".editorWrap") : null;
    if (!wrap) return null;
    let g = wrap.querySelector(".autocompleteGhost");
    if (!g) {
      g = document.createElement("div");
      g.className = "autocompleteGhost";
      g.setAttribute("aria-hidden", "true");
      wrap.appendChild(g);
    }
    return g;
  }

  function hideGhost() {
    ghostKey = "";
    if (ghostFrame) {
      cancelAnimationFrame(ghostFrame);
      ghostFrame = 0;
    }
    const wrap = textarea && textarea.closest ? textarea.closest(".editorWrap") : null;
    if (wrap) wrap.classList.remove("autocompleteGhostActive");
    const g = wrap ? wrap.querySelector(".autocompleteGhost") : null;
    if (g) {
      g.hidden = true;
      g.innerHTML = "";
    }
  }

  function lineBoundsForIndex(value, index) {
    const text = String(value || "");
    const pos = Math.max(0, Math.min(text.length, index));
    const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl >= 0 ? nl : text.length;
    return { lineStart, lineEnd, line: text.slice(lineStart, lineEnd) };
  }

  function highlightedSegment(text) {
    const raw = String(text || "");
    if (!raw) return "";
    if (ns.highlight && typeof ns.highlight.toHtml === "function") return ns.highlight.toHtml(raw);
    if (ns.util && typeof ns.util.escapeHtml === "function") return ns.util.escapeHtml(raw);
    return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function setHighlightedText(node, text) {
    node.innerHTML = highlightedSegment(text);
  }

  function splitReplacementPreview(s, start, end, preparedInsert) {
    const value = String(textarea?.value || "");
    const typedRaw = value.slice(start, end).replace(/^`|`$/g, "");
    const insert = String(preparedInsert || "");
    const insertForMatch = insert.replace(/^`|`$/g, "");
    const hasQuotedIdentifier = insert.startsWith("`") && insert.endsWith("`");
    const quotePrefix = hasQuotedIdentifier ? "`" : "";
    const quoteSuffix = hasQuotedIdentifier ? "`" : "";
    const candidate = hasQuotedIdentifier ? insert.slice(1, -1) : insert;
    const candidateForMatch = hasQuotedIdentifier ? insertForMatch : candidate;
    const idx = typedRaw ? norm(candidateForMatch).indexOf(norm(typedRaw)) : -1;
    const matchIndex = idx >= 0 ? idx : -1;

    if (matchIndex < 0 || !typedRaw) {
      return { before: quotePrefix + candidate + quoteSuffix, match: "", after: "" };
    }
    return {
      before: quotePrefix + candidate.slice(0, matchIndex),
      match: candidate.slice(matchIndex, matchIndex + typedRaw.length),
      after: candidate.slice(matchIndex + typedRaw.length) + quoteSuffix,
    };
  }

  function showGhostForSuggestion(s) {
    if (!textarea || !replaceRange || !s) return;
    const start = Number.isFinite(s.replaceStart) ? s.replaceStart : replaceRange.start;
    const end = Number.isFinite(s.replaceEnd) ? s.replaceEnd : replaceRange.end;
    if (start == null || end == null || start > end) return;
    if (!isAnchorVisible(textarea)) {
      hideGhost();
      return;
    }

    const value = String(textarea.value || "");
    const bounds = lineBoundsForIndex(value, start);
    const originalLine = bounds.line;
    const prepared = insertionForSuggestion(s, start, end);
    const insert = prepared.insert;
    const localStart = start - bounds.lineStart;
    const localEnd = end - bounds.lineStart;
    const lineAfter = originalLine.slice(localEnd);
    const preview = splitReplacementPreview(s, start, end, insert);

    // Hybrid ghost mode:
    // - prefix match, e.g. `num` -> `numeric...`: keep the already typed token
    //   rendered by the normal highlighter and only ghost the suffix from the
    //   cursor. This avoids tiny baseline/left drifts on duplicated text.
    // - partial match, e.g. `number` -> `row_number`: start at the token
    //   beginning so the missing prefix (`row_`) is visible.
    const suffixOnlyFromTokenEnd = preview.before.length === 0 && preview.match.length > 0;
    const ghostAnchorLocal = suffixOnlyFromTokenEnd ? localEnd : localStart;
    const ghostTailText = suffixOnlyFromTokenEnd
      ? `${preview.after}${lineAfter}`
      : `${preview.before}${preview.match}${preview.after}${lineAfter}`;

    // Do not rewrite long lines; it is expensive and visually noisy.
    if (Math.max(originalLine.length, ghostAnchorLocal + ghostTailText.length) > 100) {
      hideGhost();
      return;
    }

    const key = `${start}:${end}:${insert}:tail:${suffixOnlyFromTokenEnd ? 1 : 0}:${textarea.scrollLeft}:${textarea.scrollTop}:${value.length}`;
    if (key === ghostKey) return;
    ghostKey = key;

    if (ghostFrame) cancelAnimationFrame(ghostFrame);
    ghostFrame = requestAnimationFrame(() => {
      ghostFrame = 0;
      if (!textarea || key !== ghostKey || !isAnchorVisible(textarea)) return;
      const g = ensureGhost();
      if (!g) return;

      const wrap = textarea.closest(".editorWrap");
      const highlight = wrap ? wrap.querySelector(".editorHighlight") : null;
      const visualEl = highlight || textarea;
      const cs = getComputedStyle(visualEl);
      const lineHeight = parseFloat(cs.lineHeight) || measureLineHeight(visualEl);
      const padLeft = Number.parseFloat(cs.paddingLeft) || 0;
      const padTop = Number.parseFloat(cs.paddingTop) || 0;
      const padRight = Number.parseFloat(cs.paddingRight) || 0;
      const scrollLeft = Number.isFinite(visualEl.scrollLeft) ? visualEl.scrollLeft : textarea.scrollLeft;
      const scrollTop = Number.isFinite(visualEl.scrollTop) ? visualEl.scrollTop : textarea.scrollTop;
      const wrapRect = wrap ? wrap.getBoundingClientRect() : textarea.getBoundingClientRect();
      const visualRect = visualEl.getBoundingClientRect();
      const layerLeft = visualRect.left - wrapRect.left;
      const layerTop = visualRect.top - wrapRect.top;
      const lineIndex = value.slice(0, bounds.lineStart).split("\n").length - 1;
      const charWidth = measureCharWidth(visualEl || textarea);
      // The ghost text must sit on the same line box as .editorHighlight, not
      // on the glyph rect returned by Range.getClientRects(). Glyph rects are
      // lower than the line box in Chromium and created the small downward
      // drift, especially for suffix-only previews. Keep X from the DOM when
      // needed, but always use this common line-top for Y.
      const baseLineTop = layerTop + padTop + lineIndex * lineHeight - scrollTop;
      const ghostTop = Math.round(baseLineTop) - 1;

      // Anchor the ghost exactly where the visual replacement starts. For a
      // normal prefix completion this is the end of the already typed token;
      // for a partial-match completion this is the beginning of the token so
      // a missing prefix can be shown.
      let tokenPrefixWidth;
      let tokenLeft;
      let top;
      if (suffixOnlyFromTokenEnd) {
        // For pure prefix completions (`num` -> `numeric...`) the ghost starts
        // immediately after the real token. Use the rendered highlight DOM
        // instead of textarea/canvas metrics so the suffix has no 1ch gap and
        // shares the exact same baseline as the visible text.
        const renderedPoint = highlightedEndPointForIndex(highlight, end);
        tokenPrefixWidth = measureRenderedTextWidth(visualEl || textarea, originalLine.slice(0, localEnd));
        if (renderedPoint) {
          tokenLeft = renderedPoint.left - wrapRect.left;
        } else {
          const caretPoint = caretPointForPosition(textarea, end);
          tokenLeft = caretPoint.left - wrapRect.left;
        }
        top = ghostTop;
      } else {
        const tokenPrefix = originalLine.slice(0, ghostAnchorLocal);
        tokenPrefixWidth = measureRenderedTextWidth(visualEl || textarea, tokenPrefix);

        if (start === end) {
          // Empty-token previews are used for the special blank SELECT slot:
          //   SELECT |
          //   FROM t
          // The preview should start exactly at the caret. This keeps the first
          // letter of a long completion aligned with the cursor instead of
          // erasing/covering characters before it.
          const caretPoint = caretPointForPosition(textarea, start);
          // Empty projection-slot previews are visually inserted before the
          // caret position. The native caret is drawn after the previous
          // whitespace cell, so anchoring exactly on caretPoint.left makes the
          // first ghost character look one column too far to the right. Shift
          // one rendered character left, but never before the editable text
          // area.
          const minTextLeft = layerLeft + padLeft - scrollLeft;
          tokenLeft = Math.max(minTextLeft, caretPoint.left - wrapRect.left - charWidth);
        } else {
          const renderedStart = highlightedStartPointForIndex(highlight, start);
          if (renderedStart) {
            tokenLeft = renderedStart.left - wrapRect.left;
          } else {
            tokenLeft = layerLeft + padLeft + tokenPrefixWidth - scrollLeft;
          }
        }

        // Keep available width based on the actual visual anchor. This prevents
        // a long missing prefix from influencing the left position of the ghost.
        tokenPrefixWidth = Math.max(0, tokenLeft - layerLeft - padLeft + scrollLeft);
        top = ghostTop;
      }
      const availableWidth = Math.max(
        0,
        Math.max(visualEl.scrollWidth || 0, visualEl.clientWidth || 0, textarea.scrollWidth || 0)
          - padLeft - padRight - tokenPrefixWidth + 96
      );
      const tailText = ghostTailText;
      const tailWidth = Math.ceil(measureRenderedTextWidth(visualEl || textarea, `${tailText}  `)) + 16 || Math.ceil((tailText.length + 2) * charWidth) + 16;
      // The ghost background must never cover the native scrollbar area. If it
      // reaches the scrollbar gutter, Chromium paints the scrollbar in chunks
      // above and below the ghost line. Clamp to the visible content box; long
      // tails can still be read through the completion menu itself.
      const visualClientWidth = visualEl.clientWidth || textarea.clientWidth || wrap?.clientWidth || 0;
      const safeRight = layerLeft + visualClientWidth - 3;
      const maxVisibleWidth = Math.max(24, safeRight - tokenLeft);
      const width = Math.min(Math.max(availableWidth, tailWidth), maxVisibleWidth);

      g.innerHTML = "";
      g.style.lineHeight = `${lineHeight}px`;
      g.style.font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} / ${lineHeight}px ${cs.fontFamily}`;

      const line = document.createElement("span");
      line.className = "autocompleteGhost__line autocompleteGhost__line--tail";
      line.style.left = `${Number(tokenLeft).toFixed(3)}px`;
      line.style.top = `${Number(top).toFixed(3)}px`;
      line.style.width = `${Math.ceil(width)}px`;
      line.style.height = `${Math.ceil(lineHeight)}px`;
      line.style.lineHeight = `${lineHeight}px`;

      if (!suffixOnlyFromTokenEnd) {
        const missingBefore = document.createElement("span");
        missingBefore.className = "autocompleteGhost__missing autocompleteGhost__missing--before";
        setHighlightedText(missingBefore, preview.before);

        const typed = document.createElement("span");
        typed.className = "autocompleteGhost__typed";
        setHighlightedText(typed, preview.match || value.slice(start, end));

        line.appendChild(missingBefore);
        line.appendChild(typed);
      }

      const missingAfter = document.createElement("span");
      missingAfter.className = "autocompleteGhost__missing autocompleteGhost__missing--after";
      setHighlightedText(missingAfter, preview.after);

      const after = document.createElement("span");
      after.className = "autocompleteGhost__context autocompleteGhost__context--after";
      setHighlightedText(after, lineAfter);

      line.appendChild(missingAfter);
      line.appendChild(after);
      g.appendChild(line);
      g.hidden = false;
      if (wrap) wrap.classList.add("autocompleteGhostActive");
    });
  }

  function update(explicit = false) {
    if (!textarea) return;
    if (!isAutocompleteEnabled()) {
      close();
      return;
    }
    lastExplicit = explicit;
    const value = String(textarea.value || "");
    const hostMeta = currentHostMeta();
    const columnsLoaded = Array.isArray(hostMeta?.columns?.items);
    if (!columnsLoaded && ns.meta && typeof ns.meta.ensureColumns === "function" &&
        (explicit || /\b(?:from|join|into|update|table)\b/i.test(value))) {
      // Fire-and-refresh: the current completion stays responsive and refresh()
      // is called when metadata arrives. The request itself is de-duplicated.
      ns.meta.ensureColumns();
    }
    const pos = textarea.selectionStart || 0;
    const keySlice = value.slice(Math.max(0, pos - 160), Math.min(value.length, pos + 160));
    const updateKey = `${explicit ? 1 : 0}|${pos}|${textarea.selectionEnd || 0}|${value.length}|${keySlice}`;
    if (updateKey === lastUpdateKey && isOpen()) {
      positionMenu(textarea);
      return;
    }
    lastUpdateKey = updateKey;
    const built = buildSuggestions(textarea, explicit);
    renderMenu(textarea, built.items, built.token, built.totalAvailable);
  }

  function close() {
    cancelScheduledUpdate();
    suggestions = [];
    replaceRange = null;
    lastUpdateKey = "";
    hideGhost();
    if (menu) menu.hidden = true;
  }

  function scheduleClose() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = 0;
      close();
    }, 120);
  }

  function isOpen() {
    return !!(menu && !menu.hidden && suggestions.length);
  }

  function refresh() {
    if (isOpen()) update(lastExplicit);
    scheduleDiagnostics(false);
  }

  function setActive(next, scrollIntoView = true) {
    if (!isOpen()) return;
    activeIndex = (next + suggestions.length) % suggestions.length;
    const rows = menu.querySelectorAll(".autocompleteItem");
    rows.forEach((row, i) => row.setAttribute("aria-selected", String(i === activeIndex)));
    const active = rows[activeIndex];
    if (scrollIntoView && active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
    if (suggestions[activeIndex]) showGhostForSuggestion(suggestions[activeIndex]);
  }

  function needsBackticks(name) {
    const s = String(name || "");
    return s.includes(".") || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);
  }

  function quoteClickHouseIdentifier(name) {
    const s = String(name || "");
    return `\`${s.replace(/`/g, "``")}\``;
  }

  function insertionForSuggestion(s, rangeStart, rangeEnd) {
    const raw = String(s.insert || s.label || "");
    let insert = raw;
    let cursorDelta = insert.length;
    const value = String(textarea?.value || "");

    if (s.kind === "function") {
      if (needsBackticks(raw)) insert = quoteClickHouseIdentifier(raw);
      const nextParen = value.slice(rangeEnd).match(/^\s*\(/);
      if (!nextParen) {
        insert += "()";
        cursorDelta = insert.length - 1;
      } else {
        cursorDelta = insert.length;
      }
    }

    // If completion is inserted just before another identifier (`SELECT |FROM`,
    // `SELECT a,|FROM`, etc.), keep the resulting SQL tokenized. Without this,
    // completing `number` immediately before `from` produced `numberfrom`.
    const nextChar = value[rangeEnd] || "";
    const prevChar = value[Math.max(0, rangeStart - 1)] || "";
    const needsSpaceAfter = /[A-Za-z0-9_$`]/.test(nextChar) && insert && !/\s$/.test(insert) && !/[.(]$/.test(insert);
    const needsSpaceBefore = /[A-Za-z0-9_$`]/.test(prevChar) && insert && !/^\s/.test(insert) && !/^[.)]/.test(insert);
    if (needsSpaceBefore) {
      insert = ` ${insert}`;
      cursorDelta += 1;
    }
    if (needsSpaceAfter) {
      const cursorBeforePadding = cursorDelta;
      insert += " ";
      cursorDelta = cursorBeforePadding + (s.kind === "function" && !value.slice(rangeEnd).match(/^\s*\(/) ? 0 : 1);
    }

    return { insert, cursorDelta };
  }

  function dispatchInputEvent(el) {
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      try { el.dispatchEvent(new Event("input")); } catch { null; }
    }
  }

  function syncHighlightScrollSoon() {
    const ctrl = state && state.highlightCtrl;
    if (ctrl && typeof ctrl.refresh === "function") {
      try { ctrl.refresh(); } catch { null; }
      return;
    }
    try { textarea.dispatchEvent(new Event("scroll")); } catch { null; }
  }

  function restoreEditorScroll(left, top) {
    if (!textarea) return;
    textarea.scrollLeft = left;
    textarea.scrollTop = top;
    const wrap = textarea.closest ? textarea.closest(".editorWrap") : null;
    const pre = wrap ? wrap.querySelector(".editorHighlight") : null;
    const gutter = wrap ? wrap.querySelector(".editorGutter") : null;
    if (pre) {
      pre.scrollLeft = left;
      pre.scrollTop = top;
    }
    if (gutter) gutter.scrollTop = top;
  }

  function commit(index = activeIndex) {
    if (!textarea || !isOpen()) return false;
    const s = suggestions[index];
    if (!s || !replaceRange) return false;
    const start = Number.isFinite(s.replaceStart) ? s.replaceStart : replaceRange.start;
    const end = Number.isFinite(s.replaceEnd) ? s.replaceEnd : replaceRange.end;
    const prepared = insertionForSuggestion(s, start, end);
    const insert = prepared.insert;
    const finalPos = start + prepared.cursorDelta;
    const keepScrollLeft = textarea.scrollLeft;
    const keepScrollTop = textarea.scrollTop;
    textarea.focus();
    try {
      textarea.setSelectionRange(start, end);
      const ok = document.execCommand && document.execCommand("insertText", false, insert);
      if (!ok) throw new Error("execCommand failed");
      textarea.setSelectionRange(finalPos, finalPos);
    } catch {
      const value = String(textarea.value || "");
      textarea.value = value.slice(0, start) + insert + value.slice(end);
      textarea.selectionStart = finalPos;
      textarea.selectionEnd = finalPos;
      dispatchInputEvent(textarea);
    }
    dispatchInputEvent(textarea);

    // setSelectionRange()/insertText can make the native textarea auto-scroll
    // horizontally to the replacement/caret. The visible layer is a separate
    // highlighted <pre>, so keep both layers on the same scroll position.
    restoreEditorScroll(keepScrollLeft, keepScrollTop);
    requestAnimationFrame(() => {
      restoreEditorScroll(keepScrollLeft, keepScrollTop);
      syncHighlightScrollSoon();
    });

    close();
    return true;
  }

  let updateTimer = 0;
  let updateRaf = 0;

  function cancelScheduledUpdate() {
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = 0; }
    if (updateRaf) { cancelAnimationFrame(updateRaf); updateRaf = 0; }
  }

  function scheduleUpdate(explicit = false) {
    if (!isAutocompleteEnabled()) {
      close();
      return;
    }
    if (explicit) {
      cancelScheduledUpdate();
      update(true);
      return;
    }
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = 0;
      if (updateRaf) cancelAnimationFrame(updateRaf);
      updateRaf = requestAnimationFrame(() => {
        updateRaf = 0;
        update(false);
      });
    }, 45);
  }

  function attach(ta) {
    if (!ta) return null;
    textarea = ta;
    ensureMenu();
    ensureAutocompleteControl();

    ta.addEventListener("keydown", (ev) => {
      if (ev.isComposing) return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key === " ") {
        ev.preventDefault();
        if (isAutocompleteEnabled()) scheduleUpdate(true);
        return;
      }
      if (!isOpen()) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setActive(activeIndex + 1);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setActive(activeIndex - 1);
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        commit(activeIndex);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    }, true);

    ta.addEventListener("input", () => {
      hideGhost();
      scheduleUpdate(false);
      scheduleDiagnostics(false);
    });
    ta.addEventListener("click", () => scheduleUpdate(false));
    ta.addEventListener("keyup", (ev) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(ev.key)) scheduleUpdate(false);
    });
    ta.addEventListener("scroll", () => {
      // Scrolling inside the SQL editor means the anchor can move out of view or change line metrics.
      // Close instead of trying to chase it; global page scroll still repositions the menu.
      if (isOpen()) close();
      else hideGhost();
      renderDiagnosticsLayer();
    }, { passive: true });
    ta.addEventListener("blur", scheduleClose);
    window.addEventListener("resize", () => {
      if (isOpen()) positionMenu(ta);
      renderDiagnosticsLayer();
    });
    window.addEventListener("scroll", () => {
      if (isOpen()) positionMenu(ta);
      renderDiagnosticsLayer();
    }, true);
    document.addEventListener("mousedown", (ev) => {
      const target = ev.target instanceof Node ? ev.target : null;
      if (autocompleteControl && target && !autocompleteControl.contains(target)) closeAutocompleteControlMenu();
      if (!menu || menu.hidden) return;
      if (target && (menu.contains(target) || ta.contains(target))) return;
      close();
    });

    scheduleDiagnostics(true);

    return {
      refresh,
      close,
      update,
      setEnabled: setAutocompleteEnabled,
      isEnabled: isAutocompleteEnabled,
      setPartialMatchEnabled: setAutocompletePartialEnabled,
      isPartialMatchEnabled: isAutocompletePartialEnabled,
      setReferenceDiagnosticsEnabled,
      isReferenceDiagnosticsEnabled,
    };
  }

  ns.autocomplete = {
    attach,
    refresh,
    close,
    update,
    setEnabled: setAutocompleteEnabled,
    isEnabled: isAutocompleteEnabled,
    setPartialMatchEnabled: setAutocompletePartialEnabled,
    isPartialMatchEnabled: isAutocompletePartialEnabled,
    setReferenceDiagnosticsEnabled,
    isReferenceDiagnosticsEnabled,
  };
})();
