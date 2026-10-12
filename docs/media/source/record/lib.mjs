// Shared helpers of the choreographed recording: a Chrome page that is filmed by CDP screencast, a visible fake
// cursor with click ripples (baked into the footage, Playwright never draws the mouse), human typing, eased mouse moves.
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

// The server is on a local port; the browser reaches it as dash.example.com (a reserved name), so that the MCP page
// shows a neutral endpoint instead of a local address.
export const BASE = process.env.BASE_URL || "http://dash.example.com";
const MAP = process.env.HOST_MAP || "MAP dash.example.com 127.0.0.1:18290";
export const OUT = process.env.CLIP_DIR || path.resolve("clips");
export const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
// The page is laid out at 1600x900 CSS px and captured at 1920x1080 device pixels (scale 1.2): the whole page is in
// view and its text is as large in the video as a 1080p screen shows it.
export const VIEW = { width: 1600, height: 900 };
export const SCALE = 1.2;
export const FPS = 30;      // the delivered frame rate
export const RAW_FPS = 60;  // the raw clips are kept at 60 fps, so that a sped-up part stays smooth

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let CURRENT = null;
export const setRecorder = (rec) => { CURRENT = rec; };
// A pause of the choreography. The recording keeps it, prep.mjs plays it faster (the longer, the faster) unless
// { keep: true } says that the moment is the show (a query running, a chart drawing).
export async function wait(ms, { keep = false, rate } = {}) {
  const a = CURRENT && CURRENT.clock();
  await sleep(ms);
  if (!CURRENT || keep || ms < 450) return;
  const r = rate || Math.min(2.6, 1 + (ms / 1000 - 0.3) * 1.1);
  CURRENT.fast(a, CURRENT.clock(), r);
}

// Deterministic pseudo random numbers (the same choreography types the same rhythm every time).
export function rng(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const CURSOR_INIT = () => {
  const install = () => {
    if (document.getElementById("__cur")) return;
    const style = document.createElement("style");
    style.textContent = `
      #__cur{position:fixed;left:0;top:0;width:28px;height:28px;margin:-3px 0 0 -3px;z-index:2147483647;pointer-events:none;
        transform:translate(-100px,-100px);will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))}
      #__cur svg{display:block;transition:transform .12s ease-out;transform-origin:4px 3px}
      #__cur.down svg{transform:scale(.82)}
      .__rip{position:fixed;z-index:2147483646;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;
        border:2px solid rgba(96,165,250,.95);background:rgba(59,130,246,.28);animation:__rip .62s cubic-bezier(.15,.7,.3,1) forwards}
      @keyframes __rip{from{transform:scale(.4);opacity:1}to{transform:scale(4.2);opacity:0}}`;
    document.documentElement.appendChild(style);
    const cur = document.createElement("div");
    cur.id = "__cur";
    cur.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 3 L4 21.5 L9.2 17.2 L12.6 24.6 L15.9 23.1 L12.6 15.8 L19.4 15.4 Z" fill="#fff" stroke="#0b0f14" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cur);
    let x = -100, y = -100;
    const place = () => { cur.style.transform = `translate(${x}px,${y}px)`; };
    window.addEventListener("mousemove", (e) => { x = e.clientX; y = e.clientY; place(); }, true);
    window.addEventListener("mousedown", (e) => {
      x = e.clientX; y = e.clientY; place(); cur.classList.add("down");
      const r = document.createElement("div"); r.className = "__rip"; r.style.left = x + "px"; r.style.top = y + "px";
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700);
    }, true);
    window.addEventListener("mouseup", () => cur.classList.remove("down"), true);
  };
  if (document.documentElement) install();
  document.addEventListener("DOMContentLoaded", install);
  new MutationObserver(install).observe(document, { childList: true });
};

export async function launch({ storage = {} } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [`--host-resolver-rules=${MAP}`, "--hide-scrollbars", "--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb"],
  });
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
    timezoneId: "UTC",
    locale: "en-US",
  });
  await context.addInitScript((kv) => {
    try {
      localStorage.setItem("chdash.theme", "dark");
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    } catch {}
  }, storage);
  await context.addInitScript(CURSOR_INIT);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("[console.error]", m.text().slice(0, 200)); });
  return { browser, context, page, cursor: { x: 800, y: 450 } };
}

