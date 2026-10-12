// Builds composition/index.html (and the audio assets) from the recorded clips, the narration and the music cues.
//
//   node build.mjs            (env: CLIP_DIR = the folder of the *.cut.mp4 / *.cut.json written by record/run.mjs)
//
// The composition is data-driven: the clips say where their events are (the marks of the choreography), the narration
// says where its words are (Whisper word times), the music says where its beats are, and this file places the callouts,
// the voice, the sound effects and the scene changes on those three clocks.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMP = path.join(HERE, "composition");
const CLIPS = process.env.CLIP_DIR || path.join(HERE, "record", "clips");
const FPS = 30;
const NO_MUSIC = process.env.NO_MUSIC === "1";
const MUSIC_VOLUME = process.env.MUSIC_VOLUME || "0.2"; // the bed sits about 8 dB under the voice; the carve takes more away while the voice speaks
const OVERLAP = 0.4; // a clip stays this long under the next one, which fades in over it

// ---------------------------------------------------------------------------------------------------------------------
// The stage: the footage is shown whole (1920x1080 scaled to 1744x981) with a strip below it for the captions.
const ST = { x: 88, y: 14, w: 1744, h: 981 };
const SC = ST.w / 1920;
const gx = (x) => ST.x + x * SC; // clip px -> frame px
const gy = (y) => ST.y + y * SC;

// ---------------------------------------------------------------------------------------------------------------------
// The scenes, in order. `vo` is the narration line, `sync` ties one word of it to one mark of the clip.
const NAV = ["Query", "Explorer", "Observability", "System", "MCP"];
const SCENES = [
  { id: "title", kind: "title", min: 4.6, lines: [{ id: "00", at: 0.3 }] },
  { id: "query_a", page: 0, lines: [{ id: "01a", sync: { word: "format", mark: "formatted", off: -0.1 } }, { id: "01b", sync: { word: "Run", mark: "run", off: -0.15 } }] },
  { id: "query_b", page: 0, lines: [{ id: "02", sync: { word: "chart", mark: "chart", off: -0.1 } }] },
  { id: "save", page: 0, lines: [{ id: "03", sync: { word: "Name", mark: "typeStart", off: -0.1 } }] },
  { id: "explorer", page: 1, lines: [{ id: "04a", sync: { word: "Explorer", mark: "catalog", off: 0 } }, { id: "04b", sync: { word: "table", mark: "table", off: -0.15 } }, { id: "04c", sync: { word: "lineage", mark: "graph", off: -0.2 } }] },
  { id: "traces", page: 2, lines: [{ id: "05a" }, { id: "05b", sync: { word: "shows", mark: "deltas", off: 0.3 } }, { id: "05c", sync: { word: "Open", mark: "trace", off: -0.1 } }] },
  { id: "logs_metrics", page: 2, lines: [{ id: "06a" }, { id: "06b", sync: { word: "metrics", mark: "metrics", off: -0.25 } }] },
  { id: "system", page: 3, lines: [{ id: "07a", sync: { word: "charts", mark: "perf", off: 0 } }, { id: "07b", sync: { word: "shapes", mark: "queries", off: 0 } }, { id: "07c" }] },
  { id: "mcp", page: 4, lines: [{ id: "08" }] },
  { id: "end", kind: "end", min: 4.9, lines: [{ id: "09", at: 0.35 }] },
];

