// Cuts a recorded clip according to the scene's `cut` plan: segments of the raw recording (clip seconds or mark names),
// each with a playback rate (typing and long loads are sped up, the moments that matter stay at 1x). Dead time is dropped.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { OUT, FPS } from "./lib.mjs";

// Rates of the stretches that the choreography marked as fast, overlaid on a plan { from, to } (default: the whole clip).

export function prep(name, cut) {
  const raw = path.join(OUT, `${name}.mp4`);
  const { duration, marks, segs: fast = [], clicks = [], typing = [], rects = [] } = JSON.parse(readFileSync(path.join(OUT, `${name}.marks.json`), "utf8"));
  const at = (v) => (v === "end" ? duration : typeof v === "number" ? (v < 0 ? duration + v : v) : marks[v]);
  const [startAt, endAt] = [at((cut && cut.start) ?? 0), at((cut && cut.end) ?? "end")];
  // cut points: the edges of every fast stretch inside [startAt, endAt]
  const pts = new Set([startAt, endAt]);
  const fs = fast.map(([a, b, r]) => [Math.max(a, startAt), Math.min(b, endAt), r]).filter(([a, b]) => b - a > 0.05);
  for (const [a, b] of fs) { pts.add(a); pts.add(b); }
  const edges = [...pts].sort((x, y) => x - y);
  const segs = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1], mid = (a + b) / 2;
    const f = fs.find(([fa, fb]) => mid >= fa && mid <= fb);
    segs.push({ a, b, r: f ? f[2] * (cut && cut.speed || 1) : (cut && cut.speed) || 1 });
  }
  for (const s of segs) if (!(s.b > s.a)) throw new Error(`${name}: bad segment ${JSON.stringify(s)}`);
  const parts = segs.map((s, i) => `[0:v]trim=start=${s.a.toFixed(3)}:end=${s.b.toFixed(3)},setpts=(PTS-STARTPTS)/${s.r}[v${i}]`);
  const filter = `${parts.join(";")};${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0,fps=${FPS},format=yuv420p[out]`;
  const out = path.join(OUT, `${name}.cut.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-crf", "13", "-preset", "medium", "-g", String(FPS), "-r", String(FPS), out]);
  const total = segs.reduce((n, s) => n + (s.b - s.a) / s.r, 0);
  // the marks, moved from the raw clock to the clock of the cut clip
  const map = (t) => { let o = 0; for (const s of segs) { if (t <= s.a) return o; if (t < s.b) return o + (t - s.a) / s.r; o += (s.b - s.a) / s.r; } return o; };
  const cutMarks = Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, +map(v).toFixed(3)]));
  writeFileSync(path.join(OUT, `${name}.cut.json`), JSON.stringify({ duration: +total.toFixed(3), marks: cutMarks,
    clicks: clicks.filter((t) => t >= startAt && t <= endAt).map((t) => +map(t).toFixed(3)),
    typing: typing.map(([a, b, n]) => [+map(a).toFixed(3), +map(b).toFixed(3), n]),
    rects: rects.map((r) => ({ ...r, t: +map(r.t).toFixed(3) })) }, null, 1));
  console.log(`${name}: cut -> ${out} (${total.toFixed(2)}s)`);
  return out;
}
export const exists = existsSync;
