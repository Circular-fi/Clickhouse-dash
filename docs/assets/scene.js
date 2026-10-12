// The page background: one fixed WebGL2 field of columns for the whole page (no library, one instanced draw call). ClickHouse is
// columnar, so the columns change shape with the section on screen, each shape being a real thing a ClickHouse server does with big
// data:
//   hero      a stream of inserts (a wave of rows landing)
//   features  the sparse primary index: sorted runs of columns, one bright mark per granule, runs merging into longer runs (MergeTree)
//   otel      a latency heatmap: time on one axis, latency on the other, a distribution that drifts and spikes like real traces
//   run       a scan: a crest sweeping across the table, lighting the columns it crosses
// It follows the scroll and the clock, not the pointer.
//
// It is built to cost little: the heights are computed on the CPU for the two shapes that are mixed (a few thousand sums per frame) and
// sent as one small instance buffer, so the vertex shader does almost nothing; it renders at 24 frames per second (10 once the page has
// been left alone for a while), at no more than 1.25 device pixels per pixel, without multisampling, on the low-power GPU; it measures
// its own frame time and lowers its resolution, then stops animating, on a machine that cannot keep up; it stops in hidden tabs. Under
// prefers-reduced-motion or Save-Data it draws still frames while you scroll; without WebGL2 the canvas is hidden.
(() => {
  "use strict";
  const canvas = document.getElementById("columns");
  if (!canvas) return;
  const veil = document.querySelector(".veil");
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches || saveData;
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power", depth: true, stencil: false, preserveDrawingBuffer: false });
  if (!gl) { canvas.hidden = true; return; }

  // Fewer columns on small machines (the field keeps its size)
  const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const COLS = weak ? 48 : 64, ROWS = weak ? 30 : 40;
  const SPACING = 0.62 * (64 / COLS), WIDTH = 0.46 * (64 / COLS);
  const COUNT = COLS * ROWS;

  const vertexSource = `#version 300 es
  precision mediump float;
  layout(location = 0) in vec3 aPos;
  layout(location = 1) in vec3 aNormal;
  layout(location = 2) in vec3 aInst; // height, mark, hot
  uniform mat4 uVP;
  out vec3 vNormal;
  out float vHeight;
  out float vDepth;
  out float vTop;
  out float vMark;
  out float vHot;
  const int COLS = ${COLS};
  const float SPACING = ${SPACING.toFixed(4)};
  const float WIDTH = ${WIDTH.toFixed(4)};
  void main() {
    int id = gl_InstanceID;
    vec2 g = vec2(float(id % COLS), float(id / COLS));
    vec2 p = (g - vec2(float(COLS) - 1.0, ${ROWS}.0 - 1.0) * 0.5) * SPACING;
    float h = aInst.x;
    vec3 world = vec3(p.x, 0.0, p.y) + vec3((aPos.x - 0.5) * WIDTH, aPos.y * h, (aPos.z - 0.5) * WIDTH);
    gl_Position = uVP * vec4(world, 1.0);
    vNormal = aNormal;
    vHeight = aPos.y * h;
    vDepth = gl_Position.w;
    vTop = h;
    vMark = aInst.y;
    vHot = aInst.z;
  }`;

  const fragmentSource = `#version 300 es
  precision mediump float;
  in vec3 vNormal;
  in float vHeight;
  in float vDepth;
  in float vTop;
  in float vMark;
  in float vHot;
  uniform float uDim;
  out vec4 outColor;
  void main() {
    vec3 ground = vec3(0.027, 0.067, 0.122);
    vec3 deep = vec3(0.043, 0.165, 0.29);
    vec3 aqua = vec3(0.27, 0.906, 0.882);
    float level = smoothstep(0.15, 3.4, vHeight);
    vec3 albedo = mix(deep, aqua, level * level);
    albedo = mix(albedo, aqua, 0.85 * vMark * smoothstep(0.0, 0.6, vHeight));
    albedo = mix(albedo, vec3(0.78, 1.0, 0.98), 0.7 * smoothstep(0.35, 1.0, vHot));
    float lit = 0.38 + 0.62 * max(dot(normalize(vNormal), normalize(vec3(-0.35, 1.0, 0.45))), 0.0);
    float top = step(0.9, vNormal.y);
    vec3 color = albedo * lit + aqua * top * 0.22 * smoothstep(1.0, 3.2, vTop);
    color = mix(color, ground, smoothstep(16.0, 40.0, vDepth));
    outColor = vec4(mix(ground, color, uDim), 1.0);
  }`;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(shader)); return null; }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vs || !fs) { canvas.hidden = true; return; }
  const program = gl.createProgram();
  gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(program)); canvas.hidden = true; return; }
  gl.useProgram(program);

  // A unit column (five faces, no bottom): positions and normals, indexed so each corner is shaded once
  const faces = [
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
    [[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
  ];
  const verts = [], indices = [];
  faces.forEach(([normal, quad], f) => {
    quad.forEach((corner) => verts.push(...corner, ...normal));
    const o = f * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  const inst = new Float32Array(COUNT * 3);
  const instBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 12, 0); gl.vertexAttribDivisor(2, 1);

  const uVP = gl.getUniformLocation(program, "uVP"), uDim = gl.getUniformLocation(program, "uDim");

  // The four shapes, on the CPU. A table of hashes keeps them stable.
  const hash = new Float32Array(COUNT * 2);
  for (let i = 0; i < hash.length; i++) { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; hash[i] = s - Math.floor(s); }
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // Each shape writes [height, mark, hot]
  const SHAPES = [
    // 0 stream
    (gx, gz, t, i, out) => {
      const px = (gx - (COLS - 1) / 2) * SPACING * 2, pz = (gz - (ROWS - 1) / 2) * SPACING * 2;
      const a = Math.sin(px * 0.42 + t * 0.9 + Math.sin(pz * 0.31 + t * 0.4) * 1.6);
      const b = Math.sin(pz * 0.36 - t * 0.55 + px * 0.11);
      const c = Math.sin((px + pz) * 0.18 + t * 0.3);
      const v = 0.5 + 0.5 * (0.55 * a + 0.3 * b + 0.15 * c);
      out[0] = 0.12 + 2.9 * Math.pow(v, 1.7); out[1] = 0; out[2] = 0;
    },
    // 1 sorted runs with a mark per granule, merging
    (gx, gz, t, i, out) => {
      const merge = 0.5 + 0.5 * Math.sin(t * 0.35);
      const local = (gx % 8) / 7 * (1 - merge) + (gx % 16) / 15 * merge;
      const block = hash[((Math.floor(gx / 16) * 7 + Math.floor(gz / 5)) * 2) % hash.length];
      out[0] = 0.2 + (0.4 + 2.2 * block) * (0.25 + 0.75 * local); out[1] = gx % 8 === 0 ? 1 : 0; out[2] = 0;
    },
    // 2 latency heatmap
    (gx, gz, t, i, out) => {
      const tx = gx * 0.22 * (64 / COLS) - t * 0.6;
      const lat = gz / ROWS;
      const center = 0.28 + 0.12 * Math.sin(tx * 0.5) + 0.2 * sstep(0.82, 1.0, Math.sin(tx * 0.23 + 1.0));
      const w = 0.1 + 0.06 * Math.sin(tx * 0.9);
      const body = Math.exp(-(((lat - center) / w) ** 2));
      const tail = 0.35 * Math.exp(-lat * 3.2) * (0.5 + 0.5 * Math.sin(tx * 1.7));
      const spike = 0.9 * sstep(0.8, 1.0, Math.sin(tx * 0.31 + 2.0)) * Math.exp(-(((lat - 0.82) / 0.07) ** 2));
      out[0] = 0.12 + 3.0 * (body * (0.7 + 0.3 * hash[(i * 2 + 1) % hash.length]) + tail + spike); out[1] = 0; out[2] = 0;
    },
    // 3 scan crest
    (gx, gz, t, i, out) => {
      const x = ((t * 13 * (COLS / 64)) % (COLS + 30)) - 15;
      const crest = Math.exp(-(((gx - x) / (4.5 * COLS / 64)) ** 2));
      out[0] = 0.28 + 0.1 * Math.sin(gx * 0.3 + t) + 2.3 * crest * (0.55 + 0.45 * hash[(gz * 2) % hash.length]); out[1] = 0; out[2] = crest;
    },
  ];
  const PATTERN = [0, 0, 1, 2, 3]; // by stage: hero, (stream dimmed), features, OpenTelemetry, install

  // Minimal matrices
  const perspective = (fov, aspect, near, far) => {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  };
  const lookAt = (eye, target) => {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = norm(sub(eye, target)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  };
  const multiply = (a, b) => {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
  };
  const mixv = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  // Camera per stage: [eye, target]. The heatmap is seen from higher up so it reads as a chart.
  const CAMERAS = [
    [[4, 9.5, 18], [3.2, 0.8, -1.5]],
    [[4, 10, 19], [3.2, 0.8, -1.5]],
    [[-3, 11, 17], [1.5, 0.4, -2]],
    [[2, 16, 12], [2, 0, -2]],
    [[4, 9, 19], [3, 0.6, -1]],
  ];
  const DIM = [1, 0.42, 0.5, 0.5, 0.46];
  const VEIL = [0, 0.18, 0.3, 0.5, 0.35];

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.clearColor(0.027, 0.067, 0.122, 1);

  // Resolution: at most 1.25 device pixels per pixel, lowered by the frame-time monitor below
  let quality = 1;
  let width = 0, height = 0;
  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.25) * quality;
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio)), h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (w !== width || h !== height) { width = w; height = h; canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
  };

  // The stage follows the section at the middle of the screen: hero 0, features 2, OpenTelemetry 3, run and footer 4 (stage 1 is the
  // stream dimmed, passed through between the hero and the features).
  const sections = ["#top .hero", "#inside", "#opentelemetry", "#run"].map((s) => document.querySelector(s));
  const ANCHOR_STAGES = [0, 2, 3, 4];
  let centers = [];
  const measure = () => {
    const top = window.scrollY;
    centers = sections.map((el) => { const r = el.getBoundingClientRect(); return r.top + top + r.height / 2; });
  };
  const stageNow = () => {
    const y = window.scrollY + window.innerHeight * 0.5;
    if (y <= centers[0]) return ANCHOR_STAGES[0];
    for (let i = 0; i < centers.length - 1; i++) {
      if (y <= centers[i + 1]) return ANCHOR_STAGES[i] + (ANCHOR_STAGES[i + 1] - ANCHOR_STAGES[i]) * (y - centers[i]) / Math.max(1, centers[i + 1] - centers[i]);
    }
    return ANCHOR_STAGES[centers.length - 1];
  };

  const cellA = [0, 0, 0], cellB = [0, 0, 0];
  let stage = 0, lastVeil = -1;
  const start = performance.now();
  const draw = (now, frozen) => {
    resize();
    const target = stageNow();
    stage = frozen ? target : stage + (target - stage) * 0.1;
    const t = frozen ? 2.4 : (now - start) / 1000;
    const intro = frozen ? 1 : Math.min(1, t / 2.6);
    const eased = 1 - Math.pow(1 - intro, 3);
    const aspect = width / height;
    const portrait = aspect < 1;
    const i = Math.min(3, Math.floor(stage)), f = Math.min(1, stage - i);
    const sf = f * f * (3 - 2 * f);
    const pa = PATTERN[i], pb = PATTERN[i + 1];
    const mixed = pa !== pb && sf > 0.002;
    const shapeA = SHAPES[pa], shapeB = SHAPES[pb];
    for (let c = 0, gz = 0; gz < ROWS; gz++) {
      const rise = 1.7 * eased - (gz / ROWS) * 0.7;
      for (let gx = 0; gx < COLS; gx++, c++) {
        shapeA(gx, gz, t, c, cellA);
        let h = cellA[0], mark = cellA[1], hot = cellA[2];
        if (mixed) {
          shapeB(gx, gz, t, c, cellB);
          h += (cellB[0] - h) * sf; mark += (cellB[1] - mark) * sf; hot += (cellB[2] - hot) * sf;
        }
        const arrive = frozen || intro >= 1 ? 1 : sstep(0, 1, rise - (gx / COLS) * 0.25);
        const o = c * 3;
        inst[o] = h * arrive; inst[o + 1] = mark; inst[o + 2] = hot;
      }
    }
    const cam = [mixv(CAMERAS[i][0], CAMERAS[i + 1][0], sf), mixv(CAMERAS[i][1], CAMERAS[i + 1][1], sf)];
    const orbit = frozen ? 0 : Math.sin(t * 0.12) * 0.1;
    const eye = [cam[0][0] + Math.sin(orbit) * 14, cam[0][1] + (portrait ? 2 : 0), cam[0][2] * (portrait ? 1.1 : 1)];
    const view = lookAt(eye, portrait && i === 0 ? [1.5, 0.4, 0.5] : cam[1]);
    const vp = multiply(perspective((portrait ? 58 : 40) * Math.PI / 180, aspect, 0.5, 90), view);
    if (veil) {
      const v = VEIL[i] + (VEIL[i + 1] - VEIL[i]) * sf;
      if (Math.abs(v - lastVeil) > 0.01) { veil.style.opacity = v.toFixed(2); lastVeil = v; }
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(uVP, false, new Float32Array(vp));
    gl.uniform1f(uDim, DIM[i] + (DIM[i + 1] - DIM[i]) * sf);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst);
    gl.drawElementsInstanced(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0, COUNT);
  };

  // Re-measure the page when its size changes (images and fonts move the sections after the first paint)
  const remeasure = () => { measure(); if (still) draw(0, true); };
  window.addEventListener("resize", remeasure, { passive: true });
  if ("ResizeObserver" in window) new ResizeObserver(remeasure).observe(document.body);
  window.addEventListener("load", remeasure);
  measure();

  const stillOnScroll = () => {
    let queued = false;
    window.addEventListener("scroll", () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(0, true); }); }, { passive: true });
    draw(0, true);
  };
  if (still) { stillOnScroll(); return; }

  // The loop: 24 frames per second, 10 after 40 s without a scroll, and a frame-time monitor that backs off
  let running = false, frame = 0, last = 0, lastScrollAt = performance.now(), slow = 0, gaveUp = false;
  window.addEventListener("scroll", () => { lastScrollAt = performance.now(); }, { passive: true });
  const stop = () => { running = false; cancelAnimationFrame(frame); };
  const loop = (now) => {
    if (!running) return;
    frame = requestAnimationFrame(loop);
    const interval = now - lastScrollAt > 40000 ? 100 : 42;
    if (now - last < interval - 4) return;
    const began = performance.now();
    last = now;
    draw(now, false);
    const cost = performance.now() - began;
    if (cost > 22) slow++; else if (slow > 0) slow--;
    if (slow > 30) {
      slow = 0;
      if (quality > 0.6) { quality = quality > 0.8 ? 0.75 : 0.55; width = 0; }
      else if (!gaveUp) { gaveUp = true; stop(); stillOnScroll(); }
    }
  };
  const run = () => { if (running || gaveUp) return; running = true; frame = requestAnimationFrame(loop); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else run(); });
  // Start after the first paint, not in the middle of it
  requestAnimationFrame(() => requestAnimationFrame(run));
})();
