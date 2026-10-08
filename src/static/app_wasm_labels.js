(() => {
  "use strict";
  // The adapter of src/wasm/labels.c (src/static/wasm/labels.wasm): the edge label placement of app_graph_kit.js (placeLabels).
  //
  //   ops.labels.run(kernel, input)   input: { count, widths, heights, start, points, obstacleCount, obstacles } (typed arrays, see
  //                                   pack()); returns { status, placed: Uint8Array(count), xy: Float64Array(count * 2) }
  //
  // ns.wasm.labels.pack(requests, obstacles) turns the arguments of kit.placeLabels() into that input;
  // ns.wasm.labels.unpack(requests, result) gives its answer: { placed: Map(key -> rect), dropped: [key] }.
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  ns.wasm.ops.labels = {
    run(kernel, input) {
      return kernel.scope((k) => {
        const widths = k.putF64(input.widths);
        const heights = k.putF64(input.heights);
        const start = k.putI32(input.start);
        const points = k.putF64(input.points);
        const obstacles = k.putF64(input.obstacles);
        const status = k.exports.lb_run(input.count, widths, heights, start, points, input.obstacleCount, obstacles);
        if (status !== 0) return { status };
        return { status: 0, placed: k.readU8(k.exports.lb_placed_ptr(), input.count), xy: k.readF64(k.exports.lb_xy_ptr(), input.count * 2) };
      });
    },
  };

  function pack(requests, obstacles) {
    const count = requests.length;
    const widths = new Float64Array(count);
    const heights = new Float64Array(count);
    const start = new Int32Array(count + 1);
    let total = 0;
    for (const request of requests) total += Array.isArray(request.points) ? request.points.length : 0;
    const points = new Float64Array(total * 2);
    let at = 0;
    requests.forEach((request, i) => {
      widths[i] = request.width;
      heights[i] = request.height || 18;
      start[i] = at;
      const list = Array.isArray(request.points) ? request.points : [];
      for (const point of list) {
        points[at * 2] = point.x;
        points[at * 2 + 1] = point.y;
        at += 1;
      }
    });
    start[count] = at;
    const flat = new Float64Array(obstacles.length * 4);
    obstacles.forEach((rect, i) => {
      flat[i * 4] = rect.x;
      flat[i * 4 + 1] = rect.y;
      flat[i * 4 + 2] = rect.width;
      flat[i * 4 + 3] = rect.height;
    });
    return { count, widths, heights, start, points, obstacleCount: obstacles.length, obstacles: flat };
  }

  function unpack(requests, result) {
    const placed = new Map();
    const dropped = [];
    requests.forEach((request, i) => {
      if (!result.placed[i]) {
        dropped.push(request.key);
        return;
      }
      placed.set(request.key, { x: result.xy[i * 2], y: result.xy[i * 2 + 1], width: request.width, height: request.height || 18 });
    });
    return { placed, dropped };
  }

  ns.wasm.labels = { pack, unpack };
})();
