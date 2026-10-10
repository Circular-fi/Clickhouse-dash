// What every page runs first, whether the page uses it or not: the foundations (formats, colours, the DOM lookups, the
// address bar's router, the stack of layers, the page state) and the components (popovers, panels, tabs, menus, icons,
// states, tables, badges, copy, SQL blocks, key / value lists, stat tiles, chart cards). Some install a listener at once
// (the one popstate listener of ns.router, the one Escape listener of the layers), some are what the page's own modules
// import in turn. Each page entry (app_page_<page>.js) imports this file first.
import "./app_format.js";
import "./app_palette.js";
import "./app_dom.js";
import "./app_router.js";
import "./app_ui_layers.js";
import "./app_ui_popover.js";
import "./app_ui_panel.js";
import "./app_ui_tabs.js";
import "./app_ui_segmented.js";
import "./app_ui_menu.js";
import "./app_state.js";
import "./app_util.js";
import "./app_ui_icon.js";
import "./app_ui_state.js";
import "./app_ui_search.js";
import "./app_ui_table.js";
import "./app_ui_badge.js";
import "./app_ui_copy.js";
import "./app_ui_sql.js";
import "./app_ui_kv.js";
import "./app_ui_stat.js";
import "./app_ui_chart.js";
