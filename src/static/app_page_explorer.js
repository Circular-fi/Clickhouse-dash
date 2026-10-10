// The Explorer page, Catalog (explorer.html, /explorer/catalog[/<db>[/<table>]]): the tree of databases and tables, the
// table card, the lineage graph and the size treemaps. The Functions page (app_page_functions.js) has none of these
// parts, so they are handed to the controller here and never load there.
import "./app_common.js";
import { boot } from "./app_boot.js";
import { explorer } from "./app_explorer.js";
import { explorerDetail } from "./app_explorer_detail.js";
import { explorerGraph } from "./app_explorer_graph.js";
import { explorerStorage } from "./app_explorer_storage.js";
import { header } from "./app_header.js";
import { meta } from "./app_meta.js";
import { results } from "./app_results.js";

boot(() => {
  explorer.use({ graph: explorerGraph, storage: explorerStorage, detail: explorerDetail, results });
  results.clearResultsStack();
  results.clearLiveResults();
  results.setMultiqueryMode(false);

  header.init();
  meta.init();
  explorer.init();
});
