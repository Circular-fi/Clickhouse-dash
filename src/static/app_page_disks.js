// The System page, Disks (disks.html, /system/disks): the disks of the host and how they fill.
import "./app_common.js";
import { boot } from "./app_boot.js";
import "./app_system_disks.js";
import { startSystemPage } from "./app_system.js";

boot(() => startSystemPage("disks"));