// ---------------------------------------------------------------------------------------------------------------------
// Callouts: a ring on a real element and a label next to it. Times are seconds of the clip (a mark, plus an offset).
// A box is [x, y, w, h] in clip pixels, or the name of a rect that the choreography measured on the real element.
// `side` is where the label sits: left, right, top, bottom of the ring.
const C = {
  query_a: [
    { at: ["formatted", -0.15], dur: 2.0, box: "format", side: "top", text: "One click formats it" },
    { at: ["run", 0.4], dur: 4.6, box: "tiles", side: "left", text: "Live while it runs", sub: "rows, bytes, CPU, memory" },
    { at: ["tilesDone", 0.2], dur: 2.4, box: "summary", side: "bottom", text: "Results stream in as they arrive" },
  ],
  query_b: [
    { at: ["chart", 0.0], dur: 2.3, box: "chartToggle", side: "left", text: "Table or chart, one click" },
  ],
  save: [
    { at: ["libOpen", -0.85], dur: 1.5, box: "lib", side: "top", text: "Query library" },
    { at: ["libOpen", 0.35], dur: 1.2, box: [100, 921, 134, 34], side: "right", text: "Save query" },
    { at: ["folder", -1.6], dur: 1.5, box: "folderSel", side: "bottom", text: "Pick the folder" },
    { at: ["folder", 0.05], dur: 1.1, box: "ghost2", side: "bottom", text: "The tree shows where it lands" },
    { at: ["saved", 0.15], dur: 2.5, box: "saved", side: "bottom", text: "Saved in shared server storage" },
  ],
  explorer: [
    { at: ["catalog", 0.2], dur: 1.7, box: [361, 180, 1520, 212], side: "bottom", text: "Every database, sized on disk" },
    { at: ["table", 0.15], dur: 2.0, box: [361, 296, 1210, 215], side: "bottom", text: "Column sizes, compressed" },
    { at: ["storage", 0.0], dur: 1.4, box: [548, 190, 80, 30], side: "bottom", text: "Parts, disks, partitions" },
    { at: ["ddl", 0.0], dur: 1.3, box: [833, 190, 54, 30], side: "bottom", text: "The DDL" },
    { at: ["graph", 0.3], dur: 2.2, box: [196, 830, 1500, 230], side: "top", text: "Lineage: tables, views, materialized views" },
  ],
  traces: [
    { at: ["boxed", -0.5], dur: 2.6, box: [1352, 222, 356, 52], side: "left", text: "Drag a box on the slow band" },
    { at: ["deltas", 0.35], dur: 2.1, box: [1130, 852, 365, 112], side: "bottom", text: "feature.flag = new_pricing", sub: "90.5% of the slow traces, 0.9% of the rest" },
    { at: ["bar", -1.0], dur: 1.9, box: "fees", full: true, side: "bottom", ldx: 380, text: "Where the time goes" },
    { at: ["map", 0.1], dur: 2.2, box: [1020, 150, 760, 300], side: "left", text: "Service map", sub: "calls, p95 and errors" },
  ],
  logs_metrics: [
    { at: ["start", 0.1], dur: 1.8, box: [14, 60, 244, 40], side: "bottom", text: "Traces, Logs and Metrics: one page" },
    { at: ["chart", 0.2], dur: 2.0, box: [364, 176, 1536, 480], side: "top", text: "Pick a metric, chart it" },
  ],
  system: [
    { at: ["overview", 0.1], dur: 1.2, box: [14, 174, 1892, 88], side: "bottom", text: "The server at a glance" },
    { at: ["perf", 0.1], dur: 1.8, box: [14, 600, 1892, 440], side: "top", text: "Performance from the system logs" },
    { at: ["queries", 0.1], dur: 1.6, box: [14, 280, 1892, 250], side: "bottom", text: "The heaviest query shapes" },
    { at: ["shape", 0.15], dur: 2.4, box: [14, 560, 700, 360], side: "right", text: "One shape: formatted text, runs, CPU" },
  ],
  mcp: [
    { at: ["keys", 0.0], dur: 1.6, box: [14, 120, 1163, 152], side: "bottom", text: "Access keys: hosts, tools, data" },
    { at: ["open", 0.9], dur: 3.4, box: [362, 496, 798, 330], side: "left", text: "Observability", sub: "Traces, Logs, Metrics" },
  ],
};

// ---------------------------------------------------------------------------------------------------------------------
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const f3 = (n) => +n.toFixed(3);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
let seed = 20261012;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

