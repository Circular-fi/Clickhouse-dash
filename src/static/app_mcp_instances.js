// The instances that the usage of the keys sums (docs/mcp-integration-page.md, "Instances"). ChDash instances that share the directory of
// mcp.usage each write the file of their own and read the files of the others, so every answer of the usage is the sum of all of them. This
// module says so where a figure is a sum (the usage of a key and the column Used of the keys page; the Usage tab has its Instance list in the
// bar instead, app_mcp_bar.js), and warns when a file is left out of it (the Usage tab, the usage of a key, the keys page).
//
//   ns.mcpInstances.create({ prefix })              -> note
//       note.el                                     "3 instances" (`prefix` goes before it: "Summed over ") as a button that opens the list in a
//                                                   popover: for each instance its name, a badge when its file is not read, and when it wrote last.
//                                                   It is hidden for fewer than two instances: nothing is summed.
//       note.update(instances, { me, now })         the list that the answer holds (the answer's `instances`, this instance first);
//                                                   `me` is the name of this instance and `now` the time of the answer (the times read "2 min ago"
//                                                   from it)
//       note.destroy()                              closes the popover
//   ns.mcpInstances.warn(container, instances)      fills `container` with the warnings of the list, or hides it: a banner (uiState.banner,
//                                                   level warn) for the instance whose name another ChDash writes under, and one for the files that
//                                                   were skipped. The container is drawn again only when the warnings change.
//   ns.mcpInstances.problem(item)                   the sentence about an instance whose file is not read, "" when it is
//   ns.mcpInstances.wrote(item, now)                { text, title }: when the instance wrote last, "wrote 2 min ago" (or "no write yet"), and the
//                                                   exact time for a tooltip (the list of the popover and the Instance list of the bar say it alike)
//
// The popover is a click-opened ns.popover (Escape and a press outside close it, the focus goes back to the button). Nothing here runs on a
// timer: the note follows the answers that the page reads.

import { h } from "./app_dom.js";
import { format } from "./app_format.js";
import { badge } from "./app_ui_badge.js";
import { popover } from "./app_ui_popover.js";
import { uiState } from "./app_ui_state.js";

// The names of the skipped files that a warning lists before it says "and N more".
const NAMED = 3;

const plural = (n, one, many) => `${format.count(n)} ${n === 1 ? one : many}`;
const sayReason = (reason) => String(reason || "").replace(/_/g, " ").trim();

// What is wrong with the file of an instance, as a sentence ("" when nothing is).
function problem(item) {
  if (item.status === "conflict") return `Another ChDash writes as ${item.instance}: this instance does not save its counts.`;
  if (item.status === "skipped") {
    const why = sayReason(item.reason);
    return `${item.instance}: its file was skipped${why ? ` (${why})` : ""}, so its counts are not in these figures.`;
  }
  return "";
}

// When an instance wrote its file last, from the time of the answer: { text: "wrote 2 min ago", title: the time in full }. An instance that
// has not written yet has no time.
function wrote(item, now) {
  if (item.writtenAt == null) return { text: "no write yet", title: "" };
  return { text: `wrote ${format.ago(item.writtenAt, { now, short: true })}`, title: format.timeTitle(item.writtenAt) };
}

// The warnings of a list of instances: { message, details }, a conflict first, then the skipped files in one sentence (a rolling upgrade can
// leave dozens of them: the popover of the note has each).
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

// The instances in the order of the list: this one first, the others by name (a name with a number sorts by it: chdash-2 before chdash-10).
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
        // A skipped file says why in a word ("invalid", "too large"); the reason of a conflict is a sentence: it is in the title and the warning.
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
      // The answer of a new read changes the list that is open: its times follow, the focus stays where it is.
      if (shown?.isOpen()) shown.update(content());
    },
    destroy() {
      shown?.close({ restoreFocus: false });
    },
  };
}

export const mcpInstances = Object.freeze({ create, warn, problem, wrote });
