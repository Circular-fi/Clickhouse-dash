// The instances that the usage of the keys sums. The docs are in docs/mcp-integration-page.md, "Instances".
// ChDash instances that share the directory of mcp.usage each write their own file. They read the files of the others.
// So every answer of the usage is the sum of all of them. This module says where a figure is a sum.
// Such figures are the usage of a key and the column Used of the keys page. The Usage tab has its Instance list in the bar instead (app_mcp_bar.js).
// This module also warns when a file is left out of a sum. The warnings show on the Usage tab, in the usage of a key, and on the keys page.
//
//   ns.mcpInstances.create({ prefix })              -> note
//       note.el                                     "3 instances" (`prefix` goes before it: "Summed over ") is a button. The button opens a popover with the list.
//                                                   The popover lists each instance by name. It has a badge when its file is not read. It shows the time of its last write.
//                                                   It is hidden for fewer than two instances. Nothing is summed in that case.
//       note.update(instances, { me, now })         The list that the answer holds. It is the answer's `instances`, with this instance first;
//                                                   `me` is the name of this instance. `now` is the time of the answer. The times read "2 min ago"
//                                                   from it.
//       note.destroy()                              closes the popover
//   ns.mcpInstances.warn(container, instances)      It fills `container` with the warnings of the list, or hides it when there are none. A warning is a banner (uiState.banner,
//                                                   level warn). It has one banner for the instance whose name another ChDash writes under. It has one more for the files that
//                                                   were skipped. The container is drawn again only when the warnings change.
//   ns.mcpInstances.problem(item)                   The sentence about an instance whose file is not read. It is "" when the file is read.
//   ns.mcpInstances.wrote(item, now)                { text, title }. The text tells when the instance wrote last, for example "wrote 2 min ago" or "no write yet".
//                                                   The title is the exact time, for a tooltip. The popover and the Instance list of the bar show the same text.
//
// The popover is a click-opened ns.popover. Escape and a press outside close it. The focus goes back to the button.
// Nothing here runs on a timer. The note follows the answers that the page reads.

import { h } from "./app_dom.js";
import { format } from "./app_format.js";
import { badge } from "./app_ui_badge.js";
import { popover } from "./app_ui_popover.js";
import { uiState } from "./app_ui_state.js";

// The names of the skipped files that a warning lists. After these names, it says "and N more".
const NAMED = 3;

const plural = (n, one, many) => `${format.count(n)} ${n === 1 ? one : many}`;
const sayReason = (reason) => String(reason || "").replace(/_/g, " ").trim();

// The problem with the file of an instance, as a sentence. It is "" when nothing is wrong.
function problem(item) {
  if (item.status === "conflict") return `Another ChDash writes as ${item.instance}: this instance does not save its counts.`;
  if (item.status === "skipped") {
    const why = sayReason(item.reason);
    return `${item.instance}: its file was skipped${why ? ` (${why})` : ""}, so its counts are not in these figures.`;
  }
  return "";
}

// The time when an instance wrote its file last, from the time of the answer. It is { text: "wrote 2 min ago", title: the time in full }.
// An instance that has not written yet has no time.
function wrote(item, now) {
  if (item.writtenAt == null) return { text: "no write yet", title: "" };
  return { text: `wrote ${format.ago(item.writtenAt, { now, short: true })}`, title: format.timeTitle(item.writtenAt) };
}

// The warnings of a list of instances have the form { message, details }. A conflict comes first. Then the skipped files come in one sentence.
// A rolling upgrade can leave dozens of skipped files. The popover of the note shows each one.
function warnings(instances) {
  const out = [];
  for (const item of instances) {
    if (item.status === "conflict") out.push({ message: `${problem(item)} Give each instance its own name (mcp.usage.instance).`, details: item.reason });
  }
  const skipped = instances.filter((item) => item.status === "skipped");
  if (skipped.length === 1) out.push({ message: problem(skipped[0]), details: "" });
  else if (skipped.length > 1) {
    const named = skipped.slice(0, NAMED).map((item) => {
      const why = sayReason(item.reason);
      return why ? `${item.instance} (${why})` : item.instance;
    });
    const more = skipped.length - named.length;
    out.push({ message: `${plural(skipped.length, "instance file was", "instance files were")} skipped, so their counts are not in these figures: ${named.join(", ")}${more ? ` and ${format.count(more)} more` : ""}.`, details: "" });
  }
  return out;
}