// assets that are not committed: fonts of the product, gsap, the sound effects and the music of the brag skill
import { copyFileSync } from "node:fs";
const SKILL = path.join(process.env.HOME, ".claude/skills/brag/assets");
const REPO = path.resolve(HERE, "../../..");
const cp = (from, to) => { mkdirSync(path.dirname(to), { recursive: true }); if (!existsSync(to)) copyFileSync(from, to); };
for (const f of ["IBMPlexSans-Regular-Latin1.woff2", "IBMPlexSans-Medium-Latin1.woff2", "IBMPlexSans-SemiBold-Latin1.woff2", "IBMPlexMono-Medium-Latin1.woff2", "LICENSE.txt"]) cp(path.join(REPO, "src/static/fonts", f), path.join(COMP, "assets/fonts", f));
cp(path.join(COMP, "node_modules/gsap/dist/gsap.min.js"), path.join(COMP, "assets/gsap.min.js"));
for (const n of ["keypress-001", "keypress-005", "keypress-009", "keypress-014", "keypress-018", "keypress-022", "keypress-027", "keypress-031"]) cp(path.join(SKILL, `sfx/keyboard/${n}.wav`), path.join(COMP, `assets/sfx/${n}.wav`));
for (const [d, n] of [["ui", "mouseclick1.ogg"], ["interface", "drop_001.ogg"], ["impact", "impactSoft_medium_001.ogg"], ["impact", "impactBell_heavy_000.ogg"]]) cp(path.join(SKILL, `sfx/${d}/${n}`), path.join(COMP, "assets/sfx", n));
cp(path.join(SKILL, "music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3"), path.join(COMP, "assets/music/bed-src.mp3"));
if (!existsSync(path.join(COMP, "assets/audio-data.js"))) {
  const j = path.join(COMP, "assets/audio-data.json");
  execFileSync("python3", [path.join(process.env.HOME, ".claude/skills/hyperframes-creative/scripts/extract-audio-data.py"), path.join(COMP, "assets/music/bed-src.mp3"), "-o", j, "--fps", "30", "--bands", "16"], { stdio: "ignore" });
  const d = readJson(j);
  d.frames = d.frames.slice(0, 3000).map((f) => ({ bands: f.bands.map((x) => +x.toFixed(2)) }));
  d.totalFrames = d.frames.length;
  writeFileSync(path.join(COMP, "assets/audio-data.js"), `var AUDIO_DATA = ${JSON.stringify(d)};\n`);
}
mkdirSync(path.join(COMP, "assets", "clips"), { recursive: true });

// narration (text, caption text) and word times
const script = Object.fromEntries(readFileSync(path.join(HERE, "narration", "script.txt"), "utf8").trim().split("\n").map((l) => {
  const [n, tts, cap] = l.split("|");
  return [n, { tts, cap: cap || tts }];
}));
const voDur = (n) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(COMP, "assets", "vo", `${n}.wav`)]).toString().trim();
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

// the words of a line, timed: the caption words aligned to Whisper's words (a miss is interpolated)
function wordsOf(n) {
  const heard = readJson(path.join(COMP, "assets", "vo", `${n}.words.json`)).map((w) => ({ t: norm(w.text), s: w.start, e: w.end }));
  const words = script[n].cap.split(/\s+/);
  const out = words.map((w) => ({ w, s: null, e: null }));
  let j = 0;
  words.forEach((w, i) => {
    const k = heard.findIndex((h, idx) => idx >= j && h.t === norm(w));
    if (k >= 0 && k - j <= 3) { out[i].s = heard[k].s; out[i].e = heard[k].e; j = k + 1; }
  });
  // interpolate the unmatched ones between the matched neighbours
  for (let i = 0; i < out.length; i++) {
    if (out[i].s != null) continue;
    let a = i - 1; while (a >= 0 && out[a].s == null) a--;
    let b = i + 1; while (b < out.length && out[b].s == null) b++;
    const t0 = a >= 0 ? out[a].e : heard[0].s;
    const t1 = b < out.length ? out[b].s : heard[heard.length - 1].e;
    const gap = b - a - 1, idx = i - a - 1;
    out[i].s = t0 + ((t1 - t0) * idx) / gap;
    out[i].e = t0 + ((t1 - t0) * (idx + 1)) / gap;
  }
  return out;
}

// music cues: the beat grid and the strong cues of the bundled track
const cues = readJson(path.join(process.env.HOME, ".claude/skills/brag/assets/music/cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json"));
const beats = cues.beats.map((b) => b.time);
const strong = cues.strongCues.map((c) => c.time).sort((a, b) => a - b);
const nearest = (arr, t, ge = false) => arr.reduce((best, x) => ((!ge || x >= t - 1e-6) && Math.abs(x - t) < Math.abs(best - t) ? x : best), arr[0]);

