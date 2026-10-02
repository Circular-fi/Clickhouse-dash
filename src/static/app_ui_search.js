(() => {
  "use strict";
  // ns.search: every search and filter field of the app, one behaviour and
  // one look (.uiSearch, style.css "Components: search").
  //
  //   bind(input, onChange, { debounceMs, compact }) -> { flush(), cancel(), clear() }
  //     onChange(value) once typing pauses for debounceMs (the one delay,
  //     util.SEARCH_DEBOUNCE_MS = 200 ms; 0 for a cheap filter that follows
  //     every key), at once on Enter and on the field's clear button. Escape
  //     empties a filled field and stops there; on an empty field it goes on
  //     to close what holds the field (a menu, a panel).
  //   within(root, selector, onChange, options) -> { flush(), cancel() }
  //     The same for fields a view renders again: one delegated listener on
  //     `root`; onChange(value, input). flush() applies a typed value still
  //     waiting for the delay: call it before another control re-renders the
  //     view, so the render does not write the old value back into the field.
  const ns = window.ChDash;
  if (!ns) return;

  function controller(onChange, debounceMs) {
    let last = null;
    const run = () => { if (last) onChange(last.value, last); };
    const later = debounceMs > 0 ? ns.util.debounce(run, debounceMs) : null;
    return {
      typed(input) { last = input; if (later) later(); else run(); },
      now(input) { last = input; later?.cancel(); run(); },
      cancel() { later?.cancel(); },
      // The waiting call now, if there is one.
      flush() { later?.flush(); },
    };
  }

  function onKeydown(event, input, ctl) {
    if (event.key === "Enter") {
      ctl.now(input);
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      ctl.now(input);
    }
  }

  function style(input, compact) {
    input.classList.add("uiSearch");
    input.classList.toggle("uiSearch--compact", !!compact);
  }

  function bind(input, onChange, { debounceMs = ns.util.SEARCH_DEBOUNCE_MS, compact = false } = {}) {
    if (!input || typeof onChange !== "function") return null;
    style(input, compact);
    const ctl = controller(onChange, debounceMs);
    input.addEventListener("input", () => ctl.typed(input));
    // The clear button of a type="search" field (Chrome, Safari).
    input.addEventListener("search", () => { if (!input.value) ctl.now(input); });
    input.addEventListener("keydown", (event) => onKeydown(event, input, ctl));
    return {
      flush: () => ctl.now(input),
      cancel: () => ctl.cancel(),
      clear() { input.value = ""; ctl.now(input); },
    };
  }

  function within(root, selector, onChange, { debounceMs = ns.util.SEARCH_DEBOUNCE_MS, compact = false } = {}) {
    if (!root || typeof onChange !== "function") return null;
    const ctl = controller(onChange, debounceMs);
    const field = (event) => (event.target instanceof HTMLInputElement && event.target.matches(selector) ? event.target : null);
    root.addEventListener("input", (event) => { const input = field(event); if (input) { style(input, compact); ctl.typed(input); } });
    root.addEventListener("search", (event) => { const input = field(event); if (input && !input.value) ctl.now(input); }, true);
    root.addEventListener("keydown", (event) => { const input = field(event); if (input) onKeydown(event, input, ctl); });
    return { flush: () => ctl.flush(), cancel: () => ctl.cancel() };
  }

  ns.search = Object.freeze({ bind, within });
})();
