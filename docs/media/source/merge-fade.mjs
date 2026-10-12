// After the carve has written its lanes (data-automation) onto the music bed, adds the fade in / fade out of the bed as a
// volume lane of the same attribute (an element can have only one data-automation). The fade points come from build.mjs
// (data-fade, removed here).
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
let html = readFileSync(file, "utf8");
const tag = html.match(/<audio id="music-bed"[^>]*>/)[0];
const fade = JSON.parse(tag.match(/data-fade='([^']*)'/)[1]);
const m = tag.match(/data-automation="([^"]*)"/);
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const auto = m ? JSON.parse(unesc(m[1])) : { version: 1, lanes: [] };
auto.lanes = auto.lanes.filter((l) => l.target !== "volume").concat([{ target: "volume", points: fade }]);
let next = tag.replace(/ data-fade='[^']*'/, "");
const attr = ` data-automation="${JSON.stringify(auto).replace(/"/g, "&quot;")}"`;
next = m ? next.replace(/ data-automation="[^"]*"/, attr) : next.replace("></audio>", `${attr}></audio>`).replace(/>$/, ">");
html = html.replace(tag, next);
writeFileSync(file, html);
console.log("fade merged:", auto.lanes.map((l) => `${l.target}(${l.points.length})`).join(" "));