// ---- screencast -> mp4 ----------------------------------------------------------------------------------------------
export class Recorder {
  constructor(page, name) {
    this.page = page; this.name = name;
    this.dir = path.join(OUT, `${name}.frames`);
    this.frames = []; this.n = 0; this.marks = {}; this.segs = []; this.clicks = []; this.typing = []; this.rects = [];
  }
  // Names a moment of the recording ("typed", "tilesDone"): clip-relative seconds, kept in <name>.marks.json for prep.mjs.
  // The recording clock (screencast time, relative to the first frame once stop() ran).
  clock() {
    const l = this.frames[this.frames.length - 1];
    return l ? l.t + (Date.now() - l.wall) / 1000 : null;
  }
  click() { this.clicks.push(this.clock()); }
  // The box of a real element, in clip pixels (1920x1080), at this moment of the recording: the composition draws its
  // callouts on these, so that a ring is exactly on the element it names.
  async rect(name, locator, pad = 0) {
    const b = await locator.boundingBox();
    if (!b) return;
    this.rects.push({ name, t: this.clock(), x: (b.x - pad) * SCALE, y: (b.y - pad) * SCALE, w: (b.width + 2 * pad) * SCALE, h: (b.height + 2 * pad) * SCALE });
  }
  typed(a, b, n) { this.typing.push([a, b, n]); }
  // A stretch of the recording that prep.mjs may play faster (waits, typing): [from, to, rate].
  fast(a, b, rate) { if (a != null && b != null && b - a > 0.05) this.segs.push([a, b, rate]); }
  mark(label) {
    const l = this.frames[this.frames.length - 1];
    this.marks[label] = l ? l.t + (Date.now() - l.wall) / 1000 : null; // screencast clock, made clip-relative in stop()
  }
  async start() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", async (f) => {
      const file = `${String(this.n++).padStart(6, "0")}.jpg`;
      writeFileSync(path.join(this.dir, file), Buffer.from(f.data, "base64"));
      this.frames.push({ file, t: f.metadata.timestamp, wall: Date.now() });
      try { await this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 96, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    this.t0 = Date.now();
  }
  async stop({ tail = 0.25 } = {}) {
    await sleep(tail * 1000);
    await this.cdp.send("Page.stopScreencast");
    await sleep(150);
    const fr = this.frames;
    if (fr.length < 2) throw new Error(`${this.name}: ${fr.length} frames`);
    const end = fr[fr.length - 1].t + 0.05;
    const lines = [];
    fr.forEach((f, i) => {
      const d = (i + 1 < fr.length ? fr[i + 1].t : end) - f.t;
      lines.push(`file '${f.file}'`, `duration ${Math.max(d, 0.001).toFixed(4)}`);
    });
    lines.push(`file '${fr[fr.length - 1].file}'`);
    writeFileSync(path.join(this.dir, "list.txt"), lines.join("\n"));
    const out = path.join(OUT, `${this.name}.mp4`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(this.dir, "list.txt"),
      "-vf", `fps=${RAW_FPS},scale=1920:1080:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-crf", "12", "-preset", "fast", "-g", String(RAW_FPS), "-an", out]);
    const span = fr[fr.length - 1].t - fr[0].t;
    const gaps = fr.slice(1).map((f, i) => f.t - fr[i].t);
    const slow = gaps.filter((g) => g > 0.08 && g < 0.5).length;
    // marks were taken on the wall clock: shift them to the clock of the first frame
    const marks = Object.fromEntries(Object.entries(this.marks).map(([k, v]) => [k, v == null ? 0 : +(v - fr[0].t).toFixed(3)]));
    const segs = this.segs.map(([a, b, r]) => [+(a - fr[0].t).toFixed(3), +(b - fr[0].t).toFixed(3), r]).filter(([a, b]) => b > 0 && a < span);
    const rel = (t) => +(t - fr[0].t).toFixed(3);
    writeFileSync(path.join(OUT, `${this.name}.marks.json`), JSON.stringify({ duration: +(span + 0.05).toFixed(3), marks, segs,
      clicks: this.clicks.filter((t) => t != null).map(rel), typing: this.typing.map(([a, b, n]) => [rel(a), rel(b), n]),
      rects: this.rects.map((r) => ({ ...r, t: rel(r.t) })) }, null, 1));
    console.log(`${this.name}: gaps >80ms: ${slow}, max gap ${Math.max(...gaps).toFixed(2)}s`);
    console.log(`${this.name}: ${fr.length} frames over ${span.toFixed(2)}s (${(fr.length / span).toFixed(1)} fps captured) -> ${out}`);
    if (!process.env.KEEP_FRAMES) rmSync(this.dir, { recursive: true, force: true });
    return out;
  }
}

// ---- human-ish input ------------------------------------------------------------------------------------------------
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export async function glide(env, x, y, ms = 650) {
  const { page, cursor } = env;
  const x0 = cursor.x, y0 = cursor.y;
  const dist = Math.hypot(x - x0, y - y0);
  const dur = ms || Math.min(1100, 260 + dist * 0.9);
  const steps = Math.max(8, Math.round(dur / 16));
  const bow = Math.min(60, dist * 0.08) * (x >= x0 ? -1 : 1); // a slight arc, as a hand moves
  const start = Date.now();
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const px = x0 + (x - x0) * t + Math.sin(Math.PI * t) * bow * 0.35;
    const py = y0 + (y - y0) * t + Math.sin(Math.PI * t) * bow;
    await page.mouse.move(px, py);
    const wait = start + (dur * i) / steps - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await page.mouse.move(x, y);
  cursor.x = x; cursor.y = y;
}

export async function centerOf(page, sel, { nth = 0, dx = 0, dy = 0 } = {}) {
  const loc = typeof sel === "string" ? page.locator(sel).nth(nth) : sel;
  await loc.waitFor({ state: "visible", timeout: 20000 });
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy };
}

export async function moveTo(env, sel, opts = {}) {
  const c = await centerOf(env.page, sel, opts);
  await glide(env, c.x, c.y, opts.ms);
  return c;
}

export async function click(env, sel, opts = {}) {
  const c = await moveTo(env, sel, opts);
  await sleep(opts.pre ?? 120);
  await env.page.mouse.down();
  if (CURRENT) CURRENT.click();
  await sleep(70);
  await env.page.mouse.up();
  await sleep(opts.post ?? 150);
  return c;
}

export async function humanType(env, text, { seed = 11, base = 62, jitter = 55, rate = 2.2 } = {}) {
  const r = rng(seed);
  const a = CURRENT && CURRENT.clock();
  for (const ch of text) {
    if (ch === "\n") await env.page.keyboard.press("Enter");
    else await env.page.keyboard.type(ch);
    let d = base + r() * jitter;
    if (ch === " ") d += 8 + r() * 30;
    if (ch === "," || ch === "(") d += 30 + r() * 50;
    if (r() < 0.03) d += 110 + r() * 120; // a hesitation
    await sleep(d);
  }
  if (CURRENT) CURRENT.typed(a, CURRENT.clock(), text.length);
  if (CURRENT && rate > 1) CURRENT.fast(a, CURRENT.clock(), rate);
}

export async function open(env, url, { settle = 600 } = {}) {
  await env.page.goto(BASE + url, { waitUntil: "load" });
  await sleep(settle);
}

export const stamp = (s) => encodeURIComponent(s);
export const range = (from, to) => `from=${stamp(from)}&to=${stamp(to)}`;
export { existsSync };

// An eased scroll of a scroll container, run by the page itself so that the footage shows a smooth glide.
export async function smoothScroll(page, selector, to, ms = 1200) {
  await page.evaluate(([sel, to, ms]) => new Promise((resolve) => {
    const el = typeof sel === "string" && sel ? document.querySelector(sel) : document.scrollingElement;
    const from = el.scrollTop, t0 = performance.now();
    const target = to === "end" ? el.scrollHeight : to;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      el.scrollTop = from + (target - from) * e;
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  }), [selector, to, ms]);
}
