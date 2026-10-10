// The Explorer page, Functions (functions.html, /explorer/functions[/<name>]): the list of the functions of the host and
// the card of one. The controller of the Catalog (app_explorer.js) without the Catalog's parts (the graph, the size
// views, the table card): see app_page_explorer.js.
import "./app_common.js";
import { boot } from "./app_boot.js";
import { explorer } from "./app_explorer.js";
import { header } from "./app_header.js";
import { meta } from "./app_meta.js";

boot(() => {
  header.init();
  meta.init();
  explorer.init();
});
