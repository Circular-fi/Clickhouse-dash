// The Query page (query.html, /query): the header, the editor with its Run controls, the results and their chart, the
// analysis and the downloads. It has no Explorer: the page switcher takes a person to the Explorer page (app_header.js).
import "./app_common.js";
import { analysis } from "./app_analysis.js";
import { boot } from "./app_boot.js";
import { download } from "./app_download.js";
import { header } from "./app_header.js";
import { meta } from "./app_meta.js";
import { queryChart } from "./app_query_chart.js";
import { queryUi } from "./app_query_ui.js";
import { results } from "./app_results.js";
import { run } from "./app_run.js";

boot(() => {
  results.use({ queryChart });
  results.clearResultsStack();
  results.clearLiveResults();
  results.setMultiqueryMode(false);

  // The order is the order of the host hooks (header.onHostSelected): the metadata, the editor, the Run buttons.
  header.init();
  meta.init();
  queryUi.init({ onRun: () => run.handleRun() });
  meta.ensureHighlighterData();
  analysis.init();
  download.init();
  run.init();
});
