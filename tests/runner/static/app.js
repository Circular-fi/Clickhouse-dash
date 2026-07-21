(function () {
  "use strict";

  function storageGet(storage, key, fallback) {
    try {
      var value = storage.getItem(key);
      return value == null ? fallback: value;
    } catch (_) {
      return fallback;
    }
  }

  function browserStorage(name) {
    try {
      return window[name];
    } catch (_) {
      return null;
    }
  }

  var localStore = browserStorage("localStorage");
  var sessionStore = browserStorage("sessionStorage");

  function storageSet(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch (_) {
      // Storage can be disabled by privacy settings. The UI remains usable;
      // only the remembered tab, scroll position or theme is lost.
    }
  }

  var app = {
    state: null,
    stateEtag: "",
    stateLoading: false,
    stateQueued: false,
    lastStateAt: 0,
    activeTab: storageGet(localStore, "chdash.tests.activeTab", "tests") === "benchmark" ? "benchmark": "tests",
    tabScroll: {
      tests: Number(storageGet(sessionStore, "chdash.tests.scroll.tests", "0") || 0),
      benchmark: Number(storageGet(sessionStore, "chdash.tests.scroll.benchmark", "0") || 0)
    },
    details: {
      tests: { etag: "", runId: "", revision: "", data: null, loading: false, queued: false },
      benchmark: { etag: "", runId: "", revision: "", data: null, loading: false, queued: false }
    },
    artifacts: {
      tests: { runId: "", revision: "", data: null, loading: false },
      benchmark: { runId: "", revision: "", data: null, loading: false }
    },
    logs: {
      tests: { key: "", offset: 0, loading: false, timer: null, initialized: false },
      benchmark: { key: "", offset: 0, loading: false, timer: null, initialized: false }
    },
    format: {
      runId: "",
      filter: "failures",
      search: "",
      offset: 0,
      total: 0,
      hasMore: false,
      loading: false,
      requestToken: 0,
      caseCache: new Map(),
      revision: "",
      pageSize: 20
    },
    benchmarkData: null,
    benchmarkSearch: "",
    historyKeys: { tests: "", benchmark: "" },
    eventSource: null,
    searchTimers: { format: null, benchmark: null }
  };

  var integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  var dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "medium"
  });

  function byId(name) {
    return document.getElementById(name);
  }

  function text(name, value) {
    var element = byId(name);
    if (!element) return;
    var next = value == null ? "": String(value);
    if (element.textContent !== next) element.textContent = next;
  }

  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed: (fallback == null ? 0: fallback);
  }

  function formatInteger(value) {
    return integerFormatter.format(number(value));
  }

  function formatMs(value) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return "--";
    return (parsed >= 100 ? parsed.toFixed(0): parsed.toFixed(2)) + " ms";
  }

  function formatSeconds(value) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return "--";
    return (parsed >= 100 ? parsed.toFixed(0): parsed.toFixed(2)) + " s";
  }

  function formatPercent(value, signed) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return "--";
    var prefix = signed && parsed > 0 ? "+": "";
    return prefix + parsed.toFixed(2) + "%";
  }

  function formatBytes(value) {
    var parsed = Math.max(0, number(value));
    var units = ["B", "KB", "MB", "GB", "TB"];
    var index = 0;
    while (parsed >= 1024 && index < units.length - 1) {
      parsed /= 1024;
      index += 1;
    }
    return (index ? parsed.toFixed(1): parsed.toFixed(0)) + " " + units[index];
  }

  function formatDate(value) {
    if (!value) return "--";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return dateTimeFormatter.format(date);
  }

  function statusLabel(status) {
    return {
      success: "Success",
      passed: "Success",
      failed: "Failed",
      error: "Error",
      running: "Running",
      queued: "Queued",
      cancelled: "Cancelled",
      idle: "Idle"
    }[status] || "Unknown";
  }

  function normalizedStatus(status) {
    if (status === "passed") return "success";
    if (status === "error") return "failed";
    if (status === "queued") return "running";
    return status || "idle";
  }

  function setStatusBadge(elementId, status, label) {
    var element = byId(elementId);
    if (!element) return;
    var normalized = normalizedStatus(status);
    element.className = "status-badge " + normalized;
    var value = element.querySelector("span:last-child");
    if (value) value.textContent = label || statusLabel(normalized);
  }

  function setMiniStatus(elementId, status) {
    var element = byId(elementId);
    if (!element) return;
    var normalized = normalizedStatus(status);
    element.className = "mini-status " + normalized;
    element.setAttribute("aria-label", statusLabel(normalized));
  }

  function setConnection(mode, label) {
    var element = byId("connectionStatus");
    if (!element) return;
    element.className = "connection-pill is-" + mode;
    text("connectionText", label);
  }

  function setDownload(elementId, enabled, url) {
    var element = byId(elementId);
    if (!element) return;
    if (url) element.href = url;
    element.classList.toggle("is-disabled", !enabled);
    element.setAttribute("aria-disabled", enabled ? "false": "true");
  }

  function create(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }

  function emptyState(message, compact) {
    return create("div", "empty-state" + (compact ? " compact": ""), message);
  }

  function toast(message, type, timeout) {
    var region = byId("toastRegion");
    if (!region) return;
    var item = create("div", "toast " + (type || "info"));
    var content = create("span", "", message);
    var close = create("button", "", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", function () { item.remove(); });
    item.append(create("span", "sr-only", type || "info"), content, close);
    region.appendChild(item);
    window.setTimeout(function () {
      if (item.isConnected) item.remove();
    }, timeout || 5000);
  }

  async function requestJson(url, options) {
    var config = options || {};
    var headers = new Headers(config.headers || {});
    headers.set("Accept", "application/json");
    if (config.etag) headers.set("If-None-Match", config.etag);
    var response = await fetch(url, {
      method: config.method || "GET",
      headers: headers,
      cache: "no-cache",
      credentials: "same-origin"
    });
    if (response.status === 304) {
      return { notModified: true, etag: config.etag || "", payload: null };
    }
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(payload.error || response.statusText || ("HTTP " + response.status));
    }
    return {
      notModified: false,
      etag: response.headers.get("ETag") || "",
      payload: payload
    };
  }

  async function loadState(force) {
    if (app.stateLoading) {
      app.stateQueued = true;
      return;
    }
    app.stateLoading = true;
    try {
      var result = await requestJson("/api/state", { etag: force ? "": app.stateEtag });
      app.lastStateAt = Date.now();
      setConnection("online", "Connected");
      if (!result.notModified) {
        app.stateEtag = result.etag;
        app.state = result.payload;
        applyState();
      }
    } catch (error) {
      setConnection("offline", "Disconnected");
      toast("Unable to load state: " + error.message, "error", 7000);
    } finally {
      app.stateLoading = false;
      if (app.stateQueued) {
        app.stateQueued = false;
        window.setTimeout(function () { loadState(false); }, 0);
      }
    }
  }

  function connectStateEvents() {
    if (document.visibilityState === "hidden") return;
    if (!("EventSource" in window)) {
      setConnection("connecting", "Polling de secours");
      return;
    }
    if (app.eventSource) app.eventSource.close();
    var version = app.state && app.state.version ? app.state.version: -1;
    var source = new EventSource("/api/events?version=" + encodeURIComponent(version));
    app.eventSource = source;
    setConnection("connecting", "Connexion...");
    source.onopen = function () {
      setConnection("online", "Live");
    };
    source.addEventListener("state", function () {
      loadState(false);
    });
    source.onerror = function () {
      setConnection("connecting", "Reconnexion...");
    };
  }

  function disconnectStateEvents() {
    if (!app.eventSource) return;
    app.eventSource.close();
    app.eventSource = null;
  }

  function runnerMeta(active) {
    if (!active) return "Ready";
    var parts = [active.kind, active.phase, active.started_at ? formatDate(active.started_at): ""];
    return parts.filter(Boolean).join(" / ");
  }

  function applyState() {
    var state = app.state || {};
    var active = state.active;
    var jobs = state.jobs || {};
    configureExternalLinks(state.config || {});
    app.format.pageSize = Math.max(5, Math.min(100, number(state.config && state.config.format_page_size, 20)));
    var latest = state.latest || {};
    var busy = Boolean(active);

    setStatusBadge("runnerStatus", busy ? active.status: "idle", busy ? statusLabel(active.status): "Ready");
    text("runnerMeta", runnerMeta(active));

    ["runTests", "runBenchmark", "runAll"].forEach(function (name) {
      var element = byId(name);
      if (element) element.disabled = busy;
    });
    byId("cancelJob").disabled = !busy;

    updateTestsOverview(latest.tests || {}, jobs.tests || {});
    updateBenchmarkOverview(latest.benchmark || {}, jobs.benchmark || {});
    renderHistory("tests", state.history || []);
    renderHistory("benchmark", state.history || []);
    syncArtifactCaches(latest);

    if (app.activeTab === "tests") ensureDetails("tests", false);
    else ensureDetails("benchmark", false);

    syncLogPolling(active);
  }

  function updateTestsOverview(overview, job) {
    var status = job.status || overview.status || "idle";
    setMiniStatus("testsTabStatus", status);
    setStatusBadge("testsHeaderStatus", status, status === "idle" ? "No run": statusLabel(status));
    text(
      "testsTabMeta",
      overview.run_id
        ? formatInteger(overview.passed) + "/" + formatInteger(overview.tests) + " passed, " + formatInteger(overview.format_failed) + " formatting difference(s), " + formatInteger(overview.query_type_regressions) + " native-type regression(s)"
       : "No results"
    );
    text("testsRunMeta", overview.run_id ? ("Run " + overview.run_id + " / " + formatSeconds(overview.time_seconds)): "API tests run automatically when the runner starts.");
    setDownload("downloadTests", Boolean(overview.report_url) && !job.active, overview.report_url || "/api/report/tests.zip");

    text("testsTotal", overview.run_id ? formatInteger(overview.tests): "--");
    text("testsPassed", overview.run_id ? formatInteger(overview.passed): "--");
    text("testsFailures", overview.run_id ? formatInteger(number(overview.failures) + number(overview.errors)): "--");
    text("testsErrorsMeta", overview.run_id ? formatInteger(overview.errors) + " error(s)": "0 errors");
    text("testsDuration", overview.run_id ? formatSeconds(overview.time_seconds): "--");
    text("testsFormatDiffs", overview.run_id ? formatInteger(overview.format_failed): "--");
    text("testsFormatMeta", overview.run_id ? formatInteger(overview.format_completed) + "/" + formatInteger(overview.format_total) + " completed": "no differences");
    text("testsTypeRegressions", overview.run_id ? formatInteger(overview.query_type_regressions): "--");
    text(
      "testsTypeMeta",
      overview.run_id
        ? formatInteger(overview.query_type_failed) + " failure(s), " + formatInteger(overview.query_type_infrastructure_errors) + " error(s) harness"
       : "source / release diagnosis"
    );
  }

  function updateBenchmarkOverview(overview, job) {
    var status = job.status || overview.status || "idle";
    setMiniStatus("benchmarkTabStatus", status);
    setStatusBadge("benchmarkHeaderStatus", status, status === "idle" ? "No run": statusLabel(status));
    text(
      "benchmarkTabMeta",
      overview.run_id
        ? formatInteger(overview.comparisons_count) + " comparison(s), " + formatInteger(overview.issues_count) + " error(s), " + formatInteger(overview.warnings_count) + " warning(s)"
       : "No results"
    );
    text("benchmarkRunMeta", overview.run_id ? ("Run " + overview.run_id + " / " + formatInteger(overview.direct_http_count) + " direct HTTP reference(s)"): "Source build vs release with a direct ClickHouse HTTP reference.");
    setDownload("downloadBenchmark", Boolean(overview.report_url) && !job.active, overview.report_url || "/api/report/benchmark.zip");

    text("benchmarkComparisons", overview.run_id ? formatInteger(overview.comparisons_count): "--");
    text("benchmarkSpeedup", overview.run_id ? formatPercent(overview.median_speedup_pct, true): "--");
    text("benchmarkWinsMeta", overview.run_id ? formatInteger(overview.source_faster_count) + " source win(s), " + formatInteger(overview.source_slower_count) + " source slowdown(s)": "source faster");
    text("benchmarkHttpCount", overview.run_id ? formatInteger(overview.direct_http_count): "--");
    text("benchmarkOverhead", overview.run_id ? formatMs(overview.median_direct_overhead_ms): "--");
    text("benchmarkRatioMeta", overview.run_id && overview.median_direct_ratio != null ? number(overview.median_direct_ratio).toFixed(2) + "x vs HTTP wire": "vs raw HTTP transport");
    text("benchmarkIssues", overview.run_id ? formatInteger(overview.issues_count): "--");
    text("benchmarkWarnings", overview.run_id ? formatInteger(overview.warnings_count): "--");
  }

  async function ensureDetails(kind, force) {
    var latest = app.state && app.state.latest ? app.state.latest[kind]: null;
    var cache = app.details[kind];
    if (!latest || !latest.run_id) {
      cache.etag = "";
      cache.runId = "";
      cache.revision = "";
      cache.data = null;
      if (kind === "tests") clearTestsDetails();
      else clearBenchmarkDetails();
      return;
    }
    if (cache.loading) {
      cache.queued = true;
      return;
    }
    var latestRevision = latest.revision || latest.run_id || "";
    if (!force && cache.data && cache.runId === latest.run_id && cache.revision === latestRevision) return;
    cache.loading = true;
    try {
      var result = await requestJson("/api/details/" + kind, {
        etag: !force && cache.runId === latest.run_id ? cache.etag: ""
      });
      if (!result.notModified) {
        cache.etag = result.etag;
        cache.data = result.payload;
        cache.runId = result.payload.run_id || latest.run_id;
        cache.revision = result.payload.revision || latestRevision;
        if (kind === "tests") renderTestsDetails(result.payload);
        else renderBenchmarkDetails(result.payload);
      }
    } catch (error) {
      toast("Unable to load " + kind + ": " + error.message, "error", 7000);
    } finally {
      cache.loading = false;
      if (cache.queued) {
        cache.queued = false;
        window.setTimeout(function () { ensureDetails(kind, false); }, 0);
      }
    }
  }

  function clearTestsDetails() {
    var failed = byId("failedCases");
    failed.replaceChildren(emptyState("No results available.", true));
    byId("testsLinks").replaceChildren();
    byId("testsFacts").replaceChildren();
    text("failedCasesCount", "0");
    resetFormatView("");
  }

  function clearBenchmarkDetails() {
    app.benchmarkData = null;
    byId("comparisonTable").replaceChildren(emptyState("No benchmark available."));
    byId("httpOverheadTable").replaceChildren(emptyState("No direct HTTP measurements."));
    byId("benchmarkLinks").replaceChildren();
    byId("benchmarkIssuesPanel").hidden = true;
    byId("benchmarkWarningsPanel").hidden = true;
    text("comparisonCount", "0");
    text("httpOverheadCount", "0");
  }

  function renderTestsDetails(details) {
    var junit = details.junit || {};
    var formats = details.format_results || {};
    var queryTypes = details.query_types || {};
    var runner = details.runner || {};
    var cases = Array.isArray(junit.failed_cases) ? junit.failed_cases: [];

    text("failedCasesCount", formatInteger(cases.length));
    renderFailedCases(cases);
    renderResourceLinks("testsLinks", [
      [details.links && details.links.junit, "JUnit XML", "structured results"],
      [details.links && details.links.log, "pytest.log", "complete output"],
      [details.links && details.links.result, "runner-result.json", "run metadata"],
      [details.links && details.links.format_results, "format_results.json", "expected / actual"],
      [details.links && details.links.query_types, "query_types_results.json", "classification source / release"]
    ]);
    renderFacts("testsFacts", [
      ["Run", details.run_id || "--"],
      ["Statut", statusLabel(normalizedStatus(runner.status || ((number(junit.failures) + number(junit.errors)) ? "failed": "success")))],
      ["Tests", formatInteger(junit.tests)],
      ["Formatting", formatInteger(formats.completed) + "/" + formatInteger(formats.total_expected)],
      ["Native types", formatInteger(queryTypes.passed) + "/" + formatInteger(queryTypes.total_expected) + " passed"],
      ["Source regressions", formatInteger(queryTypes.source_regressions_vs_release)]
    ]);

    var logLink = byId("testsLogDownload");
    setSimpleLink(logLink, details.links && details.links.log);

    if (app.format.runId !== details.run_id || app.format.revision !== details.revision) {
      resetFormatView(details.run_id || "");
      app.format.revision = details.revision || "";
      if (app.activeTab === "tests") loadFormatPage(true);
    }
  }

  function renderFailedCases(cases) {
    var container = byId("failedCases");
    if (!cases.length) {
      var success = emptyState("No failed tests in the latest run.", true);
      success.classList.add("metric-success");
      container.replaceChildren(success);
      return;
    }
    var list = create("div", "failure-list");
    cases.forEach(function (item) {
      var card = create("details", "failure-item");
      var summary = create("summary", "failure-title", (item.classname ? item.classname + " :: ": "") + (item.name || "test"));
      card.appendChild(summary);
      if (item.message) card.appendChild(create("div", "failure-message", item.message));
      if (item.details) card.appendChild(create("pre", "failure-details", item.details));
      list.appendChild(card);
    });
    container.replaceChildren(list);
  }

  function renderResourceLinks(containerId, rows) {
    var container = byId(containerId);
    var fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      if (!row[0]) return;
      var link = create("a", "resource-item");
      link.href = row[0];
      link.target = "_blank";
      link.rel = "noreferrer";
      link.append(create("span", "", row[1]), create("span", "", row[2]));
      fragment.appendChild(link);
    });
    if (!fragment.childNodes.length) container.replaceChildren(emptyState("No files available.", true));
    else container.replaceChildren(fragment);
  }

  function renderFacts(containerId, rows) {
    var container = byId(containerId);
    var fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      var item = create("div", "fact-item");
      item.append(create("span", "", row[0]), create("strong", "", row[1]));
      fragment.appendChild(item);
    });
    container.replaceChildren(fragment);
  }

  function setSimpleLink(element, url) {
    if (!element) return;
    if (url) element.href = url;
    element.classList.toggle("is-disabled", !url);
    element.setAttribute("aria-disabled", url ? "false": "true");
  }

  function resetFormatView(runId) {
    app.format.runId = runId;
    app.format.revision = "";
    app.format.offset = 0;
    app.format.total = 0;
    app.format.hasMore = false;
    app.format.loading = false;
    app.format.requestToken += 1;
    app.format.caseCache.clear();
    byId("formatResults").replaceChildren(emptyState(runId ? "Loading results...": "No results de formatage disponible."));
    byId("formatLoadMore").hidden = true;
    text("formatResultCount", "0");
  }

  function setFormatFilter(filter) {
    if (app.format.filter === filter) return;
    app.format.filter = filter;
    byId("formatFailures").classList.toggle("is-active", filter === "failures");
    byId("formatAll").classList.toggle("is-active", filter === "all");
    loadFormatPage(true);
  }

  async function loadFormatPage(reset) {
    if (!app.format.runId) return;
    var token = ++app.format.requestToken;
    app.format.loading = true;
    if (reset) {
      app.format.offset = 0;
      app.format.total = 0;
      app.format.hasMore = false;
      byId("formatResults").replaceChildren(emptyState("Loading results..."));
    }
    byId("formatLoadMore").disabled = true;
    try {
      var url = "/api/format-results?status=" + encodeURIComponent(app.format.filter) +
        "&q=" + encodeURIComponent(app.format.search) +
        "&offset=" + encodeURIComponent(app.format.offset) +
        "&limit=" + encodeURIComponent(app.format.pageSize);
      var result = await requestJson(url);
      if (token !== app.format.requestToken) return;
      renderFormatPage(result.payload, reset);
    } catch (error) {
      if (token !== app.format.requestToken) return;
      byId("formatResults").replaceChildren(emptyState("Unable to load diffs: " + error.message));
      toast("Failed to load formatting results: " + error.message, "error", 7000);
    } finally {
      if (token === app.format.requestToken) {
        app.format.loading = false;
        byId("formatLoadMore").disabled = !app.format.hasMore;
      }
    }
  }

  function renderFormatPage(payload, reset) {
    var container = byId("formatResults");
    var items = Array.isArray(payload.items) ? payload.items: [];
    app.format.total = number(payload.total);
    app.format.offset = number(payload.next_offset);
    app.format.hasMore = Boolean(payload.has_more);
    text("formatResultCount", formatInteger(app.format.total));

    if (reset) {
      container.replaceChildren();
      var summary = create("div", "format-summary");
      var summaryData = payload.summary || {};
      summary.append(
        create("span", "", formatInteger(payload.total) + " cas dans le filtre"),
        create("span", "", formatInteger(summaryData.passed) + " passed / " + formatInteger(number(summaryData.failed) + number(summaryData.errors)) + " failed")
      );
      container.appendChild(summary);
    }

    if (!items.length && reset) {
      var message = app.format.filter === "failures"
        ? "No formatting differences detected."
       : "No case matches the filter.";
      container.appendChild(emptyState(message, true));
    } else {
      var fragment = document.createDocumentFragment();
      items.forEach(function (item) { fragment.appendChild(createFormatCard(item)); });
      container.appendChild(fragment);
    }

    byId("formatLoadMore").hidden = !app.format.hasMore;
  }

  function inlineStatus(status) {
    return create("span", "inline-status " + normalizedStatus(status), statusLabel(normalizedStatus(status)));
  }

  function createFormatCard(item) {
    var card = create("details", "diff-card");
    card.dataset.status = item.status || "idle";
    card.dataset.file = item.file || "";

    var summary = create("summary", "diff-card-summary");
    var title = create("span", "diff-card-title", item.file || item.name || "fixture");
    var stats = create("span", "diff-card-stats");
    stats.append(
      inlineStatus(item.status),
      create("span", "", formatMs(item.duration_ms)),
      create("span", "metric-negative", "-" + formatInteger(item.removed_lines)),
      create("span", "metric-positive", "+" + formatInteger(item.added_lines)),
      create("span", "", formatInteger(item.changed_blocks) + " bloc(s)")
    );
    summary.append(title, stats);

    var body = create("div", "diff-card-body");
    body.appendChild(emptyState("Open this case to load the detailed diff.", true));
    card.append(summary, body);
    card.addEventListener("toggle", function () {
      if (card.open && card.dataset.loaded !== "1") loadFormatCase(card, item);
    });
    return card;
  }

  async function loadFormatCase(card, item) {
    var body = card.querySelector(".diff-card-body");
    if (!body) return;
    var cacheKey = app.format.runId + ":" + (item.file || item.name || "");
    if (app.format.caseCache.has(cacheKey)) {
      renderFormatCase(body, app.format.caseCache.get(cacheKey));
      card.dataset.loaded = "1";
      return;
    }
    body.replaceChildren(emptyState("Loading diff...", true));
    try {
      var result = await requestJson(item.detail_url || ("/api/format-case?file=" + encodeURIComponent(item.file || "")));
      app.format.caseCache.set(cacheKey, result.payload);
      renderFormatCase(body, result.payload);
      card.dataset.loaded = "1";
    } catch (error) {
      body.replaceChildren(emptyState("Unable to load diff: " + error.message, true));
    }
  }

  function renderFormatCase(body, detail) {
    var fragment = document.createDocumentFragment();
    if (detail.error) fragment.appendChild(create("div", "diff-message", detail.error));

    var toolbar = create("div", "diff-toolbar");
    [
      [detail.input_url, "Input"],
      [detail.expected_url, "Expected"],
      [detail.actual_url, "Actual"]
    ].forEach(function (row) {
      if (!row[0]) return;
      var link = create("a", "file-chip", row[1]);
      link.href = row[0];
      link.target = "_blank";
      link.rel = "noreferrer";
      toolbar.appendChild(link);
    });
    if (toolbar.childNodes.length) fragment.appendChild(toolbar);

    var scroll = create("div", "diff-scroll");
    scroll.dataset.scrollKey = "format-" + (detail.file || detail.name || "case");
    var table = create("table", "diff-table");
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["#", "Expected", "#", "Actual"].forEach(function (label) {
      headRow.appendChild(create("th", "", label));
    });
    thead.appendChild(headRow);
    var tbody = document.createElement("tbody");
    (Array.isArray(detail.rows) ? detail.rows: []).forEach(function (row) {
      var tr = document.createElement("tr");
      tr.className = "diff-" + (row.kind || "equal");
      tr.append(
        create("td", "diff-no", row.expected_no == null ? "": row.expected_no),
        create("td", "diff-code mono", row.expected == null ? "": row.expected),
        create("td", "diff-no", row.actual_no == null ? "": row.actual_no),
        create("td", "diff-code mono", row.actual == null ? "": row.actual)
      );
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    scroll.appendChild(table);
    fragment.appendChild(scroll);

    if (detail.rows_truncated) {
      fragment.appendChild(create("div", "diff-message", "Display truncated. Complete files remain available in the ZIP report."));
    }
    if (detail.unified) {
      var unified = create("details", "unified-diff");
      unified.append(create("summary", "", "Unified diff"), create("pre", "", detail.unified));
      fragment.appendChild(unified);
    }
    body.replaceChildren(fragment);
  }

  function renderBenchmarkDetails(details) {
    app.benchmarkData = details;
    var summary = details.summary || {};
    var overview = details.overview || {};
    renderResourceLinks("benchmarkLinks", [
      [details.links && details.links.comparison, "comparison.md", "readable report"],
      [details.links && details.links.summary, "summary.json", "structured data"],
      [details.links && details.links.summary_csv, "summary.csv", "aggregated metrics"],
      [details.links && details.links.comparisons_csv, "comparisons.csv", "source vs release"],
      [details.links && details.links.direct_http_csv, "direct_http_overhead.csv", "HTTP floor"],
      [details.links && details.links.runs, "runs.jsonl", "all runs"],
      [details.links && details.links.log, "runner.log", "complete progress log"]
    ]);
    setSimpleLink(byId("benchmarkLogDownload"), details.links && details.links.log);
    text("benchmarkComparisons", formatInteger(overview.comparisons_count));
    text("benchmarkSpeedup", formatPercent(overview.median_speedup_pct, true));
    text("benchmarkHttpCount", formatInteger(overview.direct_http_count));
    text("benchmarkOverhead", formatMs(overview.median_direct_overhead_ms));
    text("benchmarkIssues", formatInteger(overview.issues_count));
    text("benchmarkWarnings", formatInteger(overview.warnings_count));
    renderBenchmarkIssues(Array.isArray(summary.issues) ? summary.issues: []);
    renderBenchmarkWarnings(Array.isArray(summary.warnings) ? summary.warnings: []);
    renderBenchmarkTables();
  }

  function renderBenchmarkIssues(issues) {
    var panel = byId("benchmarkIssuesPanel");
    var list = byId("benchmarkIssueList");
    text("benchmarkIssuesCount", formatInteger(issues.length));
    panel.hidden = !issues.length;
    if (!issues.length) {
      list.replaceChildren();
      return;
    }
    var fragment = document.createDocumentFragment();
    issues.forEach(function (issue) {
      var value = typeof issue === "string" ? issue: JSON.stringify(issue, null, 2);
      fragment.appendChild(create("div", "issue-row", value));
    });
    list.replaceChildren(fragment);
  }

  function renderBenchmarkWarnings(warnings) {
    var panel = byId("benchmarkWarningsPanel");
    var list = byId("benchmarkWarningList");
    text("benchmarkWarningsCount", formatInteger(warnings.length));
    panel.hidden = !warnings.length;
    if (!warnings.length) {
      list.replaceChildren();
      return;
    }
    var fragment = document.createDocumentFragment();
    warnings.forEach(function (warning) {
      var value = typeof warning === "string" ? warning: JSON.stringify(warning, null, 2);
      fragment.appendChild(create("div", "issue-row warning-row", value));
    });
    list.replaceChildren(fragment);
  }

  function rowMatchesSearch(row, search) {
    if (!search) return true;
    var needle = search.toLowerCase();
    return Object.keys(row || {}).some(function (key) {
      var value = row[key];
      if (value == null || typeof value === "object") return false;
      return String(value).toLowerCase().indexOf(needle) >= 0;
    });
  }

  function preserveElementScroll(element, callback) {
    var left = element.scrollLeft;
    var top = element.scrollTop;
    callback();
    window.requestAnimationFrame(function () {
      element.scrollLeft = left;
      element.scrollTop = top;
    });
  }

  function createDataTable(headers, rows) {
    var table = create("table", "data-table");
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    headers.forEach(function (header) { headRow.appendChild(create("th", "", header)); });
    thead.appendChild(headRow);
    var tbody = document.createElement("tbody");
    rows.forEach(function (cells) {
      var tr = document.createElement("tr");
      cells.forEach(function (cell) {
        var td = document.createElement("td");
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell == null ? "": String(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    return table;
  }

  function metricSpan(value, positive) {
    return create("span", positive === true ? "metric-positive": positive === false ? "metric-negative": "metric-neutral", value);
  }

  function checkSpan(ok) {
    return create("span", ok ? "check-mark": "diff-mark", ok ? "OK": "DIFF");
  }

  function expectedSpan(differs, value) {
    return create("span", differs ? "expected-mark": "check-mark", differs ? value + " (expected)": value);
  }

  function classificationSpan(value) {
    var labels = {
      equivalent: ["Equivalent", "check-mark"],
      baseline_correctness_improvement: ["Source correctness improvement", "expected-mark"],
      baseline_regression: ["Source regression", "diff-mark"],
      both_failed: ["Both failed", "diff-mark"]
    };
    var item = labels[value] || [String(value || "Unknown"), "metric-neutral"];
    return create("span", item[1], item[0]);
  }

  function deterministicCountPair(row) {
    var left = row.baseline_deterministic_event_count_medians || {};
    var right = row.compared_deterministic_event_count_medians || {};
    return ["meta", "result_meta", "done", "error"].map(function (name) {
      return name + " " + formatInteger(left[name]) + "/" + formatInteger(right[name]);
    }).join(" · ");
  }

  function telemetrySchemaPair(row) {
    var left = Array.isArray(row.baseline_tick_schemas) && row.baseline_tick_schemas.length
      ? row.baseline_tick_schemas.join(", ")
      : "none";
    var right = Array.isArray(row.compared_tick_schemas) && row.compared_tick_schemas.length
      ? row.compared_tick_schemas.join(", ")
      : "none";
    return left + " / " + right;
  }

  function renderBenchmarkTables() {
    if (!app.benchmarkData) return;
    var summary = app.benchmarkData.summary || {};
    var comparisons = (Array.isArray(summary.comparisons) ? summary.comparisons: []).filter(function (row) {
      return rowMatchesSearch(row, app.benchmarkSearch);
    });
    var overheads = (Array.isArray(summary.direct_http_overheads) ? summary.direct_http_overheads: []).filter(function (row) {
      return rowMatchesSearch(row, app.benchmarkSearch);
    });

    text("comparisonCount", formatInteger(comparisons.length));
    text("httpOverheadCount", formatInteger(overheads.length));

    var comparisonContainer = byId("comparisonTable");
    preserveElementScroll(comparisonContainer, function () {
      if (!comparisons.length) {
        comparisonContainer.replaceChildren(emptyState("No comparison matches the filter."));
        return;
      }
      var rows = comparisons.map(function (row) {
        var speedup = Number(row.speedup_pct_positive_means_baseline_faster);
        var resultBatchPair = formatInteger(row.baseline_result_row_events) + " / " + formatInteger(row.compared_result_row_events);
        var tickPair = formatInteger(row.baseline_tick_events) + " / " + formatInteger(row.compared_tick_events);
        return [
          row.host_id || "",
          create("span", "mono", row.query_name || ""),
          classificationSpan(row.correctness_classification),
          formatMs(row.baseline_median_done_ms),
          formatMs(row.compared_median_done_ms),
          metricSpan(formatPercent(speedup, true), Number.isFinite(speedup) ? speedup >= 0: null),
          formatMs(row.baseline_first_row_ms),
          formatMs(row.compared_first_row_ms),
          create("span", "mono compact-cell", deterministicCountPair(row)),
          checkSpan(Boolean(row.core_event_order_match)),
          expectedSpan(Boolean(row.result_batching_differs), resultBatchPair),
          expectedSpan(Boolean(row.tick_cadence_differs), tickPair),
          expectedSpan(Boolean(row.telemetry_schema_differs), telemetrySchemaPair(row)),
          checkSpan(Boolean(row.row_hash_match)),
          checkSpan(Boolean(row.columns_match))
        ];
      });
      comparisonContainer.replaceChildren(createDataTable(
        ["Host", "Query", "Correctness", "Source total", "Release total", "Speedup", "Source first row", "Release first row", "Control events S/R", "Core order", "Result batches S/R", "Ticks S/R", "Telemetry S/R", "Rows", "Columns"],
        rows
      ));
    });

    var overheadContainer = byId("httpOverheadTable");
    preserveElementScroll(overheadContainer, function () {
      if (!overheads.length) {
        overheadContainer.replaceChildren(emptyState("No direct HTTP measurement matches the filter."));
        return;
      }
      var rows = overheads.map(function (row) {
        var overhead = Number(row.overhead_ms);
        return [
          row.host_id || "",
          create("span", "mono", row.query_name || ""),
          row.dashboard_target || "",
          formatMs(row.dashboard_median_done_ms),
          formatMs(row.direct_http_first_byte_ms),
          formatMs(row.direct_http_first_row_ms),
          formatMs(row.direct_http_median_done_ms),
          formatMs(row.direct_http_verified_done_ms),
          formatMs(row.direct_http_server_elapsed_ms),
          metricSpan(formatMs(row.overhead_ms), Number.isFinite(overhead) ? overhead <= 0: null),
          row.duration_ratio_vs_direct_http == null ? "--": number(row.duration_ratio_vs_direct_http).toFixed(2) + "x",
          metricSpan(
            formatMs(row.verified_overhead_ms),
            Number.isFinite(Number(row.verified_overhead_ms)) ? Number(row.verified_overhead_ms) <= 0: null
          ),
          row.duration_ratio_vs_verified_direct_http == null ? "--": number(row.duration_ratio_vs_verified_direct_http).toFixed(2) + "x",
          checkSpan(Boolean(row.row_hash_match)),
          checkSpan(Boolean(row.columns_match))
        ];
      });
      overheadContainer.replaceChildren(createDataTable(
        ["Host", "Query", "Dashboard", "Dashboard total", "HTTP TTFB", "HTTP first row", "HTTP wire", "HTTP verified", "ClickHouse server", "Wire delta", "Wire ratio", "Verified delta", "Verified ratio", "Rows", "Columns"],
        rows
      ));
    });
  }

  function renderHistory(kind, history) {
    var filtered = history.filter(function (item) {
      return item && (item.kind === kind || item.kind === "all");
    });
    var key = filtered.map(function (item) {
      return [item.id, item.status, item.ended_at, item.returncode].join(":");
    }).join("|");
    if (app.historyKeys[kind] === key) return;
    app.historyKeys[kind] = key;
    var container = byId(kind === "tests" ? "testsHistory": "benchmarkHistory");
    if (!filtered.length) {
      container.replaceChildren(emptyState("No history since the runner started.", true));
      return;
    }
    var fragment = document.createDocumentFragment();
    filtered.forEach(function (item) {
      var row = create("div", "history-row");
      var main = create("div", "history-main");
      main.append(
        create("strong", "", item.id || item.kind),
        create("small", "", statusLabel(normalizedStatus(item.status)) + " / " + formatDate(item.started_at || item.created_at) + " / " + formatSeconds(item.duration_seconds))
      );
      row.appendChild(main);
      if (item.artifact_url) {
        var link = create("a", "", "Open");
        link.href = item.artifact_url;
        link.target = "_blank";
        link.rel = "noreferrer";
        row.appendChild(link);
      }
      fragment.appendChild(row);
    });
    container.replaceChildren(fragment);
  }

  function syncArtifactCaches(latest) {
    ["tests", "benchmark"].forEach(function (kind) {
      var runId = latest[kind] && latest[kind].run_id ? latest[kind].run_id: "";
      var revision = latest[kind] && latest[kind].revision ? latest[kind].revision: runId;
      if (app.artifacts[kind].runId !== runId || app.artifacts[kind].revision !== revision) {
        app.artifacts[kind] = { runId: runId, revision: revision, data: null, loading: false };
        var container = byId(kind === "tests" ? "testsArtifacts": "benchmarkArtifacts");
        container.replaceChildren(emptyState(runId ? "Open this section to load artifacts.": "No artifacts available.", true));
      }
    });
  }

  async function loadArtifacts(kind) {
    var cache = app.artifacts[kind];
    if (!cache.runId || cache.loading || cache.data) return;
    cache.loading = true;
    var container = byId(kind === "tests" ? "testsArtifacts": "benchmarkArtifacts");
    container.replaceChildren(emptyState("Loading artifacts...", true));
    try {
      var result = await requestJson("/api/artifacts/" + kind);
      if (app.artifacts[kind] !== cache) return;
      cache.data = result.payload;
      renderArtifacts(kind, result.payload);
    } catch (error) {
      container.replaceChildren(emptyState("Unable to load artifacts: " + error.message, true));
    } finally {
      cache.loading = false;
    }
  }

  function renderArtifacts(kind, payload) {
    var container = byId(kind === "tests" ? "testsArtifacts": "benchmarkArtifacts");
    var items = Array.isArray(payload.items) ? payload.items: [];
    if (!items.length) {
      container.replaceChildren(emptyState("No artifacts available.", true));
      return;
    }
    var fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      var row = create("div", "artifact-row");
      var main = create("div", "artifact-main");
      main.append(create("strong", "", item.path), create("small", "", formatBytes(item.size)));
      var link = create("a", "", "Open");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      row.append(main, link);
      fragment.appendChild(row);
    });
    if (payload.truncated) fragment.appendChild(emptyState("List truncated. The ZIP report contains every file.", true));
    container.replaceChildren(fragment);
  }

  function logElements(kind) {
    return {
      pre: byId(kind === "tests" ? "testsLog": "benchmarkLog"),
      state: byId(kind === "tests" ? "testsLogState": "benchmarkLogState"),
      download: byId(kind === "tests" ? "testsLogDownload": "benchmarkLogDownload")
    };
  }

  function stopLogTimer(kind) {
    var state = app.logs[kind];
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
  }

  function startLogTimer(kind) {
    var state = app.logs[kind];
    stopLogTimer(kind);
    fetchLog(kind, !state.initialized);
    state.timer = window.setInterval(function () {
      if (document.visibilityState === "visible") fetchLog(kind, false);
    }, 900);
  }

  function syncLogPolling(active) {
    stopLogTimer("tests");
    stopLogTimer("benchmark");
    if (!active) {
      fetchLog(app.activeTab, !app.logs[app.activeTab].initialized);
      updateLogState("tests", false);
      updateLogState("benchmark", false);
      return;
    }
    var kind = active.kind;
    if (kind === "all") kind = active.phase === "benchmark" ? "benchmark": "tests";
    // Only poll the visible log. Switching tabs immediately loads the active
    // stream, so hidden panels no longer generate one request every 900 ms.
    if ((kind === "tests" || kind === "benchmark") && kind === app.activeTab) {
      startLogTimer(kind);
    }
    updateLogState("tests", kind === "tests");
    updateLogState("benchmark", kind === "benchmark");
  }

  function updateLogState(kind, live) {
    var element = logElements(kind).state;
    element.textContent = live ? "Live": "Idle";
    element.classList.toggle("is-live", live);
  }

  async function fetchLog(kind, forceReset) {
    var state = app.logs[kind];
    if (state.loading) return;
    state.loading = true;
    if (forceReset) {
      state.key = "";
      state.offset = 0;
    }
    try {
      var url = "/api/log/" + kind + "?key=" + encodeURIComponent(state.key) + "&offset=" + encodeURIComponent(state.offset) + "&limit=65536";
      var result = await requestJson(url);
      var payload = result.payload;
      var elements = logElements(kind);
      var pre = elements.pre;
      var pinned = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 36;
      if (payload.reset || state.key !== payload.key) {
        pre.textContent = payload.text || "No log available.";
      } else if (payload.text) {
        if (pre.textContent === "No log available.") pre.textContent = "";
        pre.appendChild(document.createTextNode(payload.text));
      }
      if (pre.textContent.length > 600000) {
        pre.textContent = "... log truncated in the interface ...\n" + pre.textContent.slice(-420000);
      }
      state.key = payload.key || "";
      state.offset = number(payload.next_offset);
      state.initialized = true;
      setSimpleLink(elements.download, payload.log_url || "");
      updateLogState(kind, Boolean(payload.active));
      if (pinned) pre.scrollTop = pre.scrollHeight;
    } catch (error) {
      updateLogState(kind, false);
    } finally {
      state.loading = false;
    }
  }

  function switchTab(kind) {
    if (kind !== "tests" && kind !== "benchmark") return;
    if (app.activeTab === kind) return;
    app.tabScroll[app.activeTab] = window.scrollY;
    storageSet(sessionStore, "chdash.tests.scroll." + app.activeTab, String(window.scrollY));
    app.activeTab = kind;
    storageSet(localStore, "chdash.tests.activeTab", kind);

    ["tests", "benchmark"].forEach(function (name) {
      var active = name === kind;
      var tab = byId(name === "tests" ? "tabTests": "tabBenchmark");
      var panel = byId(name === "tests" ? "testsPanel": "benchmarkPanel");
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true": "false");
      tab.tabIndex = active ? 0: -1;
      panel.hidden = !active;
    });

    ensureDetails(kind, false);
    fetchLog(kind, !app.logs[kind].initialized);
    syncLogPolling(app.state && app.state.active ? app.state.active: null);
    window.requestAnimationFrame(function () {
      window.scrollTo({ top: app.tabScroll[kind] || 0, behavior: "auto" });
    });
  }

  async function runJob(kind) {
    try {
      await requestJson("/api/run/" + kind, { method: "POST" });
      toast(kind === "tests" ? "Tests started.": kind === "benchmark" ? "Benchmark started.": "Tests and benchmark started.", "success");
      await loadState(true);
    } catch (error) {
      toast("Unable to start job: " + error.message, "error", 7000);
    }
  }

  async function cancelJob() {
    try {
      var result = await requestJson("/api/cancel", { method: "POST" });
      toast(result.payload.ok ? "Stop requested.": "No active process to stop.", result.payload.ok ? "warning": "info");
      await loadState(true);
    } catch (error) {
      toast("Unable to stop job: " + error.message, "error", 7000);
    }
  }

  async function manualRefresh() {
    var button = byId("refreshState");
    button.disabled = true;
    try {
      await loadState(true);
      await ensureDetails(app.activeTab, true);
      await fetchLog(app.activeTab, true);
      toast("Results refreshed.", "success", 2500);
    } finally {
      button.disabled = false;
    }
  }

  function updateThemeButton() {
    var mode = document.documentElement.dataset.themeMode || "system";
    text("themeIcon", mode === "dark" ? "☾": mode === "light" ? "☀": "◐");
    byId("themeToggle").title = "Theme: " + (mode === "dark" ? "dark": mode === "light" ? "light": "system");
  }

  function cycleTheme() {
    var root = document.documentElement;
    var current = root.dataset.themeMode || "system";
    var next = current === "system" ? "dark": current === "dark" ? "light": "system";
    root.dataset.themeMode = next;
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    storageSet(localStore, "chdash.tests.theme", next);
    updateThemeButton();
  }

  function configureExternalLinks(config) {
    var host = window.location.hostname || "localhost";
    var protocol = window.location.protocol === "https:" ? "https:": "http:";
    var ports = config && config.public_ports ? config.public_ports: {};
    byId("sourceLink").href = protocol + "//" + host + ":" + (ports.source || 18080);
    byId("releaseLink").href = protocol + "//" + host + ":" + (ports.release || 18081);
    byId("clickhouseLink").href = protocol + "//" + host + ":" + (ports.clickhouse_http || 18123) + "/ping";
  }

  function bindEvents() {
    byId("tabTests").addEventListener("click", function () { switchTab("tests"); });
    byId("tabBenchmark").addEventListener("click", function () { switchTab("benchmark"); });
    [byId("tabTests"), byId("tabBenchmark")].forEach(function (tab) {
      tab.addEventListener("keydown", function (event) {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        var next = event.key === "Home" || event.key === "ArrowLeft" ? "tests": "benchmark";
        switchTab(next);
        byId(next === "tests" ? "tabTests": "tabBenchmark").focus();
      });
    });
    byId("runTests").addEventListener("click", function () { runJob("tests"); });
    byId("runBenchmark").addEventListener("click", function () { runJob("benchmark"); });
    byId("runAll").addEventListener("click", function () { runJob("all"); });
    byId("cancelJob").addEventListener("click", cancelJob);
    byId("refreshState").addEventListener("click", manualRefresh);
    byId("themeToggle").addEventListener("click", cycleTheme);
    byId("formatFailures").addEventListener("click", function () { setFormatFilter("failures"); });
    byId("formatAll").addEventListener("click", function () { setFormatFilter("all"); });
    byId("formatLoadMore").addEventListener("click", function () { loadFormatPage(false); });

    byId("formatSearch").addEventListener("input", function (event) {
      window.clearTimeout(app.searchTimers.format);
      app.searchTimers.format = window.setTimeout(function () {
        app.format.search = event.target.value.trim();
        loadFormatPage(true);
      }, 240);
    });

    byId("benchmarkSearch").addEventListener("input", function (event) {
      window.clearTimeout(app.searchTimers.benchmark);
      app.searchTimers.benchmark = window.setTimeout(function () {
        app.benchmarkSearch = event.target.value.trim();
        renderBenchmarkTables();
      }, 120);
    });

    byId("testsArtifactsDisclosure").addEventListener("toggle", function (event) {
      if (event.target.open) loadArtifacts("tests");
    });
    byId("benchmarkArtifactsDisclosure").addEventListener("toggle", function (event) {
      if (event.target.open) loadArtifacts("benchmark");
    });

    ["downloadTests", "downloadBenchmark"].forEach(function (name) {
      byId(name).addEventListener("click", function (event) {
        if (event.currentTarget.classList.contains("is-disabled")) {
          event.preventDefault();
          return;
        }
        toast("Preparing ZIP report...", "info", 3000);
      });
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        disconnectStateEvents();
        stopLogTimer("tests");
        stopLogTimer("benchmark");
        return;
      }
      connectStateEvents();
      if (Date.now() - app.lastStateAt > 5000) loadState(false);
      syncLogPolling(app.state && app.state.active ? app.state.active: null);
      fetchLog(app.activeTab, false);
    });

    window.addEventListener("beforeunload", function () {
      storageSet(sessionStore, "chdash.tests.scroll." + app.activeTab, String(window.scrollY));
      disconnectStateEvents();
      stopLogTimer("tests");
      stopLogTimer("benchmark");
    });
  }

  function initializeTab() {
    ["tests", "benchmark"].forEach(function (kind) {
      var active = app.activeTab === kind;
      var tab = byId(kind === "tests" ? "tabTests": "tabBenchmark");
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true": "false");
      tab.tabIndex = active ? 0: -1;
      byId(kind === "tests" ? "testsPanel": "benchmarkPanel").hidden = !active;
    });
  }

  async function bootstrap() {
    configureExternalLinks();
    updateThemeButton();
    initializeTab();
    bindEvents();
    await loadState(true);
    connectStateEvents();
    window.requestAnimationFrame(function () {
      window.scrollTo({ top: app.tabScroll[app.activeTab] || 0, behavior: "auto" });
    });
    window.setInterval(function () {
      if (document.visibilityState !== "visible") return;
      var staleAfter = app.eventSource ? 30000: 5000;
      if (Date.now() - app.lastStateAt > staleAfter) loadState(false);
    }, 5000);
  }

  bootstrap();
}());