const drawn = new WeakMap();

function warn(container, instances) {
  const specs = warnings(instances);
  const signature = JSON.stringify(specs);
  if (drawn.get(container) === signature) return;
  drawn.set(container, signature);
  container.hidden = !specs.length;
  container.replaceChildren(...specs.map((spec) => uiState.banner(h("div", { class: "mcpInstances__warn" }),
    { message: spec.message, details: spec.details, detailsLabel: "Why", level: "warn", inset: true })));
}

// The instances come in the order of the list. This instance comes first. The others come by name. A name with a number sorts by that number: chdash-2 comes before chdash-10.
function ordered(instances, me) {
  return [...instances].sort((a, b) => (b.instance === me) - (a.instance === me) || a.instance.localeCompare(b.instance, undefined, { numeric: true }));
}

// The list that the popover shows.
function listOf(instances, { me, now }) {
  const rows = ordered(instances, me).map((item) => {
    const said = problem(item);
    const last = wrote(item, now);
    return h("li", { class: "mcpInstancesList__row", dataset: { instance: item.instance, status: item.status } },
      h("span", { class: "mcpInstancesList__name" }, h("code", null, item.instance), item.instance === me ? h("span", { class: "mcpMuted" }, "this instance") : null,
        item.status === "ok" ? null : badge.el(item.status === "conflict" ? "conflict" : "skipped", { tone: "warn", size: "sm", title: said }),
        // A skipped file gives its reason in one word, such as "invalid" or "too large". The reason of a conflict is a sentence. It is in the title and in the warning.
        item.status === "skipped" && item.reason ? h("span", { class: "mcpMuted" }, sayReason(item.reason)) : null),
      h("span", { class: "mcpMuted mcpInstancesList__meta", title: last.title }, last.text));
  });
  return h("div", { class: "mcpInstancesList" },
    h("p", { class: "mcpNote mcpInstancesList__lead" }, `The usage is summed over ${plural(instances.length, "instance", "instances")}: each one saves the file of its own in the usage directory and reads the files of the others.`),
    h("ul", { class: "mcpInstancesList__rows", "aria-label": "Instances" }, rows));
}

function create({ prefix = "" } = {}) {
  const button = h("button", { type: "button", class: "mcpInstances__button", aria: { haspopup: "dialog", expanded: "false" } });
  const el = h("span", { class: "mcpInstances", hidden: true }, h("span", { class: "mcpInstances__sep", "aria-hidden": "true" }, "·"), button);
  let state = { instances: [], me: "", now: NaN };
  let shown = null;
  const content = () => listOf(state.instances, state);
  button.addEventListener("click", () => {
    if (shown?.isOpen()) {
      shown.close();
      return;
    }
    shown = popover.open(button, content(), { className: "mcpInstancesPopover", label: "Instances of the usage", side: "bottom", align: "start", focus: (node) => node,
      onClose: () => { shown = null; } });
  });
  return {
    el,
    update(instances, { me = "", now = NaN } = {}) {
      state = { instances, me, now };
      const many = instances.length > 1;
      el.hidden = !many;
      if (!many) {
        shown?.close({ restoreFocus: false });
        return;
      }
      const text = `${prefix}${plural(instances.length, "instance", "instances")}`;
      if (button.textContent !== text) button.textContent = text;
      button.title = `The usage is summed over ${plural(instances.length, "instance", "instances")}. Open the list.`;
      // A new answer changes the list that is open. Its times follow it, and the focus stays where it is.
      if (shown?.isOpen()) shown.update(content());
    },
    destroy() {
      shown?.close({ restoreFocus: false });
    },
  };
}

export const mcpInstances = Object.freeze({ create, warn, problem, wrote });
