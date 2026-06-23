(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { storage } = ns;
  if (!storage) return;

  // ---------------------------------------------------------------------------
  // Saved-query provider: a flat node list (folders + queries) with parentId
  // references, persisted in localStorage. The same provider shape will back the
  // shared library later (async), so the renderer only talks to this interface.
  // ---------------------------------------------------------------------------
  const COLLAPSED_KEY = "chdash.savedTree.collapsed.v1";

  const loadCollapsed = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch {
      return new Set();
    }
  };
  const saveCollapsed = (set) => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set)));
    } catch {
      /* ignore */
    }
  };

  const sortNodes = (nodes) =>
    nodes.slice().sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.name).localeCompare(String(b.name));
    });

  const savedProvider = {
    _load() {
      return storage.loadSavedTree().nodes;
    },
    _save(nodes) {
      storage.saveSavedTree({ version: 1, nodes });
    },
    list() {
      return this._load();
    },
    childrenOf(parentId) {
      const pid = parentId == null ? null : String(parentId);
      return sortNodes(this._load().filter((n) => (n.parentId == null ? null : String(n.parentId)) === pid));
    },
    _reindex(nodes, parentId) {
      const kids = sortNodes(nodes.filter((n) => (n.parentId ?? null) === (parentId ?? null)));
      kids.forEach((n, i) => {
        n.order = i;
      });
    },
    addFolder(name, parentId) {
      const nodes = this._load();
      const node = {
        id: storage.genNodeId(),
        type: "folder",
        name: String(name || "New folder"),
        parentId: parentId ?? null,
        order: this.childrenOf(parentId).length,
      };
      nodes.push(node);
      this._save(nodes);
      return node.id;
    },
    addQuery(data, parentId) {
      const nodes = this._load();
      const node = {
        id: storage.genNodeId(),
        type: "query",
        name: String(data.name || "Untitled query"),
        parentId: parentId ?? null,
        order: this.childrenOf(parentId).length,
        sql_raw: String(data.sql_raw || ""),
        sql_formatted: String(data.sql_formatted || data.sql_raw || ""),
        host_id: data.host_id == null ? null : String(data.host_id),
        created_at_ms: typeof data.created_at_ms === "number" ? data.created_at_ms : Date.now(),
      };
      nodes.push(node);
      this._save(nodes);
      return node.id;
    },
    rename(id, name) {
      const nodes = this._load();
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      node.name = String(name || node.name);
      this._save(nodes);
    },
    isDescendant(ancestorId, nodeId) {
      if (ancestorId === nodeId) return true;
      const nodes = this._load();
      const byId = new Map(nodes.map((n) => [n.id, n]));
      let cur = byId.get(nodeId);
      while (cur && cur.parentId != null) {
        if (cur.parentId === ancestorId) return true;
        cur = byId.get(cur.parentId);
      }
      return false;
    },
    move(id, newParentId, beforeId) {
      const nodes = this._load();
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      const targetParent = newParentId ?? null;
      // Block moving a folder into itself or one of its descendants.
      if (node.type === "folder" && targetParent != null && this.isDescendant(id, targetParent)) return;

      node.parentId = targetParent;
      this._reindex(nodes, targetParent);

      const siblings = sortNodes(nodes.filter((n) => (n.parentId ?? null) === targetParent && n.id !== id));
      let insertAt = siblings.length;
      if (beforeId) {
        const idx = siblings.findIndex((n) => n.id === beforeId);
        if (idx >= 0) insertAt = idx;
      }
      siblings.splice(insertAt, 0, node);
      siblings.forEach((n, i) => {
        n.order = i;
      });
      this._save(nodes);
    },
    remove(id) {
      const nodes = this._load();
      const toRemove = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of nodes) {
          if (n.parentId != null && toRemove.has(n.parentId) && !toRemove.has(n.id)) {
            toRemove.add(n.id);
            grew = true;
          }
        }
      }
      this._save(nodes.filter((n) => !toRemove.has(n.id)));
    },
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const collapsed = loadCollapsed();
  let dragId = null;

  const clearDropMarks = (root) => {
    for (const el of root.querySelectorAll(".libNode.is-dropInto, .libNode.is-dropBefore")) {
      el.classList.remove("is-dropInto", "is-dropBefore");
    }
    root.classList.remove("is-dropRoot");
  };

  const startInlineRename = (labelEl, current, onCommit) => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "libNode__rename";
    input.value = current;
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const next = String(input.value || "").trim();
      if (save && next) onCommit(next);
      else onCommit(null);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  };

  const iconButton = (cls, label, glyph, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `libNode__btn ${cls}`;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.textContent = glyph;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  // Render the saved tree (folders + queries) into `target`.
  function renderSaved(target, ctx) {
    const refresh = () => renderSaved(target, ctx);
    target.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "queryLibraryPanel";

    // --- toolbar: save current query + new folder + search -------------------
    const form = document.createElement("div");
    form.className = "savePanel";

    const input = document.createElement("input");
    input.className = "savePanel__input";
    input.type = "text";
    input.placeholder = "Name to save current query…";
    input.autocomplete = "off";
    input.spellcheck = false;

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "button button--primary savePanel__button";
    saveBtn.textContent = "Save";

    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "button savePanel__folder";
    folderBtn.title = "New folder";
    folderBtn.textContent = "New folder";

    form.appendChild(input);
    form.appendChild(saveBtn);
    form.appendChild(folderBtn);
    wrap.appendChild(form);

    const searchRow = document.createElement("div");
    searchRow.className = "libSearch";
    const search = document.createElement("input");
    search.type = "text";
    search.className = "libSearch__input";
    search.placeholder = "Filter…";
    search.autocomplete = "off";
    searchRow.appendChild(search);
    wrap.appendChild(searchRow);

    const list = document.createElement("div");
    list.className = "queryLibraryList libTree";
    wrap.appendChild(list);
    target.appendChild(wrap);

    const updateSaveState = () => {
      const sql = String(ctx.getCurrentSql() || "").trim();
      const name = String(input.value || "").trim();
      saveBtn.disabled = !sql || !name;
    };
    const commitSave = () => {
      const sql = String(ctx.getCurrentSql() || "").trim();
      const name = String(input.value || "").trim();
      if (!sql || !name) return;
      savedProvider.addQuery({ name, sql_raw: sql, sql_formatted: sql, host_id: ctx.getHostId() || "" }, null);
      input.value = "";
      refresh();
    };
    input.addEventListener("input", updateSaveState);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitSave();
      }
    });
    // stopPropagation: these handlers re-render (detaching the clicked node),
    // which would otherwise trip the document click-outside handler and close
    // the whole library menu.
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      commitSave();
    });
    folderBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = savedProvider.addFolder("New folder", null);
      collapsed.delete(id);
      saveCollapsed(collapsed);
      refresh();
    });

    let filter = String(search.value || "").trim().toLowerCase();

    // --- tree rendering ------------------------------------------------------
    const matchesFilter = (node) => {
      if (!filter) return true;
      if (String(node.name || "").toLowerCase().includes(filter)) return true;
      if (node.type === "query") {
        const sql = String(node.sql_formatted || node.sql_raw || "").toLowerCase();
        if (sql.includes(filter)) return true;
      }
      return false;
    };

    // A folder is visible when it (or any descendant) matches the filter.
    const subtreeMatches = (node) => {
      if (matchesFilter(node)) return true;
      if (node.type !== "folder") return false;
      return savedProvider.childrenOf(node.id).some(subtreeMatches);
    };

    const renderInto = (parentId, depth, container) => {
      const kids = savedProvider.childrenOf(parentId);
      for (const node of kids) {
        if (filter && !subtreeMatches(node)) continue;

        const row = document.createElement("div");
        row.className = `libNode libNode--${node.type}`;
        row.dataset.nodeId = node.id;
        row.dataset.nodeType = node.type;
        row.style.paddingLeft = `${0.4 + depth * 0.95}rem`;
        row.setAttribute("draggable", "true");

        const labelEl = document.createElement("span");
        labelEl.className = "libNode__label";

        if (node.type === "folder") {
          const isCollapsed = collapsed.has(node.id) && !filter;
          const tw = document.createElement("span");
          tw.className = "libNode__twisty";
          tw.textContent = isCollapsed ? "▸" : "▾";
          row.appendChild(tw);

          const icon = document.createElement("span");
          icon.className = "libNode__icon";
          icon.textContent = "📁";
          row.appendChild(icon);

          labelEl.textContent = node.name;
          row.appendChild(labelEl);

          const count = document.createElement("span");
          count.className = "libNode__count";
          count.textContent = String(savedProvider.childrenOf(node.id).length);
          row.appendChild(count);

          row.appendChild(iconButton("libNode__btn--rename", "Rename folder", "✎", () => {
            startInlineRename(labelEl, node.name, (next) => {
              if (next) savedProvider.rename(node.id, next);
              refresh();
            });
          }));
          row.appendChild(iconButton("libNode__btn--add", "New subfolder", "+", () => {
            const id = savedProvider.addFolder("New folder", node.id);
            collapsed.delete(node.id);
            collapsed.delete(id);
            saveCollapsed(collapsed);
            refresh();
          }));
          row.appendChild(iconButton("libNode__btn--delete", "Delete folder", "×", () => {
            const hasChildren = savedProvider.childrenOf(node.id).length > 0;
            if (hasChildren && !window.confirm(`Delete folder "${node.name}" and its contents?`)) return;
            savedProvider.remove(node.id);
            refresh();
          }));

          row.addEventListener("click", (e) => {
            e.stopPropagation();
            if (filter) return;
            if (collapsed.has(node.id)) collapsed.delete(node.id);
            else collapsed.add(node.id);
            saveCollapsed(collapsed);
            refresh();
          });

          container.appendChild(row);

          if (!isCollapsed) {
            renderInto(node.id, depth + 1, container);
          }
        } else {
          const icon = document.createElement("span");
          icon.className = "libNode__icon";
          icon.textContent = "›";
          row.appendChild(icon);

          labelEl.textContent = node.name;
          row.appendChild(labelEl);

          if (node.host_id) {
            const host = document.createElement("span");
            host.className = "libNode__host";
            host.textContent = String(node.host_id);
            row.appendChild(host);
          }

          row.appendChild(iconButton("libNode__btn--rename", "Rename query", "✎", () => {
            startInlineRename(labelEl, node.name, (next) => {
              if (next) savedProvider.rename(node.id, next);
              refresh();
            });
          }));
          row.appendChild(iconButton("libNode__btn--delete", "Delete query", "×", () => {
            savedProvider.remove(node.id);
            refresh();
          }));

          const preview = ctx.preview(String(node.sql_formatted || node.sql_raw || ""), 160);
          row.title = preview;

          row.addEventListener("click", () => {
            ctx.onActivate({
              host_id: node.host_id,
              sql_raw: node.sql_raw,
              sql_formatted: node.sql_formatted,
            });
          });

          container.appendChild(row);
        }

        // --- drag & drop on this row ---
        row.addEventListener("dragstart", (e) => {
          dragId = node.id;
          row.classList.add("is-dragging");
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            try {
              e.dataTransfer.setData("text/plain", node.id);
            } catch {
              /* ignore */
            }
          }
          e.stopPropagation();
        });
        row.addEventListener("dragend", () => {
          dragId = null;
          row.classList.remove("is-dragging");
          clearDropMarks(list);
        });
        row.addEventListener("dragover", (e) => {
          if (dragId == null || dragId === node.id) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          clearDropMarks(list);
          // Drop onto a folder => move into it; onto a query => insert before it.
          if (node.type === "folder") row.classList.add("is-dropInto");
          else row.classList.add("is-dropBefore");
        });
        row.addEventListener("drop", (e) => {
          if (dragId == null || dragId === node.id) return;
          e.preventDefault();
          e.stopPropagation();
          const moving = dragId;
          if (node.type === "folder") {
            savedProvider.move(moving, node.id, null);
            collapsed.delete(node.id);
            saveCollapsed(collapsed);
          } else {
            savedProvider.move(moving, node.parentId ?? null, node.id);
          }
          dragId = null;
          refresh();
        });
      }
    };

    renderInto(null, 0, list);

    if (!list.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "queryLibraryEmpty";
      empty.textContent = filter ? "No matching saved queries" : "No saved queries yet";
      list.appendChild(empty);
    }

    // Dropping on empty list area => move to root.
    list.addEventListener("dragover", (e) => {
      if (dragId == null) return;
      e.preventDefault();
      if (e.target === list || e.target.closest(".queryLibraryEmpty")) {
        clearDropMarks(list);
        list.classList.add("is-dropRoot");
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      }
    });
    list.addEventListener("drop", (e) => {
      if (dragId == null) return;
      if (e.target === list || e.target.closest(".queryLibraryEmpty")) {
        e.preventDefault();
        savedProvider.move(dragId, null, null);
        dragId = null;
        refresh();
      }
    });

    search.addEventListener("input", () => {
      filter = String(search.value || "").trim().toLowerCase();
      clearDropMarks(list);
      list.innerHTML = "";
      renderInto(null, 0, list);
      if (!list.childElementCount) {
        const empty = document.createElement("div");
        empty.className = "queryLibraryEmpty";
        empty.textContent = filter ? "No matching saved queries" : "No saved queries yet";
        list.appendChild(empty);
      }
    });

    updateSaveState();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  // Render the (flat) history list with rename + "save to library".
  function renderHistory(target, ctx) {
    const refresh = () => renderHistory(target, ctx);
    const items = storage.loadHistory();
    target.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "queryLibraryPanel";
    const list = document.createElement("div");
    list.className = "queryLibraryList";
    wrap.appendChild(list);
    target.appendChild(wrap);

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "queryLibraryEmpty";
      empty.textContent = "No history yet";
      list.appendChild(empty);
      return;
    }

    for (const it of items) {
      const sqlText = String(it.sql_formatted || it.sql_raw || "");
      const row = document.createElement("div");
      row.className = "libNode libNode--query libNode--history";

      const main = document.createElement("span");
      main.className = "libNode__label";
      main.textContent = it.label ? it.label : ctx.preview(sqlText, 100) || "Query";
      if (it.label) row.classList.add("has-label");
      row.appendChild(main);

      if (it.host_id) {
        const host = document.createElement("span");
        host.className = "libNode__host";
        host.textContent = String(it.host_id);
        row.appendChild(host);
      }

      row.appendChild(iconButton("libNode__btn--rename", "Rename (set a label)", "✎", () => {
        startInlineRename(main, it.label || "", (next) => {
          storage.setHistoryLabel(it.host_id, it.sql_raw, next || "");
          refresh();
        });
      }));
      row.appendChild(iconButton("libNode__btn--save", "Save to library", "★", () => {
        const name = it.label || ctx.preview(sqlText, 40) || "Saved query";
        savedProvider.addQuery({ name, sql_raw: it.sql_raw, sql_formatted: sqlText, host_id: it.host_id || "" }, null);
        if (typeof ctx.onSaved === "function") ctx.onSaved();
      }));

      row.title = ctx.preview(sqlText, 200);
      row.addEventListener("click", () => ctx.onActivate(it));
      list.appendChild(row);
    }
  }

  ns.library = { renderSaved, renderHistory, savedProvider };
})();
