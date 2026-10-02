(() => {
  "use strict";
  // Time range picker of the Observability filter bars (Traces, Logs,
  // Metrics), modelled on Grafana's
  // TimeRangePicker: a raw range keeps what the user typed ("now-6h", "now",
  // "2026-09-19 14:00:00") and is resolved to milliseconds for each request,
  // so relative ranges follow the clock. All dates are browser-local time,
  // like the timestamps the page displays.
  const ns = (window.ChDash = window.ChDash || {});

  const UNITS = "yMwdhms";
  const UNIT_WORDS = { s: "second", m: "minute", h: "hour", d: "day", w: "week", M: "month", y: "year" };
  const RECENT_KEY = "chdash.traceTimeRanges.v1";
  const RECENT_LIMIT = 2;
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // --- Date math (Grafana @grafana/data datemath.ts semantics) -------------

  function addMonths(date, months) {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + months);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, last));
  }

  function addUnits(source, amount, unit) {
    const date = new Date(source.getTime());
    if (unit === "y") addMonths(date, 12 * amount);
    else if (unit === "M") addMonths(date, amount);
    else if (unit === "w") date.setDate(date.getDate() + 7 * amount);
    else if (unit === "d") date.setDate(date.getDate() + amount);
    else if (unit === "h") date.setTime(date.getTime() + amount * 3600000);
    else if (unit === "m") date.setTime(date.getTime() + amount * 60000);
    else if (unit === "s") date.setTime(date.getTime() + amount * 1000);
    return date;
  }

  // Weeks start on Monday.
  function startOfUnit(source, unit) {
    const date = new Date(source.getTime());
    if (unit === "y") { date.setMonth(0, 1); date.setHours(0, 0, 0, 0); }
    else if (unit === "M") { date.setDate(1); date.setHours(0, 0, 0, 0); }
    else if (unit === "w") { date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); date.setHours(0, 0, 0, 0); }
    else if (unit === "d") date.setHours(0, 0, 0, 0);
    else if (unit === "h") date.setMinutes(0, 0, 0);
    else if (unit === "m") date.setSeconds(0, 0);
    else if (unit === "s") date.setMilliseconds(0);
    return date;
  }

  function endOfUnit(source, unit) {
    return new Date(addUnits(startOfUnit(source, unit), 1, unit).getTime() - 1);
  }

  const ABSOLUTE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

  // "2026-09-19", "2026-09-19 14:00" or "2026-09-19 14:00:00(.123)", local time.
  function parseAbsolute(text) {
    const match = ABSOLUTE_RE.exec(String(text || "").trim());
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const hasTime = match[4] !== undefined;
    const hours = hasTime ? Number(match[4]) : 0;
    const minutes = hasTime ? Number(match[5]) : 0;
    const seconds = match[6] ? Number(match[6]) : 0;
    const millis = match[7] ? Number(match[7].padEnd(3, "0")) : 0;
    if (month < 1 || month > 12 || day < 1 || hours > 23 || minutes > 59 || seconds > 59) return null;
    const date = new Date(2000, month - 1, day, hours, minutes, seconds, millis);
    date.setFullYear(year);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return { date, dateOnly: !hasTime, hours, minutes, seconds };
  }

  // Applies "-6h", "/d", "+1w-2d/h"... left to right. Rounding goes to the
  // start of the unit, or to its end when roundUp (a range's To side).
  function applyDateMath(source, math, roundUp) {
    let date = source;
    let index = 0;
    while (index < math.length) {
      const op = math[index++];
      if (op !== "/" && op !== "+" && op !== "-") return null;
      let amount = 1;
      if (op !== "/") {
        const digits = /^\d{1,5}/.exec(math.slice(index));
        if (digits) { amount = Number(digits[0]); index += digits[0].length; }
      }
      const unit = math[index++];
      if (!unit || !UNITS.includes(unit)) return null;
      if (op === "/") date = roundUp ? endOfUnit(date, unit) : startOfUnit(date, unit);
      else date = addUnits(date, op === "+" ? amount : -amount, unit);
    }
    return date;
  }

  // Milliseconds for one side of a range, NaN when the text is not valid.
  function parseTime(text, roundUp, nowMs = Date.now()) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return NaN;
    let base;
    let math;
    if (/^now/i.test(raw)) {
      base = new Date(nowMs);
      math = raw.slice(3);
    } else {
      const anchor = raw.indexOf("||");
      const head = anchor >= 0 ? raw.slice(0, anchor) : raw;
      math = anchor >= 0 ? raw.slice(anchor + 2) : "";
      const absolute = parseAbsolute(head);
      if (!absolute) return NaN;
      base = absolute.date;
      // A bare date as To covers that whole day.
      if (!math && absolute.dateOnly && roundUp) return endOfUnit(base, "d").getTime();
    }
    const date = applyDateMath(base, math.replace(/\s+/g, ""), roundUp);
    return date && Number.isFinite(date.getTime()) ? date.getTime() : NaN;
  }

  function resolveRange(raw, nowMs = Date.now()) {
    return { startMs: parseTime(raw?.from, false, nowMs), endMs: parseTime(raw?.to, true, nowMs) };
  }

  function isRelative(raw) {
    return /now/i.test(String(raw?.from || "")) || /now/i.test(String(raw?.to || ""));
  }

  // --- Quick ranges (Grafana DateTimePickers/options.ts) --------------------

  // Kept short enough that the list never scrolls next to the calendar, with
  // the recently used ranges below it; any other span can be typed in the
  // search ("45m", "30d") or the From / To fields.
  const QUICK_RANGES = [
    ["now-5m", "now", "Last 5 minutes"],
    ["now-15m", "now", "Last 15 minutes"],
    ["now-1h", "now", "Last 1 hour"],
    ["now-6h", "now", "Last 6 hours"],
    ["now-24h", "now", "Last 24 hours"],
    ["now-7d", "now", "Last 7 days"],
    ["now/d", "now/d", "Today"],
    ["now-1d/d", "now-1d/d", "Yesterday"],
  ].map(([from, to, display]) => ({ from, to, display }));

  const sameRange = (a, b) => String(a?.from || "") === String(b?.from || "") && String(a?.to || "") === String(b?.to || "");

  // "now-60m" style span for a number of minutes, in the unit quick ranges use.
  function minutesToSpan(minutes) {
    const value = Math.max(1, Math.round(Number(minutes) || 60));
    if (value % 1440 === 0 && value >= 2880) return `${value / 1440}d`;
    if (value % 60 === 0) return `${value / 60}h`;
    return `${value}m`;
  }

  function formatMinutes(minutes) {
    const value = Math.max(1, Math.round(Number(minutes) || 0));
    const [size, word] = value % 1440 === 0 ? [1440, "day"] : value % 60 === 0 ? [60, "hour"] : [1, "minute"];
    const count = value / size;
    return `${count} ${word}${count === 1 ? "" : "s"}`;
  }

  // Typing "45m", "now-45m" or "last 45m" in the quick search offers that range.
  function durationOption(text) {
    const match = /^(?:last\s*|now-)?(\d{1,5})\s*([smhdwMy])$/.exec(String(text || "").trim());
    if (!match) return null;
    const amount = Number(match[1]);
    if (!amount) return null;
    return { from: `now-${amount}${match[2]}`, to: "now", display: `Last ${amount} ${UNIT_WORDS[match[2]]}${amount === 1 ? "" : "s"}` };
  }

  // --- Formatting -------------------------------------------------------------

  function formatDateTime(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function dayKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // Normalized text of one side: absolute values are rewritten zero-padded.
  function normalizeTime(text) {
    const raw = String(text || "").trim();
    const absolute = parseAbsolute(raw);
    if (!absolute) return raw;
    return absolute.dateOnly ? dayKey(absolute.date) : formatDateTime(absolute.date.getTime());
  }

  // The label of an applied range, the same on every view (and in the
  // recently used list): a known range by name ("Last 1 hour"), "Last N
  // units" for now-N to now, otherwise both sides as 24 h local time,
  // "YYYY-MM-DD HH:mm \u2192 HH:mm" with the date repeated only when the day
  // changes, and seconds only when the range is under 10 minutes. Relative
  // sides ("now-2d") are shown as typed. Absolute ranges go through
  // ns.format.range, the same rule; the local fallback covers a page without
  // app_format.js and the mixed absolute / relative ranges.
  const SECONDS_BELOW_MS = 10 * 60000;

  function describeRange(raw, nowMs = Date.now()) {
    const quick = QUICK_RANGES.find((option) => sameRange(option, raw));
    if (quick) return { text: quick.display, relative: true };
    const from = String(raw?.from || "").trim();
    const to = String(raw?.to || "").trim();
    if (to === "now") {
      const last = durationOption(from);
      if (last && /^now-/.test(from)) return { text: last.display, relative: true };
    }
    const a = parseAbsolute(from);
    const b = parseAbsolute(to);
    const startMs = parseTime(from, false, nowMs);
    const endMs = parseTime(to, true, nowMs);
    // Both sides absolute: the shared range format (app_format.js).
    if (a && b && Number.isFinite(startMs) && Number.isFinite(endMs) && ns.format?.range) return { text: ns.format.range(startMs, endMs), relative: false };
    const seconds = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && endMs - startMs < SECONDS_BELOW_MS;
    const stamp = (ms) => { const text = formatDateTime(ms); return seconds ? text : text.slice(0, 16); };
    const aText = a ? stamp(startMs) : from;
    let bText = b ? stamp(endMs) : to;
    if (a && b && aText.slice(0, 10) === bText.slice(0, 10)) bText = bText.slice(11);
    return { text: `${aText} \u2192 ${bText}`, relative: !(a && b) };
  }

  function timeZoneLabel(nowMs = Date.now()) {
    let zone = "";
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) { zone = ""; }
    const offset = -new Date(nowMs).getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const abs = Math.abs(offset);
    const utc = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    return zone ? `${zone} (${utc})` : utc;
  }

  // --- Recently used ranges ---------------------------------------------------

  function loadRecent() {
    try {
      const items = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(items) ? items.filter((item) => item && typeof item.from === "string" && typeof item.to === "string").slice(0, RECENT_LIMIT) : [];
    } catch (_) {
      return [];
    }
  }

  function saveRecent(raw) {
    const items = [{ from: raw.from, to: raw.to }, ...loadRecent().filter((item) => !sameRange(item, raw))].slice(0, RECENT_LIMIT);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(items)); } catch (_) { /* storage may be unavailable */ }
    return items;
  }

  // --- Picker -----------------------------------------------------------------

  const ICONS = {
    prevYear: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.5 3.5 4 8l4.5 4.5M12.5 3.5 8 8l4.5 4.5"/></svg>',
    prevMonth: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
    nextMonth: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
    nextYear: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5 8 8l-4.5 4.5M7.5 3.5 12 8l-4.5 4.5"/></svg>',
  };

  // Mounts the picker on the panel markup (see create()). options:
  //   getValue()            -> applied raw range { from, to }
  //   getMaxMinutes()       -> widest range the server accepts
  //   onApply(raw, source)  -> the user applied a range ("form", "quick", "recent", "shift", "zoom")
  //   open() / close()      -> open / close the dropdown (shared picker motion)
  //   settingName           -> server setting named by the max range error
  function mountPicker(el, options) {
    const { button, menu, select, fromInput, toInput, fromError, toError, rangeError, calendar, hint, applyButton, quickSearch, lists, timeZone, shiftBack, shiftForward, zoomOut } = el;
    const maxMs = () => Math.max(1, Number(options.getMaxMinutes()) || 1) * 60000;
    const cal = { year: 0, month: 0, focus: null, mode: "start", hover: null };
    const fields = { from: fromInput.closest(".timeRangeField"), to: toInput.closest(".timeRangeField") };
    const isOpen = () => button.getAttribute("aria-expanded") === "true";
    const idPrefix = String(options.idPrefix || "timeRange");

    // Calendar skeleton: header (built once), weekday names, 6 x 7 day grid.
    calendar.innerHTML = `
      <div class="timeCalendar__header">
        <button type="button" class="timeCalendar__nav" data-cal-nav="-12" aria-label="Previous year" title="Previous year">${ICONS.prevYear}</button>
        <button type="button" class="timeCalendar__nav" data-cal-nav="-1" aria-label="Previous month" title="Previous month">${ICONS.prevMonth}</button>
        <strong class="timeCalendar__title" aria-live="polite"></strong>
        <button type="button" class="timeCalendar__nav" data-cal-nav="1" aria-label="Next month" title="Next month">${ICONS.nextMonth}</button>
        <button type="button" class="timeCalendar__nav" data-cal-nav="12" aria-label="Next year" title="Next year">${ICONS.nextYear}</button>
      </div>
      <div class="timeCalendar__grid" role="grid" aria-label="Calendar"></div>`;
    const title = calendar.querySelector(".timeCalendar__title");
    const grid = calendar.querySelector(".timeCalendar__grid");

    const midnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };
    const selection = () => {
      const now = Date.now();
      return { startMs: parseTime(fromInput.value, false, now), endMs: parseTime(toInput.value, true, now) };
    };

    function buildGrid() {
      const first = new Date(cal.year, cal.month, 1);
      title.textContent = first.toLocaleDateString([], { month: "long", year: "numeric" });
      const monday = new Date(cal.year, cal.month, 1 - ((first.getDay() + 6) % 7));
      const names = [];
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
        names.push(`<span class="timeCalendar__weekday" role="columnheader" aria-label="${esc(d.toLocaleDateString([], { weekday: "long" }))}">${esc(d.toLocaleDateString([], { weekday: "short" }).slice(0, 2))}</span>`);
      }
      const rows = [`<div class="timeCalendar__row" role="row">${names.join("")}</div>`];
      for (let week = 0; week < 6; week += 1) {
        const cells = [];
        for (let i = 0; i < 7; i += 1) {
          const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + week * 7 + i);
          cells.push(`<button type="button" class="timeCalendar__day${d.getMonth() === cal.month ? "" : " is-outside"}" role="gridcell" tabindex="-1" data-day="${dayKey(d)}" data-ms="${d.getTime()}" aria-label="${esc(d.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" }))}">${d.getDate()}</button>`);
        }
        rows.push(`<div class="timeCalendar__row" role="row">${cells.join("")}</div>`);
      }
      grid.innerHTML = rows.join("");
    }

    // Updates the day classes in place, so hovering and clicking never
    // replace the element under the pointer.
    function paintGrid() {
      const { startMs, endMs } = selection();
      const startDay = Number.isFinite(startMs) ? midnight(startMs).getTime() : NaN;
      const endDay = Number.isFinite(endMs) && endMs > startMs ? midnight(endMs - 1).getTime() : NaN;
      const limit = maxMs();
      const today = midnight(Date.now()).getTime();
      const picking = cal.mode === "end" && Number.isFinite(startDay);
      const preview = picking && cal.hover != null && cal.hover >= startDay && cal.hover - startMs < limit ? cal.hover : null;
      const hi = preview != null ? preview : (Number.isFinite(endDay) && (!picking || endMs - startMs <= limit) ? endDay : NaN);
      const focusMs = cal.focus ? cal.focus.getTime() : NaN;
      for (const day of grid.querySelectorAll("[data-day]")) {
        const t = Number(day.dataset.ms);
        const disabled = picking && t - startMs >= limit;
        day.classList.toggle("is-today", t === today);
        day.classList.toggle("is-start", t === startDay);
        day.classList.toggle("is-end", t === hi);
        day.classList.toggle("is-single", t === startDay && !(hi > startDay));
        day.classList.toggle("is-inRange", t > startDay && t < hi);
        day.classList.toggle("is-preview", preview != null && t > startDay && t <= preview);
        day.classList.toggle("is-disabled", disabled);
        day.setAttribute("aria-disabled", disabled ? "true" : "false");
        day.setAttribute("aria-selected", t === startDay || t === hi ? "true" : "false");
        day.tabIndex = t === focusMs ? 0 : -1;
      }
      if (!grid.querySelector('[data-day][tabindex="0"]')) grid.querySelector("[data-day]:not(.is-outside)")?.setAttribute("tabindex", "0");
    }

    function showMonth(date) {
      if (date.getFullYear() !== cal.year || date.getMonth() !== cal.month) {
        cal.year = date.getFullYear();
        cal.month = date.getMonth();
        buildGrid();
      }
      paintGrid();
    }

    function setMode(mode) {
      cal.mode = mode;
      if (mode !== "end") cal.hover = null;
      fields.from?.classList.toggle("is-active", mode === "start");
      fields.to?.classList.toggle("is-active", mode === "end");
      if (hint) hint.textContent = mode === "end" ? `Pick the end date · max ${formatMinutes(options.getMaxMinutes())}` : "Pick the start date";
      paintGrid();
    }

    function focusDay(date, { moveFocus = true } = {}) {
      cal.focus = midnight(date.getTime());
      if (cal.mode === "end") cal.hover = cal.focus.getTime();
      showMonth(cal.focus);
      if (moveFocus) grid.querySelector(`[data-day="${dayKey(cal.focus)}"]`)?.focus({ preventScroll: true });
    }

    function setError(node, input, message) {
      if (!node) return;
      node.textContent = message || "";
      node.hidden = !message;
      input?.setAttribute("aria-invalid", message ? "true" : "false");
    }

    function clearErrors() {
      setError(fromError, fromInput, "");
      setError(toError, toInput, "");
      setError(rangeError, null, "");
    }

    function pickDay(dayButton, byPointer) {
      const t = Number(dayButton.dataset.ms);
      const day = new Date(t);
      const { startMs } = selection();
      cal.focus = day;
      clearErrors();
      if (cal.mode !== "end" || !Number.isFinite(startMs) || t < midnight(startMs).getTime()) {
        // Start picked: the calendar moves on to the end date by itself.
        fromInput.value = `${dayKey(day)} 00:00:00`;
        const { endMs } = selection();
        if (!(endMs > t) || endMs - t > maxMs()) toInput.value = "";
        setMode("end");
        cal.hover = t;
        paintGrid();
        if (byPointer) toInput.focus({ preventScroll: true });
        return;
      }
      if (dayButton.classList.contains("is-disabled")) return;
      let endMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59).getTime();
      if (endMs - startMs > maxMs()) endMs = startMs + maxMs();
      toInput.value = formatDateTime(endMs);
      setMode("start");
      applyButton.focus({ preventScroll: true });
    }

    function validate() {
      const now = Date.now();
      const from = normalizeTime(fromInput.value);
      const to = normalizeTime(toInput.value);
      const startMs = parseTime(from, false, now);
      const endMs = parseTime(to, true, now);
      const example = formatDateTime(Math.floor(now / 3600000) * 3600000);
      const invalid = `Enter a date like ${example} or a relative time like now-6h.`;
      const errors = { from: Number.isFinite(startMs) ? "" : invalid, to: Number.isFinite(endMs) ? "" : invalid, range: "" };
      if (!errors.from && !errors.to) {
        if (startMs >= endMs) errors.range = '"From" must be before "To".';
        else if (endMs - startMs > maxMs()) errors.range = `Max range is ${formatMinutes(options.getMaxMinutes())} (server setting ${options.settingName || "traces.max_lookback_minutes"}).`;
      }
      return { raw: { from, to }, errors, ok: !errors.from && !errors.to && !errors.range };
    }

    function applyForm() {
      const result = validate();
      setError(fromError, fromInput, result.errors.from);
      setError(toError, toInput, result.errors.to);
      setError(rangeError, null, result.errors.range);
      if (!result.ok) {
        (result.errors.from ? fromInput : result.errors.to ? toInput : null)?.focus({ preventScroll: true });
        return;
      }
      fromInput.value = result.raw.from;
      toInput.value = result.raw.to;
      if (!QUICK_RANGES.some((option) => sameRange(option, result.raw))) saveRecent(result.raw);
      options.onApply(result.raw, "form");
    }

    const fits = (raw, now) => {
      const { startMs, endMs } = resolveRange(raw, now);
      return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && endMs - startMs <= maxMs();
    };

    function listItem(raw, label, kind) {
      const current = sameRange(raw, options.getValue());
      return `<button type="button" class="timeRangeList__item${current ? " is-selected" : ""}" data-kind="${kind}" data-from="${esc(raw.from)}" data-to="${esc(raw.to)}"${current ? ' aria-current="true"' : ""}>${esc(label)}</button>`;
    }

    function renderLists() {
      const now = Date.now();
      const query = String(quickSearch.value || "").trim();
      const needle = query.toLowerCase();
      const matches = (text, raw) => !needle || text.toLowerCase().includes(needle) || raw.from.toLowerCase() === needle;
      let quick = QUICK_RANGES.filter((option) => fits(option, now) && matches(option.display, option));
      const typed = durationOption(query);
      if (typed && fits(typed, now) && !quick.some((option) => sameRange(option, typed))) quick = [typed, ...quick];
      const recent = loadRecent().filter((raw) => fits(raw, now)).map((raw) => ({ raw, label: describeRange(raw).text })).filter((item) => matches(item.label, item.raw));
      const parts = [];
      if (recent.length) {
        parts.push(`<div class="timeRangeList__heading" id="${idPrefix}RecentRangesHeading">Recently used</div>`);
        parts.push(`<div class="timeRangeList__group" role="group" aria-labelledby="${idPrefix}RecentRangesHeading" data-group="recent">${recent.map((item) => listItem(item.raw, item.label, "recent")).join("")}</div>`);
      }
      parts.push(`<div class="timeRangeList__heading" id="${idPrefix}QuickRangesHeading">Quick ranges</div>`);
      parts.push(quick.length
        ? `<div class="timeRangeList__group" role="group" aria-labelledby="${idPrefix}QuickRangesHeading" data-group="quick">${quick.map((option) => listItem(option, option.display, "quick")).join("")}</div>`
        : `<div class="timeRangeList__empty">No quick range matches \u201c${esc(query)}\u201d.</div>`);
      lists.innerHTML = parts.join("");
    }

    function currentWindow() {
      const { startMs, endMs } = resolveRange(options.getValue(), Date.now());
      return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? { startMs, endMs } : null;
    }

    function applyAbsolute(startMs, endMs, source) {
      const raw = { from: formatDateTime(startMs), to: formatDateTime(endMs) };
      options.onApply(raw, source);
      syncForm();
    }

    // Grafana timePicker.ts getShiftedTimeRange: half the span, and a forward
    // shift crossing now ends at now.
    function shift(direction) {
      const range = currentWindow();
      if (!range) return;
      const half = Math.round((range.endMs - range.startMs) / 2);
      let startMs = range.startMs + direction * half;
      let endMs = range.endMs + direction * half;
      const now = Date.now();
      if (direction > 0 && endMs > now && range.endMs < now) { endMs = now; startMs = range.startMs; }
      applyAbsolute(startMs, endMs, "shift");
    }

    // getZoomedTimeRange: twice the span around the same center, capped by the
    // server's max range and not reaching past now.
    function zoom() {
      const range = currentWindow();
      if (!range) return;
      const span = Math.min(maxMs(), Math.max(60000, (range.endMs - range.startMs) * 2));
      const center = (range.startMs + range.endMs) / 2;
      let startMs = Math.round(center - span / 2);
      let endMs = startMs + span;
      const now = Date.now();
      if (endMs > now && range.endMs <= now + 1000) { endMs = Math.max(now, range.endMs); startMs = endMs - span; }
      applyAbsolute(startMs, endMs, "zoom");
    }

    function refreshNav() {
      const range = currentWindow();
      if (zoomOut) zoomOut.disabled = !range || range.endMs - range.startMs >= maxMs();
      if (shiftBack) shiftBack.disabled = !range;
      if (shiftForward) shiftForward.disabled = !range;
    }

    // Form, calendar and lists follow the applied range.
    function syncForm() {
      const raw = options.getValue();
      fromInput.value = raw.from;
      toInput.value = raw.to;
      clearErrors();
      const { startMs } = selection();
      cal.focus = Number.isFinite(startMs) ? midnight(startMs) : midnight(Date.now());
      cal.year = -1;
      setMode("start");
      showMonth(cal.focus);
      renderLists();
      refreshNav();
      if (timeZone) timeZone.textContent = `Browser time · ${timeZoneLabel()}`;
    }

    function refresh() {
      const { text, relative } = describeRange(options.getValue());
      button.textContent = relative ? `Time range · ${text}` : text;
      button.title = `Time range: ${text}`;
      if (select?.options[0]) select.options[0].textContent = text;
      if (isOpen()) { renderLists(); refreshNav(); }
    }

    function openPanel() {
      syncForm();
      quickSearch.value = "";
      renderLists();
      menu.style.setProperty("--timeRangeButtonWidth", `${button.offsetWidth}px`);
      options.open();
      requestAnimationFrame(() => {
        if (!isOpen()) return;
        fromInput.focus({ preventScroll: true });
        fromInput.select();
      });
    }

    function closePanel({ restoreFocus = false } = {}) {
      options.close();
      if (restoreFocus) button.focus({ preventScroll: true });
    }

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      if (isOpen()) closePanel();
      else openPanel();
    });

    // Escape: the host's picker is an ns.layers layer (it closes the panel and
    // gives the focus back to the button).

    // Tabbing out of the panel closes it (it is a dropdown, not a modal).
    menu.addEventListener("focusout", (event) => {
      const next = event.relatedTarget;
      if (isOpen() && next && !menu.contains(next) && next !== button) closePanel();
    });

    for (const [input, mode, errorNode] of [[fromInput, "start", fromError], [toInput, "end", toError]]) {
      input.addEventListener("focus", () => { if (cal.mode !== mode) setMode(mode); });
      input.addEventListener("input", () => {
        setError(errorNode, input, "");
        setError(rangeError, null, "");
        const ms = parseTime(input.value, mode === "end");
        if (Number.isFinite(ms)) { cal.focus = midnight(mode === "end" ? ms - 1 : ms); showMonth(cal.focus); }
        else paintGrid();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        applyForm();
      });
    }

    calendar.addEventListener("click", (event) => {
      const nav = event.target.closest("[data-cal-nav]");
      if (nav) {
        const step = Number(nav.dataset.calNav);
        const base = cal.focus || new Date(cal.year, cal.month, 1);
        const target = new Date(base.getTime());
        addMonths(target, step);
        cal.focus = midnight(target.getTime());
        showMonth(cal.focus);
        return;
      }
      const day = event.target.closest("[data-day]");
      if (day) pickDay(day, event.detail > 0);
    });
    grid.addEventListener("mouseover", (event) => {
      const day = event.target.closest("[data-day]");
      if (!day || cal.mode !== "end") return;
      const t = Number(day.dataset.ms);
      if (t !== cal.hover) { cal.hover = t; paintGrid(); }
    });
    grid.addEventListener("mouseleave", () => {
      if (cal.mode === "end" && cal.hover != null) { cal.hover = null; paintGrid(); }
    });
    grid.addEventListener("keydown", (event) => {
      const day = event.target.closest("[data-day]");
      if (!day) return;
      const current = new Date(Number(day.dataset.ms));
      const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      let next = null;
      if (event.key in steps) next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + steps[event.key]);
      else if (event.key === "Home") next = new Date(current.getFullYear(), current.getMonth(), current.getDate() - ((current.getDay() + 6) % 7));
      else if (event.key === "End") next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 6 - ((current.getDay() + 6) % 7));
      else if (event.key === "PageUp" || event.key === "PageDown") {
        next = new Date(current.getTime());
        addMonths(next, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
      }
      if (!next) return;
      event.preventDefault();
      focusDay(next);
    });

    applyButton.addEventListener("click", applyForm);

    quickSearch.addEventListener("input", renderLists);
    quickSearch.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        lists.querySelector(".timeRangeList__item")?.click();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        lists.querySelector(".timeRangeList__item")?.focus({ preventScroll: true });
      }
    });
    lists.addEventListener("click", (event) => {
      const item = event.target.closest(".timeRangeList__item");
      if (!item) return;
      const raw = { from: item.dataset.from, to: item.dataset.to };
      if (item.dataset.kind === "recent") saveRecent(raw);
      options.onApply(raw, item.dataset.kind);
    });
    lists.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...lists.querySelectorAll(".timeRangeList__item")];
      const index = items.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      if (event.key === "ArrowUp" && index === 0) quickSearch.focus({ preventScroll: true });
      else items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus({ preventScroll: true });
    });

    shiftBack?.addEventListener("click", () => shift(-1));
    shiftForward?.addEventListener("click", () => shift(1));
    zoomOut?.addEventListener("click", zoom);

    refresh();
    return { refresh, open: openPanel, close: closePanel, isOpen };
  }

  // The range panel of one view: absolute From / To with a calendar on the
  // left, quick and recently used ranges on the right, the time zone and the
  // shift / zoom buttons in the footer. Every id starts with the view's
  // prefix ("tracesRangeStart", "logsQuickRanges"...).
  function panelHtml(p) {
    const field = (side, label, placeholder) => `
            <label class="timeRangeField${side === "Start" ? " is-active" : ""}">
              <span class="timeRangeField__label">${label}</span>
              <input id="${p}Range${side}" class="timeRangeField__input" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="${placeholder}" aria-label="Range ${side.toLowerCase()}" aria-describedby="${p}Range${side}Error" />
              <span id="${p}Range${side}Error" class="timeRangeField__error" role="alert" hidden></span>
            </label>`;
    const nav = (id, label, path) => `<button id="${p}${id}" class="timeRangeNav" type="button" aria-label="${label}" title="${label}"><svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg></button>`;
    return `<div id="${p}TimeRangePanel" class="themeSelect__menu tracePicker__menu timeRangePanel" role="dialog" aria-label="Time range" tabindex="-1" hidden>
        <div class="timeRangePanel__body">
          <section id="${p}CustomRange" class="timeRangePanel__absolute" aria-labelledby="${p}AbsoluteRangeTitle">
            <h3 id="${p}AbsoluteRangeTitle" class="timeRangePanel__title">Absolute time range</h3>${field("Start", "From", "YYYY-MM-DD hh:mm:ss or now-6h")}${field("End", "To", "YYYY-MM-DD hh:mm:ss or now")}
            <div id="${p}TimeCalendarHint" class="timeCalendar__hint" aria-live="polite">Pick the start date</div>
            <div id="${p}TimeCalendar" class="timeCalendar"></div>
            <div id="${p}RangeError" class="timeRangePanel__error" role="alert" hidden></div>
            <button id="${p}CustomRangeApply" class="button button--primary timeRangePanel__apply" type="button">Apply time range</button>
          </section>
          <section class="timeRangePanel__quick" aria-label="Quick ranges">
            <input id="${p}QuickRangeSearch" class="timeRangePanel__search" type="search" autocomplete="off" spellcheck="false" placeholder="Search quick ranges" aria-label="Search quick ranges" />
            <div id="${p}QuickRanges" class="timeRangeList"></div>
          </section>
        </div>
        <footer class="timeRangePanel__footer">
          <span id="${p}TimeZone" class="timeRangePanel__zone">Browser time</span>
          <div class="timeRangePanel__nav">
            ${nav("RangeShiftBack", "Move time range backwards", '<path d="M10 3.5 5.5 8l4.5 4.5"/>')}
            ${nav("RangeZoomOut", "Zoom out time range", '<circle cx="7" cy="7" r="4.25"/><path d="M5 7h4M10.2 10.2 13.5 13.5"/>')}
            ${nav("RangeShiftForward", "Move time range forwards", '<path d="M6 3.5 10.5 8 6 12.5"/>')}
          </div>
        </footer>
      </div>`;
  }

  // Builds the range panel in a view's filter bar picker (the shipped
  // .tracePicker--range root: its hidden select and its button) and mounts
  // the picker on it. options are mountPicker's, plus idPrefix (the view).
  // Returns the picker and its elements (el).
  function create(root, options) {
    const p = String(options.idPrefix || "timeRange");
    const select = root.querySelector(":scope > select");
    const button = root.querySelector(":scope > .tracePicker__button");
    let menu = root.querySelector(":scope > .timeRangePanel");
    if (!menu) {
      root.insertAdjacentHTML("beforeend", panelHtml(p));
      menu = root.lastElementChild;
    }
    button.setAttribute("aria-controls", menu.id);
    const part = (suffix) => menu.querySelector(`#${p}${suffix}`);
    const el = {
      button, menu, select,
      fromInput: part("RangeStart"),
      toInput: part("RangeEnd"),
      fromError: part("RangeStartError"),
      toError: part("RangeEndError"),
      rangeError: part("RangeError"),
      calendar: part("TimeCalendar"),
      hint: part("TimeCalendarHint"),
      applyButton: part("CustomRangeApply"),
      quickSearch: part("QuickRangeSearch"),
      lists: part("QuickRanges"),
      timeZone: part("TimeZone"),
      shiftBack: part("RangeShiftBack"),
      shiftForward: part("RangeShiftForward"),
      zoomOut: part("RangeZoomOut"),
    };
    return { ...mountPicker(el, { ...options, idPrefix: p }), el };
  }

  ns.timeRange = {
    QUICK_RANGES,
    parseTime,
    resolveRange,
    isRelative,
    describeRange,
    formatDateTime,
    formatMinutes,
    minutesToSpan,
    timeZoneLabel,
    loadRecent,
    mountPicker,
    create,
  };
})();
