(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { ui, run, results, dom } = ns;

  async function loadMeta() {
    if (!dom || !dom.versionBadge) return;
    try {
      const res = await fetch("api/meta", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const version = data && data.version ? String(data.version) : "";
      const sha = data && data.git_sha ? String(data.git_sha) : "";
      const buildTime = data && data.build_time ? String(data.build_time) : "";

      const label = version || (sha ? sha.slice(0, 7) : "--");
      dom.versionBadge.textContent = label;

      const titleParts = [];
      if (data && data.name) titleParts.push(String(data.name));
      if (version) titleParts.push(version);
      if (sha) titleParts.push(sha);
      if (buildTime) titleParts.push(buildTime);
      dom.versionBadge.title = titleParts.join(" · ");
    } catch {
      return;
    }
  }

  if (results) {
    results.clearResultsStack();
    results.clearLiveResults();
    results.setMultiqueryMode(false);
  }

  if (ui) ui.init();
  if (run) run.init();
  loadMeta();
})();