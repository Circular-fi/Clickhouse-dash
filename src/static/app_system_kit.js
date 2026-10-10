// What the System sections share (docs/system.md): the pieces of a section's page, once (ARCH-F-196). A section
// (app_system_overview.js, app_system_queries.js, app_system_disks.js) builds its content from them:
//   sectionBar   its filter bar (the time range first, the section's filters, the refresh button);
//   issueBlock   a panel that could not be read: why, and the GRANT to run;
//   card, cardHead, part, dataTable   the cards, the parts of the Overview and the tables;
//   errorTone    the tone of an error share (one threshold for every section);
//   openInQuery  the Query page's editor with a statement, never run;
//   hostId, number, features, seconds, SEP.
// The charts and the time range of a section are app_system_charts.js's.

import { api } from "./app_api.js";
import { h } from "./app_dom.js";
import { format } from "./app_format.js";
import { router } from "./app_router.js";
import { features as featuresMod, state, storage } from "./app_state.js";
import { badge } from "./app_ui_badge.js";
import { copy as copyMod } from "./app_ui_copy.js";
import { util } from "./app_util.js";

const SEP = " · ";

const hostId = () => String(state?.selectedHostId || "");
const features = () => featuresMod.get("system");
const number = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

// A section's filter bar (ctx.bar, ns.filterBar): the time range first
// (`range`: its idPrefix; the picker root is returned for
// ns.timeRange.create), the section's `fields` (pickers: { select,
// narrow, summary }) and `chips` (toggle chips: { id, label, title,
// pressed, onChange }), then at the right end the refresh icon button,
// the action: a change applies at once. No live refresh: nothing reads on
// a timer. No caption: the header names the server, the panels say what
// they show.
function sectionBar(ctx, { id, label, onRefresh, range = "", fields = [], chips = [] }) {
  const { bar } = ctx;
  const rangeRoot = range ? bar.range(range) : null;
  const pickers = fields.map((field) => bar.field(field.select, field));
  const toggles = chips.map((chip) => bar.chip(chip));
  const button = bar.iconAction({ id: `systemRefresh-${id}`, label: `Refresh ${label}` });
  bar.onSubmit = () => onRefresh?.();
  return { bar: bar.form, rangeRoot, pickers, chips: toggles, button };
}

const REASONS = {
  disabled: "Disabled",
  not_granted: "Not granted",
  unsupported: "Not supported",
  window_too_large: "Too large",
  readonly_account: "Read-only account",
  failed: "Unavailable",
};

function issueText(issue) {
  const table = issue.table || "tables";
  switch (issue.reason) {
    case "disabled": return `system.${table} is disabled on this server (server configuration).`;
    case "not_granted": return `The system account cannot read system.${table}.`;
    case "unsupported": return `This ClickHouse version lacks a column of system.${table}.`;
    case "window_too_large": return "The read hit its time or row limit.";
    case "readonly_account": return "The system account's profile has readonly = 1, so the query limits cannot be set (use readonly = 2).";
    default: return util.errorText(issue.message, `system.${table} could not be read.`);
  }
}

// A panel that could not be read: why, and the GRANT to run when a grant
// is missing. One element per issue, in place of the panel's content.
function issueBlock(issue) {
  const el = h("div", { class: "systemIssue", dataset: { reason: issue.reason || "failed", panel: issue.panel || "" } },
    h("div", { class: "systemIssue__head" },
      badge.el(REASONS[issue.reason] || REASONS.failed, { tone: issue.reason === "disabled" ? "neutral" : "warn" }),
      h("span", { class: "systemIssue__text" }, issue.text || issueText(issue))));
  if (issue.hint) {
    const copy = copyMod.button(null, () => issue.hint, { label: "Copy the GRANT statement", className: "systemIssue__copy" });
    el.appendChild(h("div", { class: "systemIssue__hint" }, h("code", { class: "systemIssue__code" }, issue.hint), copy));
  }
  if (issue.message && issue.reason !== "failed") el.title = issue.message;
  return el;
}

// A card's head: its title, a count and an extra element (a badge).
function cardHead(title, count = "", extra = null) {
  return h("div", { class: "systemCard__head" },
    h("h3", { class: "systemCard__title" }, title),
    count ? h("span", { class: "systemCard__count" }, count) : null,
    extra);
}

function card(key, title, count, extra) {
  return h("section", { class: "systemCard", dataset: { card: key } }, cardHead(title, count, extra));
}

// A part of the Overview: a heading (h2) and its content; extra sits on
// the heading's right.
function part(key, title, extra = null) {
  const head = h("div", { class: "pagePart__head" }, h("h2", { class: "pagePart__title", id: `systemPartTitle-${key}` }, title), extra);
  const body = h("div", { class: "pagePart__body" });
  const el = h("section", { class: "pagePart", id: `systemPart-${key}`, dataset: { part: key }, aria: { labelledby: `systemPartTitle-${key}` } }, head, body);
  return { el, head, body };
}

// A delay in whole seconds: "0 s" rather than "0 ns".
const seconds = (value) => (Number(value) > 0 ? format.duration.fromSeconds(value) : "0 s");

function dataTable(id, headers, rows) {
  const head = h("tr", null, headers.map((header) => h("th", { scope: "col", class: [header.num && "num", header.className], title: header.title || null }, header.label)));
  return h("div", { class: "dataTableWrap" },
    h("table", { class: "dataTable dataTable--compact systemTable", id }, h("thead", null, head), h("tbody", null, rows)));
}

// The error share of a section's queries: neutral under 1 %, a warning to 5 %, danger from there.
const ERROR_WARN = 0.01;
const ERROR_DANGER = 0.05;
function errorTone(errors, calls) {
  const ratio = Number(calls) > 0 ? Number(errors) / Number(calls) : 0;
  return ratio >= ERROR_DANGER ? "error" : ratio >= ERROR_WARN ? "warn" : "neutral";
}

// The Query page's editor with `sql` (formatted by the server unless formatted is false), through the session draft the
// Query page reads on load. It never runs there by itself.
async function openInQuery(sql, { formatted = true } = {}) {
  let text = String(sql || "");
  if (formatted) {
    const out = await api.formatSqls(state.selectedHostId, [text]);
    if (!Array.isArray(out) || !out.length || !String(out[0] || "").trim()) throw new Error("Formatter returned an empty query.");
    text = out[0];
  }
  storage.pref(storage.KEYS.editorDraft, "", { session: true }).set(text);
  window.location.assign(router.url("/query"));
}

export const kit = Object.freeze({ sectionBar, issueBlock, issueText, cardHead, card, part, dataTable, seconds, hostId, number, features, errorTone, ERROR_WARN, ERROR_DANGER, openInQuery, SEP });