// ---------------------------------------------------------------------------------------------------------------------
// 1. timeline: scene starts, snapped to the beat grid
const meta = {};
for (const s of SCENES) {
  if (s.kind) continue;
  meta[s.id] = readJson(path.join(CLIPS, `${s.id}.cut.json`));
}
function plan(bt) {
  let t = 0;
  for (const s of SCENES) {
    s.start = t;
    let cursor = s.start + 0.25;
    for (const ln of s.lines) {
      ln.dur = voDur(ln.id);
      let want = cursor;
      if (ln.at != null) want = s.start + ln.at;
      if (ln.sync && meta[s.id]) {
        const wd = wordsOf(ln.id);
        const w = wd.find((x) => norm(x.w) === norm(ln.sync.word)) || wd[0];
        want = s.start + (meta[s.id].marks[ln.sync.mark] ?? 0) + ln.sync.off - w.s;
      }
      ln.start = Math.max(want, cursor, s.start + 0.2);
      cursor = ln.start + ln.dur + 0.12;
    }
    if (s.kind) s.dur = Math.max(s.min, cursor + (s.id === "end" ? 0.25 : 0.1) - s.start);
    else { s.clip = meta[s.id]; s.dur = Math.max(s.clip.duration + 0.15, cursor + 0.3 - s.start); }
    let end = s.start + s.dur;
    if (s.id !== "end") { const near = nearest(bt, end); end = near >= end - 0.2 ? near : nearest(bt, end, true); } // the cut lands on the nearest beat (at most 0.2 s early)
    s.dur = end - s.start;
    t = end;
  }
  
}
const END = SCENES[SCENES.length - 1];
// The closing card lands on a strong cue of the music: the music starts a whole number of beats into the track, which
// keeps every cut on a beat and moves the strong cue onto the card.
plan(beats);
let MEDIA_START = 0;
const want = strong.filter((c) => c > END.start).slice(0, 4).map((c) => c - END.start);
const period = 0.5456;
let bestD = null;
for (const d of want) { const k = Math.round(d / period); const err = Math.abs(d - k * period); if (bestD == null || err < bestD.err) bestD = { d, err }; }
if (bestD && bestD.d < 4.5) {
  MEDIA_START = f3(bestD.d);
  plan(beats.filter((x) => x >= MEDIA_START).map((x) => x - MEDIA_START));
}
const cueErr = strong.map((c) => Math.abs(c - MEDIA_START - END.start)).sort((x, y) => x - y)[0];
console.log("music starts", MEDIA_START, "s into the track; closing card vs strong cue:", cueErr.toFixed(2), "s");
const TOTAL = f3(END.start + END.dur);
console.log(SCENES.map((s) => `${s.id.padEnd(13)} start ${s.start.toFixed(2)} dur ${s.dur.toFixed(2)} vo ${s.lines.map((l) => `${l.id}@${l.start.toFixed(2)}-${(l.start + l.dur).toFixed(2)}`).join(" ")}`).join("\n"));
console.log("total", TOTAL);

// ---------------------------------------------------------------------------------------------------------------------
// 2. clips: padded so that a clip that ends before its slot holds its last frame
for (const s of SCENES) {
  if (s.kind) continue;
  const out = path.join(COMP, "assets", "clips", `${s.id}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(CLIPS, `${s.id}.cut.mp4`), "-vf", `tpad=stop_mode=clone:stop_duration=2,fps=${FPS}`, "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out]);
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. sound effects: one pre-mixed bed (clicks of the cursor, keys, a soft hit on each cut), so the page stays light
const sfx = []; // [time, file, gain]
const keyFiles = ["keypress-001", "keypress-005", "keypress-009", "keypress-014", "keypress-018", "keypress-022", "keypress-027", "keypress-031"].map((n) => `${n}.wav`);
for (const s of SCENES) {
  if (s.kind) continue;
  for (const c of s.clip.clicks || []) sfx.push([s.start + c, "mouseclick1.ogg", 0.5]);
  for (const [a, b, n] of s.clip.typing || []) {
    const gap = (b - a) / Math.max(1, n);
    for (let i = 0; i < n; i++) sfx.push([s.start + a + i * gap + (rnd() - 0.5) * gap * 0.5, keyFiles[Math.floor(rnd() * keyFiles.length)], 0.22 + rnd() * 0.12]);
  }
  if (s.id !== "query_a") sfx.push([s.start - 0.05, "drop_001.ogg", 0.45]);
}
sfx.push([SCENES[1].start - 0.1, "impactSoft_medium_001.ogg", 0.7]);
sfx.push([END.start + 0.05, "impactBell_heavy_000.ogg", 0.5]);
writeFileSync(path.join(COMP, "assets", "sfx-events.json"), JSON.stringify({ total: TOTAL, events: sfx.map(([t, f, g]) => [f3(t), f, +g.toFixed(2)]) }));
execFileSync("python3", [path.join(HERE, "sfxbed.py"), path.join(COMP, "assets", "sfx-events.json"), path.join(COMP, "assets", "sfx"), path.join(COMP, "assets", "sfx-bed.wav")], { stdio: "inherit" });

// ---------------------------------------------------------------------------------------------------------------------
// 4. the HTML
const html = [];
const tl = []; // timeline statements
const P = (s) => html.push(s);
const T = (s) => tl.push(s);
const q = JSON.stringify;

// the scene wrappers and the clips
let track = 1;
const clipEls = [];
SCENES.forEach((s, i) => {
  if (s.kind) return;
  const dur = s.dur + OVERLAP;
  clipEls.push(`<div class="vwrap" id="w-${s.id}" data-layout-allow-overflow><video id="v-${s.id}" src="assets/clips/${s.id}.mp4" muted playsinline data-start="${f3(s.start)}" data-duration="${f3(dur)}" data-track-index="${track++}"></video></div>`);
  const fadeIn = i > 1 ? 0.35 : 0.6;
  T(`tl.fromTo("#w-${s.id}", { opacity: 0, x: ${i > 1 ? 46 : 0}, scale: ${i > 1 ? 1 : 1.03} }, { opacity: 1, x: 0, scale: 1, duration: ${fadeIn}, ease: "power3.out" }, ${f3(s.start)});`);
  const next = SCENES[i + 1];
  if (next && !next.kind) T(`tl.to("#w-${s.id}", { x: -34, scale: 0.992, duration: 0.45, ease: "power2.in" }, ${f3(next.start)});`);
});

// callouts
let cid = 0;
const calls = [];
for (const s of SCENES) {
  for (const c of C[s.id] || []) {
    const id = `c${cid++}`;
    let box = c.box;
    if (typeof box === "string") {
      const r = (s.clip.rects || []).filter((x) => x.name === box).pop();
      if (!r) { console.warn("no rect", s.id, box); continue; }
      box = [r.x, r.y, r.w, r.h];
    }
    let [bx, by, bw, bh] = box;
    if (c.full) { bx = 12; bw = 1890; }
    const X = gx(bx), Y = gy(by), W = bw * SC, H = bh * SC;
    const t0 = f3(s.start + (s.clip.marks[c.at[0]] ?? 0) + c.at[1]);
    const t1 = f3(Math.min(t0 + c.dur, s.start + s.dur - 0.05));
    if (t1 - t0 < 0.8) console.warn("short callout", s.id, c.text, t1 - t0);
    const M = 14, BOX = 760;
    let lx, ly, jc = "center", al = "center";
    const cx = X + W / 2 + (c.ldx || 0) * SC;
    if (c.side === "top") { lx = cx - BOX / 2; ly = Y - M - 70; al = "flex-end"; }
    if (c.side === "bottom") { lx = cx - BOX / 2; ly = Y + H + M; al = "flex-start"; }
    if (c.side === "left") { lx = X - M - BOX; ly = Y + H / 2 - 35; jc = "flex-end"; }
    if (c.side === "right") { lx = X + W + M; ly = Y + H / 2 - 35; jc = "flex-start"; }
    // keep the label inside the stage
    lx = Math.max(ST.x - 20, Math.min(lx, ST.x + ST.w + 20 - BOX));
    ly = Math.max(ST.y + 4, Math.min(ly, ST.y + ST.h - 76));
    const flexAlignY = c.side === "top" ? "flex-end" : c.side === "bottom" ? "flex-start" : "center";
    P(`<div class="ring" id="${id}r" style="left:${f3(X - 5)}px;top:${f3(Y - 5)}px;width:${f3(W + 10)}px;height:${f3(H + 10)}px"></div>`);
    P(`<div class="lblbox" id="${id}l" style="left:${f3(lx)}px;top:${f3(ly)}px;width:${BOX}px;justify-content:${jc};align-items:${flexAlignY}"><div class="lbl"><b>${esc(c.text)}</b>${c.sub ? `<span>${esc(c.sub)}</span>` : ""}</div></div>`);
    const dirY = c.side === "top" ? 10 : c.side === "bottom" ? -10 : 0;
    const dirX = c.side === "left" ? 14 : c.side === "right" ? -14 : 0;
    T(`tl.fromTo("#${id}r", { opacity: 0, scale: 1.12 }, { opacity: 1, scale: 1, duration: 0.32, ease: "back.out(1.7)" }, ${t0});`);
    T(`tl.fromTo("#${id}l", { opacity: 0, x: ${dirX}, y: ${dirY} }, { opacity: 1, x: 0, y: 0, duration: 0.34, ease: "power3.out" }, ${f3(t0 + 0.1)});`);
    T(`tl.to("#${id}r", { opacity: 0, duration: 0.25, ease: "power2.in" }, ${f3(t1 - 0.25)});`);
    T(`tl.to("#${id}l", { opacity: 0, x: ${-dirX / 2}, y: ${-dirY / 2}, duration: 0.25, ease: "power2.in" }, ${f3(t1 - 0.25)});`);
    calls.push({ id, t0, t1, scene: s.id });
  }
}

// the page switcher of the strip: the product's own five pages, the current one lit
const pill = [];
const pillW = [74, 100, 142, 90, 66]; // measured at 20px Plex Sans Medium (+ padding), kept as constants for the seek-safe layout
let px = 0;
const pillX = pillW.map((w) => { const x = px; px += w + 6; return x; });
const NAVW = px - 6;
NAV.forEach((n, i) => pill.push(`<span class="pg" style="left:${pillX[i]}px;width:${pillW[i]}px">${n}</span>`));
const lastPageScene = SCENES.filter((s) => s.page != null);
lastPageScene.forEach((s, k) => {
  const x = pillX[s.page], w = pillW[s.page];
  if (k === 0) T(`tl.set("#pgind", { x: ${x}, width: ${w} }, 0);`);
  else T(`tl.to("#pgind", { x: ${x}, width: ${w}, duration: 0.45, ease: "power3.inOut" }, ${f3(s.start)});`);
});
T(`tl.fromTo("#nav", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${f3(SCENES[1].start + 0.2)});`);
T(`tl.to("#nav", { opacity: 0, y: 10, duration: 0.35 }, ${f3(END.start - 0.1)});`);

// captions: the narration, chunked, the spoken word lit
const capHtml = [];
let capId = 0;
const capTimes = [];
for (const s of SCENES) for (const ln of s.lines) {
  const wds = wordsOf(ln.id);
  const base = ln.start;
  // chunk at punctuation or at ~44 characters
  const chunks = [];
  let cur = [];
  let len = 0;
  wds.forEach((w, i) => {
    cur.push(i); len += w.w.length + 1;
    if (/[.,:?!]$/.test(w.w) && len > 14 || len > 44) { chunks.push(cur); cur = []; len = 0; }
  });
  if (cur.length) chunks.push(cur);
  chunks.forEach((ch, ci) => {
    const id = `k${capId++}`;
    const first = wds[ch[0]], last = wds[ch[ch.length - 1]];
    const nextFirst = chunks[ci + 1] ? wds[chunks[ci + 1][0]] : null;
    const a = f3(base + first.s - 0.05);
    const b = f3(nextFirst ? base + nextFirst.s - 0.06 : base + last.e + 0.45);
    capHtml.push(`<div class="cap" id="${id}">${ch.map((i, k) => `<span id="${id}w${k}">${esc(wds[i].w)}</span>`).join(" ")}</div>`);
    T(`tl.fromTo("#${id}", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.16, ease: "power2.out" }, ${a});`);
    T(`tl.to("#${id}", { opacity: 0, y: -6, duration: 0.12, ease: "power1.in" }, ${f3(b - 0.12)});`);
    ch.forEach((i, k) => T(`tl.to("#${id}w${k}", { color: "#ffffff", duration: 0.1 }, ${f3(base + wds[i].s - 0.02)});`));
    capTimes.push([a, b]);
  });
}

// title and closing cards
const logo = (cls) => `<svg class="${cls}" viewBox="0 0 18 18" width="140" height="140"><rect class="b1" x="0.75" y="10.5" width="3" height="6" rx="1"/><rect class="b2" x="5.25" y="5.5" width="3" height="11" rx="1"/><rect class="b3" x="9.75" y="8" width="3" height="8.5" rx="1"/><rect class="b4" x="14.25" y="1.5" width="3" height="15" rx="1"/></svg>`;
const S1 = SCENES[1].start;
P(`<div id="title" class="card"><div class="lockup">${logo("logo t")}<div><h1 id="tname">ClickHouse Dash</h1><p id="ttag">A lightweight real-time ClickHouse query dashboard.</p></div></div></div>`);
T(`tl.fromTo("#title .b1", { scaleY: 0, svgOrigin: "2.25 16.5" }, { scaleY: 1, svgOrigin: "2.25 16.5", duration: 0.5, ease: "back.out(1.6)" }, 0.15);`);
T(`tl.fromTo("#title .b2", { scaleY: 0, svgOrigin: "6.75 16.5" }, { scaleY: 1, svgOrigin: "6.75 16.5", duration: 0.5, ease: "back.out(1.6)" }, 0.25);`);
T(`tl.fromTo("#title .b3", { scaleY: 0, svgOrigin: "11.25 16.5" }, { scaleY: 1, svgOrigin: "11.25 16.5", duration: 0.5, ease: "back.out(1.6)" }, 0.35);`);
T(`tl.fromTo("#title .b4", { scaleY: 0, svgOrigin: "15.75 16.5" }, { scaleY: 1, svgOrigin: "15.75 16.5", duration: 0.5, ease: "back.out(1.6)" }, 0.45);`);
T(`tl.fromTo("#tname", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.8, ease: "power4.out" }, 0.55);`);
T(`tl.fromTo("#ttag", { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }, 1.15);`);
T(`tl.to("#title", { opacity: 0, scale: 1.06, filter: "blur(10px)", duration: 0.55, ease: "power2.in" }, ${f3(S1 - 0.25)});`);
T(`tl.fromTo("#stage", { opacity: 0, scale: 0.955, y: 24 }, { opacity: 1, scale: 1, y: 0, duration: 0.7, ease: "power3.out" }, ${f3(S1 - 0.1)});`);
T(`tl.to("#stage", { opacity: 0, scale: 0.97, duration: 0.5, ease: "power2.in" }, ${f3(END.start - 0.2)});`);
T(`tl.to("#capstrip", { opacity: 0, duration: 0.3 }, ${f3(END.start - 0.1)});`);

P(`<div id="end" class="card"><div class="lockup">${logo("logo e")}<div><h1 id="ename">ClickHouse Dash</h1><p id="etag">One self-contained binary. A lightweight, real-time ClickHouse query dashboard.</p></div></div><div class="row"><div id="erepo" class="repo">github.com/Circular-fi/Clickhouse-dash</div></div><div id="enav">${NAV.map((n) => `<span class="pg2">${n}</span>`).join("")}</div><div id="ecredit">Music: Happy Beats &amp; Business Moves Vol. 12 by Sascha Ende, ende.app, CC BY 4.0</div></div>`);
const E0 = f3(END.start);
T(`tl.fromTo("#end", { opacity: 0 }, { opacity: 1, duration: 0.4 }, ${E0});`);
const BARX = [0, 2.25, 6.75, 11.25, 15.75];
for (let k = 1; k <= 4; k++) T(`tl.fromTo("#end .b${k}", { scaleY: 0, svgOrigin: "${BARX[k]} 16.5" }, { scaleY: 1, svgOrigin: "${BARX[k]} 16.5", duration: 0.5, ease: "back.out(1.6)" }, ${f3(END.start + 0.1 + k * 0.1)});`);
T(`tl.fromTo("#ename", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.8, ease: "power4.out" }, ${f3(END.start + 0.45)});`);
T(`tl.fromTo("#etag", { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }, ${f3(END.start + 1.0)});`);
T(`tl.fromTo("#erepo", { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, ${f3(END.start + 1.7)});`);
T(`tl.fromTo("#enav .pg2", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.12, ease: "power3.out" }, ${f3(END.start + 2.1)});`);
T(`tl.fromTo("#ecredit", { opacity: 0 }, { opacity: 0.85, duration: 0.6 }, ${f3(END.start + 3.0)});`);
T(`tl.to("#end", { opacity: 0, duration: 0.9, ease: "power1.in" }, ${f3(TOTAL - 0.9)});`);

// audio: voice, bed, music
const audio = [];
let vi = 0;
SCENES.forEach((s) => s.lines.forEach((l) => audio.push(`<audio id="vo-${l.id}" data-audio-group="voiceover" src="assets/vo/${l.id}.wav" data-start="${f3(l.start)}" data-duration="${f3(l.dur)}" data-track-index="${40 + vi++}" data-volume="1"></audio>`)));
audio.push(`<audio id="sfx-bed" data-audio-group="sfx" src="assets/sfx-bed.wav" data-start="0" data-duration="${f3(TOTAL)}" data-track-index="20" data-volume="0.7"></audio>`);
if (!NO_MUSIC) {
  const fadeIn = { t: 0, v: 0 }, up = { t: 1.6, v: 1 }, down = { t: TOTAL - 3.2, v: 1 }, out = { t: TOTAL, v: 0 };
  audio.push(`<audio id="music-bed" src="assets/music/bed-src.mp3" data-start="0" data-media-start="${MEDIA_START}" data-duration="${f3(TOTAL)}" data-track-index="10" data-volume="${MUSIC_VOLUME}" data-fade='${JSON.stringify([fadeIn, up, down, out])}'></audio>`);
}

// ---------------------------------------------------------------------------------------------------------------------
const css = readFileSync(path.join(HERE, "composition.css"), "utf8");
const page = `<!doctype html>
<html lang="en" data-resolution="landscape">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1920, height=1080" />
<title>ClickHouse Dash presentation</title>
<script src="assets/gsap.min.js"></script>
<script src="assets/audio-data.js"></script>
<style>
${css.replace(/__ST_X__/g, ST.x).replace(/__ST_Y__/g, ST.y).replace(/__ST_W__/g, ST.w).replace(/__ST_H__/g, ST.h).replace(/__NAVW__/g, NAVW)}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="${TOTAL}">
  <div id="bg"><div id="glowA"></div><div id="glowB"></div><div id="grid"></div></div>
  <div id="stage">
    ${clipEls.join("\n    ")}
  </div>
  <div id="fx">
    ${html.filter((h) => h.startsWith('<div class="ring"') || h.startsWith('<div class="lblbox"')).join("\n    ")}
  </div>
  <div id="capstrip">
    <div id="nav" style="width:${NAVW}px"><div id="pgind"></div>${pill.join("")}</div>
    <div id="caps" data-layout-allow-overlap>${capHtml.join("")}</div>
  </div>
  ${html.filter((h) => h.startsWith('<div id="title"') || h.startsWith('<div id="end"')).join("\n  ")}
  ${audio.join("\n  ")}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${tl.join("\n")}
// the background breathes with the music (bass and mids of the bed), nothing else moves with it
const ad = (typeof AUDIO_DATA !== "undefined") ? AUDIO_DATA : null;
const st = { p: 0 };
tl.to(st, { p: 1, duration: ${TOTAL}, ease: "none", onUpdate: () => {
  if (!ad) return;
  const f = ad.frames[Math.min(ad.frames.length - 1, Math.max(0, Math.round(tl.time() * ad.fps)))];
  if (!f) return;
  const bass = (f.bands[0] + f.bands[1]) / 2, mid = (f.bands[4] + f.bands[6]) / 2;
  gsap.set("#glowA", { opacity: 0.55 + 0.45 * bass, scale: 1 + 0.07 * bass });
  gsap.set("#glowB", { opacity: 0.4 + 0.5 * mid });
  gsap.set("#stage", { boxShadow: "0 0 " + (50 + 40 * bass) + "px rgba(74,134,247," + (0.10 + 0.14 * bass) + "), 0 24px 70px rgba(0,0,0,.55)" });
} }, 0);
window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
writeFileSync(path.join(COMP, "index.html"), page);
writeFileSync(path.join(COMP, "timeline-summary.json"), JSON.stringify({ total: TOTAL, scenes: SCENES.map((s) => ({ id: s.id, start: f3(s.start), dur: f3(s.dur), lines: s.lines.map((l) => ({ id: l.id, start: f3(l.start), dur: f3(l.dur) })) })), callouts: calls, captions: capTimes }, null, 1));
console.log("wrote index.html", page.length, "bytes");
