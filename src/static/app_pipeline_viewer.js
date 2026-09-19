(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;
  const { util } = ns;
  const cleanupByContainer = new WeakMap();
  function dispose(container) {
    cleanupByContainer.get(container)?.();
    cleanupByContainer.delete(container);
  }

  const fmtInt = (value) => Number.isFinite(Number(value))
    ? new Intl.NumberFormat().format(Number(value))
    : "—";

  const fmtBytes = (value) => util && typeof util.formatBytes === "function"
    ? util.formatBytes(Number(value) || 0)
    : `${fmtInt(value)} B`;

  function durationLabel(us) {
    const value = Math.max(0, Number(us) || 0);
    if (value < 1000) return `${Math.round(value)}µs`;
    const ms = value / 1000;
    if (ms < 10) return `${ms.toFixed(2)}ms`;
    if (ms < 100) return `${ms.toFixed(1)}ms`;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = ms / 1000;
    return seconds < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
  }

  function operationName(value) {
    const raw = String(value || "");
    return raw.replace(/(?:_\d+)+$/g, "") || raw;
  }

  function operationKey(value) {
    return operationName(value)
      .replace(/(?:[_ .-](?:thread|worker|port|stream|lane)?\d+)+$/gi, "")
      .replace(/[^a-z0-9]+/gi, "")
      .toLowerCase();
  }

  const keyOf = (...parts) => JSON.stringify(parts);
  const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const identity = (value) => typeof value === "number" && !Number.isSafeInteger(value)
    ? "" : String(value ?? "");
  const processorKey = (host, query, id) => keyOf(host, query, id);

  function mergeSegments(segments) {
    const sorted = segments.map((segment) => ({
      start: number(segment.start_time_us ?? segment.start),
      finish: number(segment.finish_time_us ?? segment.finish),
    })).filter((segment) => segment.start > 0 && segment.finish >= segment.start)
      .sort((a, b) => a.start - b.start || a.finish - b.finish);
    const merged = [];
    for (const segment of sorted) {
      const last = merged[merged.length - 1];
      if (last && segment.start <= last.finish) last.finish = Math.max(last.finish, segment.finish);
      else merged.push({ ...segment });
    }
    return merged;
  }

  function traceContext(processors, summary, spans, attemptIds) {
    const queries = Array.from(new Set([
      ...attemptIds.map(String), ...processors.map((row) => String(row.query_id || "")),
    ].filter(Boolean)));
    const hosts = Array.from(new Set(processors.map((row) => String(row.hostname || ""))));
    const traceQueries = new Map();
    const traceHosts = new Map();
    for (const source of [summary, spans]) for (const row of source) {
      const trace = String(row.trace_id || "");
      if (!trace) continue;
      const query = String(row.query_id || "");
      const host = String(row.hostname || "");
      if (query) {
        if (!traceQueries.has(trace)) traceQueries.set(trace, new Set());
        traceQueries.get(trace).add(query);
      }
      if (host) {
        if (!traceHosts.has(trace)) traceHosts.set(trace, new Set());
        traceHosts.get(trace).add(host);
      }
    }
    return {
      queries,
      resolve(row) {
        const trace = String(row.trace_id || "");
        const mapped = traceQueries.get(trace);
        const query = mapped?.size === 1 ? mapped.values().next().value
          : (!mapped && queries.length === 1 ? queries[0] : "");
        const mappedHosts = traceHosts.get(trace);
        const host = String(row.hostname || "") || (mappedHosts?.size === 1
          ? mappedHosts.values().next().value : (hosts.length === 1 ? hosts[0] : ""));
        if (!query || (!host && hosts.length > 1)) return null;
        return { query, host };
      },
    };
  }

  function buildProcessorTraceSummary(rows, spans, context, bucketUs = 0) {
    const byFamily = new Map();
    const allSegments = [];
    const exact = new Map();
    const bucket = number(bucketUs);
    for (const row of rows) {
      const start = number(row.first_start_time_us);
      const finish = number(row.last_finish_time_us);
      if (!start || finish < start) continue;
      const activeUs = number(row.active_time_us);
      const eventCount = number(row.event_count);
      const bucketStart = bucket > 0 ? Math.floor(start / bucket) * bucket : start;
      const segment = { start, finish, activeUs, eventCount, bucketStart, bucketUs: bucket };
      allSegments.push(segment);
      const scope = context.resolve(row);
      const operation = operationName(row.operation_name);
      const family = operationKey(operation);
      if (!scope || !family) continue;
      const key = keyOf(scope.host, scope.query, row.trace_id, row.parent_span_id, operation);
      if (!exact.has(key)) exact.set(key, {
        ...scope, operation, family, activeUs: 0, eventCount: 0, segments: [],
      });
      const entry = exact.get(key);
      entry.activeUs += activeUs;
      entry.eventCount += eventCount;
      entry.segments.push(segment);
    }
    for (const entry of exact.values()) {
      entry.segments = bucket > 0
        ? entry.segments.sort((a, b) => a.bucketStart - b.bucketStart || a.start - b.start || a.finish - b.finish)
        : mergeSegments(entry.segments).map((segment) => ({ ...segment, envelope: true }));
      const key = keyOf(entry.host, entry.query, entry.family);
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(entry);
    }
    return { byFamily, allSegments };
  }

  // Sorted cost buckets and disjoint sets keep matching O((P + S) log P).
  // Empty buckets are skipped without rescanning already matched processors.
  function costIndex(candidates) {
    const byCost = new Map();
    for (const candidate of candidates) {
      const cost = candidate.elapsed;
      if (!byCost.has(cost)) byCost.set(cost, new Map());
      const stages = byCost.get(cost);
      if (!stages.has(candidate.group.key)) stages.set(candidate.group.key, []);
      stages.get(candidate.group.key).push(candidate);
    }
    const costs = Array.from(byCost.keys()).sort((a, b) => a - b);
    const buckets = costs.map((cost) => byCost.get(cost));
    const next = Array.from({ length: costs.length + 1 }, (_, i) => i);
    const previous = Array.from({ length: costs.length + 1 }, (_, i) => i);
    const mixed = Symbol("multiple stages");
    const combine = (a, b) => !a ? b : !b ? a : a === b ? a : mixed;
    let treeSize = 1;
    while (treeSize < costs.length) treeSize *= 2;
    const tree = new Array(treeSize * 2).fill(null);
    buckets.forEach((bucket, i) => {
      tree[treeSize + i] = bucket.size === 1 ? bucket.keys().next().value : mixed;
    });
    for (let i = treeSize - 1; i > 0; i -= 1) tree[i] = combine(tree[i * 2], tree[i * 2 + 1]);
    const lowerBound = (value, inclusive = false) => {
      let lo = 0;
      let hi = costs.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (costs[mid] < value || (inclusive && costs[mid] === value)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const rangeStage = (lo, hi) => {
      let result = null;
      for (lo += treeSize, hi += treeSize; lo < hi; lo >>>= 1, hi >>>= 1) {
        if (lo & 1) result = combine(result, tree[lo++]);
        if (hi & 1) result = combine(result, tree[--hi]);
      }
      return result;
    };
    const find = (parents, value) => {
      let root = value;
      while (parents[root] !== root) root = parents[root];
      while (value !== root) {
        const parent = parents[value];
        parents[value] = root;
        value = parent;
      }
      return root;
    };
    return {
      take(active) {
        const lo = lowerBound(active);
        const neighbors = [find(next, lo), find(previous, lo) - 1]
          .filter((i) => i >= 0 && i < costs.length)
          .map((i) => {
            const elapsed = costs[i];
            const scale = Math.max(100, elapsed, active);
            const score = Math.abs(elapsed - active) / scale;
            return { i, score, stages: buckets[i] };
          }).sort((a, b) => a.score - b.score || a.i - b.i);
        const best = neighbors[0];
        if (!best || best.score > 0.25 || best.stages.size !== 1) return null;
        const [stage, items] = best.stages.entries().next().value;
        const tolerance = Math.min(0.25, best.score + 0.05);
        const lower = Math.max(0, active - tolerance * Math.max(100, active));
        const upper = active >= 100 * (1 - tolerance)
          ? active / (1 - tolerance) : active + 100 * tolerance;
        if (rangeStage(lowerBound(lower), lowerBound(upper, true)) !== stage) return null;
        const candidate = items.pop();
        if (!items.length) best.stages.delete(stage);
        if (!best.stages.size) {
          next[best.i] = find(next, best.i + 1);
          previous[best.i + 1] = find(previous, best.i);
          let node = treeSize + best.i;
          tree[node] = null;
          while (node > 1) {
            node >>>= 1;
            tree[node] = combine(tree[node * 2], tree[node * 2 + 1]);
          }
        }
        return candidate;
      },
    };
  }

  function buildProcessorGroups(processors, context) {
    const groups = new Map();
    const processorById = new Map();
    let invalidIdentities = 0;
    const attemptIndex = new Map(context.queries.map((query, index) => [query, index]));
    for (const row of processors) {
      const query = String(row.query_id || "");
      const host = String(row.hostname || "");
      const id = identity(row.id);
      const planStep = identity(row.plan_step);
      const parents = Array.isArray(row.parent_ids) ? row.parent_ids.map(identity) : [];
      const invalid = !id || id === "0" || !planStep || parents.some((parent) => !parent);
      if (invalid) invalidIdentities += 1;
      // plan_step=0 has no logical step: keep its different processor types apart.
      const processorName = operationName(row.name || "Processor");
      const key = keyOf(host, query, planStep || `invalid-${groups.size}`,
        planStep === "0" ? processorName : "");
      if (!groups.has(key)) groups.set(key, {
        key, hostname: host, queryId: query, attempt: attemptIndex.get(query) ?? 0,
        planStep, planStepName: String(row.plan_step_name || ""),
        description: String(row.plan_step_description || ""),
        processorNames: new Set(), processorRows: [], upstream: new Set(), downstream: new Set(),
        lanes: 0, elapsedSum: 0, elapsedMax: 0, inputWaitMax: 0, outputWaitMax: 0,
        inputRows: 0, inputBytes: 0, outputRows: 0, outputBytes: 0,
        segments: [], timingEstimated: false, timingSources: new Set(), flowApproximate: false,
        traceActiveUs: 0, traceEventCount: 0, traceOperations: new Set(),
      });
      const group = groups.get(key);
      const name = processorName;
      const item = {
        row, group, id, parents, incoming: [], outgoing: [], invalid,
        elapsed: number(row.elapsed_us), family: operationKey(name),
      };
      group.processorRows.push(item);
      group.processorNames.add(name);
      group.lanes += 1;
      const elapsed = item.elapsed;
      group.elapsedSum += elapsed;
      group.elapsedMax = Math.max(group.elapsedMax, elapsed);
      group.inputWaitMax = Math.max(group.inputWaitMax, number(row.input_wait_elapsed_us));
      group.outputWaitMax = Math.max(group.outputWaitMax, number(row.output_wait_elapsed_us));
      if (!invalid) {
        const scopedId = processorKey(host, query, id);
        if (processorById.has(scopedId)) {
          const duplicate = processorById.get(scopedId);
          if (duplicate) duplicate.invalid = true;
          item.invalid = true;
          processorById.set(scopedId, null);
          invalidIdentities += 1;
        } else processorById.set(scopedId, item);
      }
    }
    for (const group of groups.values()) {
      for (const item of group.processorRows) {
        // parent_ids point to downstream processors.
        for (const parent of new Set(item.parents)) {
          const downstream = processorById.get(processorKey(group.hostname, group.queryId, parent));
          if (item.invalid || !downstream || downstream.invalid) {
            group.flowApproximate = true;
            continue;
          }
          item.outgoing.push(downstream);
          downstream.incoming.push(item);
          if (downstream.group !== group) {
            group.downstream.add(downstream.group.key);
            downstream.group.upstream.add(group.key);
          }
        }
      }
    }
    for (const group of groups.values()) {
      let inputBoundaries = 0;
      let outputBoundaries = 0;
      for (const item of group.processorRows) {
        const internalIn = item.incoming.some((other) => other.group === group);
        const internalOut = item.outgoing.some((other) => other.group === group);
        if (item.invalid || (internalIn && item.incoming.some((other) => other.group !== group)) ||
            (internalOut && item.outgoing.some((other) => other.group !== group))) group.flowApproximate = true;
        if (!internalIn) {
          inputBoundaries += 1;
          group.inputRows += number(item.row.input_rows);
          group.inputBytes += number(item.row.input_bytes);
        }
        if (!internalOut) {
          outputBoundaries += 1;
          group.outputRows += number(item.row.output_rows);
          group.outputBytes += number(item.row.output_bytes);
        }
      }
      if (!inputBoundaries || !outputBoundaries) group.flowApproximate = true;
    }
    // A cursor queue avoids shift(), repeated sorting and includes() scans.
    const orderedGroups = Array.from(groups.values()).sort((a, b) =>
      a.attempt - b.attempt || a.hostname.localeCompare(b.hostname) ||
      a.planStep.length - b.planStep.length || a.planStep.localeCompare(b.planStep) || a.key.localeCompare(b.key));
    const indegree = new Map(orderedGroups.map((group) => [group.key, group.upstream.size]));
    const ready = orderedGroups.filter((group) => !group.upstream.size);
    const ordered = [];
    const visited = new Set();
    for (let cursor = 0; cursor < ready.length; cursor += 1) {
      const group = ready[cursor];
      ordered.push(group);
      visited.add(group.key);
      for (const key of group.downstream) {
        const degree = indegree.get(key) - 1;
        indegree.set(key, degree);
        if (!degree) ready.push(groups.get(key));
      }
    }
    const cyclic = ordered.length !== groups.size;
    for (const group of orderedGroups) if (!visited.has(group.key)) ordered.push(group);
    return { groups: ordered, cyclic, invalidIdentities };
  }

  function attachTiming(groups, summary, spans, context, summaryBucketUs = 0) {
    const byFamily = new Map();
    for (const group of groups) {
      for (const item of group.processorRows) {
        const key = keyOf(group.hostname, group.queryId, item.family);
        if (!byFamily.has(key)) byFamily.set(key, []);
        byFamily.get(key).push(item);
      }
    }
    const fallbackGroups = new Map();
    for (const [key, candidates] of byFamily) {
      const group = candidates[0].group;
      if (candidates.every((item) => item.group === group)) fallbackGroups.set(key, group);
    }
    const summarized = new Set();
    let unmatched = 0;
    for (const [key, instances] of summary.byFamily) {
      const candidates = byFamily.get(key);
      if (!candidates?.length) continue;
      summarized.add(key);
      const stages = new Set(candidates.map((item) => item.group));
      const onlyStage = stages.size === 1 ? stages.values().next().value : null;
      const index = onlyStage ? null : costIndex(candidates);
      instances.sort((a, b) => a.activeUs - b.activeUs || a.operation.localeCompare(b.operation));
      for (const instance of instances) {
        const best = onlyStage ? { group: onlyStage } : index.take(instance.activeUs);
        if (!best) { unmatched += 1; continue; }
        best.group.segments.push(...instance.segments.map((segment) => ({ ...segment })));
        best.group.traceActiveUs += instance.activeUs;
        best.group.traceEventCount += instance.eventCount;
        best.group.traceOperations.add(instance.operation);
        best.group.timingEstimated ||= !onlyStage;
        best.group.timingSources.add("summary");
      }
    }
    // Backward-compatible fallback, per family: never assign duplicate names to
    // the busiest stage or suppress other families after one summary match.
    for (const span of spans) {
      const scope = context.resolve(span);
      if (!scope) continue;
      const key = keyOf(scope.host, scope.query, operationKey(span.operation_name));
      if (summarized.has(key)) continue;
      const group = fallbackGroups.get(key);
      if (!group) continue;
      const segments = span.segments?.length ? span.segments : [span];
      for (const segment of segments) group.segments.push({ ...segment, detail: true });
      group.timingSources.add("detail");
    }
    const bucketUs = number(summaryBucketUs);
    for (const group of groups) {
      const buckets = new Map();
      const detail = [];
      const envelopes = [];
      for (const segment of group.segments) {
        if (segment.envelope) {
          envelopes.push(segment);
          continue;
        }
        if (number(segment.bucketUs) <= 0) {
          detail.push(segment);
          continue;
        }
        const bucketStart = number(segment.bucketStart);
        if (!buckets.has(bucketStart)) buckets.set(bucketStart, {
          start: segment.start,
          finish: segment.finish,
          activeUs: 0,
          eventCount: 0,
          bucketStart,
          bucketUs,
          bucketed: true,
        });
        const item = buckets.get(bucketStart);
        item.start = Math.min(item.start, segment.start);
        item.finish = Math.max(item.finish, segment.finish);
        item.activeUs += number(segment.activeUs);
        item.eventCount += number(segment.eventCount);
      }
      const bucketSegments = Array.from(buckets.values()).map((segment) => ({
        ...segment,
        density: segment.activeUs / Math.max(1, segment.finish - segment.start),
      }));
      group.segments = [...bucketSegments,
        ...mergeSegments(detail).map((segment) => ({ ...segment, detail: true })),
        ...mergeSegments(envelopes).map((segment) => ({ ...segment, envelope: true }))]
        .sort((a, b) => a.start - b.start || a.finish - b.finish);
    }
    return unmatched;
  }

  function groupIsMeaningful(group) {
    return group.elapsedSum > 0 || group.inputWaitMax > 0 || group.outputWaitMax > 0 ||
      group.inputRows > 0 || group.outputRows > 0 || group.inputBytes > 0 || group.outputBytes > 0;
  }

  function buildModel(options = {}) {
    const processors = Array.isArray(options.processors) ? options.processors : [];
    const spans = Array.isArray(options.spans) ? options.spans : [];
    const rows = options.processorTraceSummary?.[Symbol.iterator] ? options.processorTraceSummary : [];
    const context = traceContext(processors, rows, spans, options.attemptIds || []);
    const traceSummary = buildProcessorTraceSummary(options?.processorTraceSummary || [], spans, context, options.summaryBucketUs || 0);
    const graph = buildProcessorGroups(processors, context);
    if (options.processorsTruncated) {
      for (const group of graph.groups) group.flowApproximate = true;
    }
    const unmatched = attachTiming(
      graph.groups, traceSummary, spans, context, options.summaryBucketUs || 0);
    const meaningful = graph.groups.filter(groupIsMeaningful);
    const groups = meaningful.length ? meaningful : graph.groups;
    const summarySegments = traceSummary.allSegments;
    const traceSegments = mergeSegments(spans);
    const timeSegments = summarySegments.length ? summarySegments : traceSegments;
    let start = 0;
    let finish = 0;
    for (const segment of timeSegments) {
      if (!start || segment.start < start) start = segment.start;
      finish = Math.max(finish, segment.finish);
    }
    const totalWorkUs = groups.reduce((sum, group) => sum + group.elapsedSum, 0);
    let peakDensity = 0;
    let envelopeCount = 0;
    let detailCount = 0;
    for (const group of groups) {
      group.workShare = totalWorkUs > 0 ? group.elapsedSum / totalWorkUs : 0;
      for (const segment of group.segments) {
        peakDensity = Math.max(peakDensity, number(segment.density));
        if (segment.envelope) envelopeCount += 1;
        if (segment.detail) detailCount += 1;
      }
    }
    return {
      groups, start, finish, window: Math.max(1, finish - start), unmatched,
      totalWorkUs, peakDensity, envelopeCount, detailCount,
      processorCount: processors.length, tracedCount: groups.filter((group) => group.segments.length).length,
      estimatedCount: groups.filter((group) => group.timingEstimated).length,
      cyclic: graph.cyclic, invalidIdentities: graph.invalidIdentities,
      attemptCount: context.queries.length,
    };
  }

  function metric(label, value, hint = "") {
    const box = document.createElement("div");
    box.className = "pipelineViewer__metric";
    const k = document.createElement("span");
    k.className = "pipelineViewer__metricLabel srOnly";
    k.textContent = label;
    const v = document.createElement("strong");
    v.className = "pipelineViewer__metricValue";
    if (Array.isArray(value)) {
      for (const part of value) {
        const line = document.createElement("span");
        line.className = "pipelineViewer__flowValue";
        line.textContent = part;
        v.appendChild(line);
      }
    } else v.textContent = value;
    if (hint) v.title = hint;
    box.append(k, v);
    return box;
  }

  function timeLabel(us, windowUs) {
    if (us >= 1000000 && windowUs < 1000000) {
      return `${(us / 1000000).toFixed(windowUs < 1000 ? 6 : windowUs < 100000 ? 4 : 3)}s`;
    }
    return durationLabel(us);
  }

  function selectWindow(model, start, finish) {
    const width = Math.min(model.window, Math.max(1, finish - start));
    const offset = Math.max(0, Math.min(model.window - width, start));
    return { start: offset, finish: offset + width, width };
  }

  // Display bins are a bounded projection of measured intervals. Summary work
  // is spread inside its own aggregation window only; its internal gaps are unknown.
  function projectActivity(segments, start, finish, count = 192) {
    count = Math.max(1, Math.min(512, Math.floor(number(count)) || 1));
    const width = Math.max(1, finish - start) / count;
    const cells = new Array(count);
    for (const segment of segments) {
      if (segment.envelope || segment.finish < start || segment.start > finish) continue;
      if (segment.finish === start && segment.start < start) continue;
      if (segment.start === finish && segment.finish > finish) continue;
      const lo = Math.max(start, segment.start);
      const hi = Math.min(finish, segment.finish);
      const rate = segment.bucketed ? number(segment.density) : 1;
      const first = Math.min(count - 1, Math.max(0, Math.floor((lo - start) / width)));
      const last = Math.min(count - 1, Math.max(first, Math.ceil((hi - start) / width) - 1));
      for (let i = first; i <= last; i += 1) {
        const left = Math.max(lo, start + i * width);
        const right = Math.min(hi, start + (i + 1) * width);
        if (!cells[i]) cells[i] = { index: i, start: left, finish: right, workUs: 0, bucketed: false, detail: false };
        const cell = cells[i];
        cell.start = Math.min(cell.start, left);
        cell.finish = Math.max(cell.finish, right);
        cell.workUs += Math.max(0, right - left) * rate;
        cell.bucketed ||= !!segment.bucketed;
        cell.detail ||= !!segment.detail;
      }
    }
    return cells.filter(Boolean).map((cell) => ({ ...cell,
      density: cell.workUs / Math.max(1, cell.finish - cell.start),
    }));
  }

  function workLabel(share) {
    if (share > 0 && share < 0.001) return "<0.1%";
    return `${(share * 100).toFixed(1)}%`;
  }

  function stageTitle(group) {
    if (group.planStepName) return group.planStepName;
    const names = Array.from(group.processorNames || []);
    return names[0] || "Pipeline stage";
  }

  function stageProcessorLabel(group) {
    const names = Array.from(group.processorNames || []);
    const shown = names.slice(0, 3);
    const extra = names.length > shown.length ? ` +${names.length - shown.length}` : "";
    const laneSuffix = group.lanes > 1 ? ` · ${group.lanes} processors` : " · 1 processor";
    return `${shown.join(" · ")}${extra}${laneSuffix}`;
  }

  function addTimelineTicks(parent, view) {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const tick = document.createElement("span");
      tick.className = "pipelineViewer__tick";
      tick.style.left = `${ratio * 100}%`;
      const label = document.createElement("b");
      label.textContent = timeLabel(view.start + view.width * ratio, view.width);
      tick.appendChild(label);
      parent.appendChild(tick);
    }
  }

  function render(container, options = {}) {
    if (!container) return null;
    dispose(container);
    container.replaceChildren();
    container.classList.remove("traceViewerHost");
    container.classList.add("pipelineViewerHost");
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = `pipelineViewer__${className}`;
      if (text != null) node.textContent = text;
      return node;
    };
    const button = (label, title, action) => {
      const node = element("button", "control", label);
      node.type = "button";
      node.title = title;
      node.setAttribute("aria-label", title);
      node.addEventListener("click", action);
      return node;
    };
    if (!options.processors?.length) {
      let message = "No processor profiling rows were recorded for this query.";
      if (options.error) {
        message = `Processor profiling is unavailable: ${options.error}`;
      } else if (options.profilingStatus === "disabled_for_query") {
        message = "Processor profiling was disabled for this query (log_processors_profiles=0).";
      } else if (options.profilingStatus === "query_log_pending") {
        message = "Processor profiling metadata is still pending in system.query_log.";
      } else if (options.profilingStatus === "table_unavailable") {
        message = "system.processors_profile_log is unavailable on this ClickHouse server.";
      } else if (options.profilingStatus === "enabled_no_rows") {
        message = "Processor profiling was enabled for this query, but system.processors_profile_log contains no rows for it.";
      } else if (options.profilingStatus === "unknown_no_rows") {
        message = "No processor rows were found, and ClickHouse did not expose the effective log_processors_profiles setting for this query.";
      }
      const empty = element("div", "", message);
      empty.className = "analysisEmpty";
      container.appendChild(empty);
      return null;
    }

    const model = options.model || buildModel(options);
    let view = selectWindow(model, 0, model.window);
    let selected = null;
    const overviewTables = Array.isArray(options.overview?.tables) ? options.overview.tables.map(String).filter(Boolean) : [];
    const root = element("div");
    root.className = "pipelineViewer";
    const header = element("div", "summary");
    header.append(
      element("div", "summaryText", `${model.groups.length} stages · ${model.processorCount} processors · ${durationLabel(model.totalWorkUs)} total work`),
      element("div", "summaryNote", "Time position and accumulated work are separate measurements"));
    root.appendChild(header);

    const legend = element("div", "legend");
    legend.append(element("span", "explanation", "Stages process blocks concurrently. Read each row on the same time axis."));
    const scale = element("span", "densityLegend", "Height + shade: work density ");
    scale.append(element("span", "densityRamp"), document.createTextNode(" low → high"));
    scale.title = "Same color scale for every stage. Summed processor work divided by the observed window duration; not CPU utilization. Activity inside each summary window is coalesced.";
    legend.append(scale);
    root.appendChild(legend);

    const warnings = [];
    if (options.processorsTruncated) warnings.push("Processor limit reached; costs, shares and flows cover retained processors only.");
    if (options.summaryTruncated) warnings.push("Activity summary is partial; empty areas may contain unrecorded activity.");
    if (options.summaryError) warnings.push(`Activity summary unavailable: ${options.summaryError}`);
    if (options.traceError) warnings.push(`OpenTelemetry lookup failed: ${options.traceError}`);
    if (options.truncated) warnings.push(number(options.summaryBucketUs) > 0 && !options.summaryTruncated && !options.summaryError
      ? "Detailed Tracing is truncated; the full activity summary remains available."
      : "Detailed Tracing is truncated; missing activity cannot be reconstructed from first/last timestamps.");
    if (model.envelopeCount) warnings.push("Older summary: dashed ranges show first/last timestamps only. Run with profiling again to record activity windows.");
    if (model.unmatched) warnings.push(`${model.unmatched} timing groups have an ambiguous stage match.`);
    if (model.estimatedCount) warnings.push("≈ marks an estimated stage match; the timestamps themselves are measured.");
    if (model.invalidIdentities) warnings.push("Some processor IDs are missing, duplicated or imprecise; their links are unavailable.");
    if (model.cyclic) warnings.push("The stage graph contains a cycle; remaining stages use a stable display order.");
    if (!model.start && !options.traceError && !options.summaryError) warnings.push("No OpenTelemetry timing is available; processor counters are shown below.");
    if (options.truncated && model.detailCount) warnings.push("Rows using detailed spans have partial timing coverage.");
    if (warnings.length) {
      const notice = element("div", "notice", warnings.join(" "));
      notice.setAttribute("role", "status");
      root.appendChild(notice);
    }

    const controls = element("div", "controls");
    const setView = (start, finish) => {
      view = selectWindow(model, start, finish);
      drawTimelines();
    };
    const shift = (direction) => setView(view.start + direction * view.width * 0.75, view.finish + direction * view.width * 0.75);
    const zoom = (factor) => {
      const width = Math.min(model.window, Math.max(1, view.width * factor));
      setView(view.start + (view.width - width) / 2, view.start + (view.width + width) / 2);
    };
    const reset = button("Full query", "Show the complete query", () => setView(0, model.window));
    const back = button("←", "Move to earlier activity", () => shift(-1));
    const zoomOut = button("−", "Zoom out", () => zoom(2));
    const zoomIn = button("+", "Zoom in", () => zoom(0.5));
    const forward = button("→", "Move to later activity", () => shift(1));
    const end = button("End · 1%", "Inspect the last one percent of the query", () => setView(model.window * 0.99, model.window));
    const rangeLabel = element("output", "range");
    rangeLabel.setAttribute("aria-live", "polite");
    const sort = element("select", "sort");
    sort.setAttribute("aria-label", "Stage order");
    for (const [value, label] of [["pipeline", "Pipeline order"], ["work", "Most work first"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sort.appendChild(option);
    }
    controls.append(reset, back, zoomOut, zoomIn, forward, end, rangeLabel, sort);
    root.appendChild(controls);

    const table = element("div", "table");
    const body = element("div", "scroll");
    const head = element("div", "head");
    const timelineHead = element("div", "timelineHead");
    const workHead = element("div", "workHead", "Work Σ · share");
    workHead.title = "Accumulated active processor time and share of total recorded work. This is not elapsed query time.";
    const metricsHead = element("div", "metricsHead");
    for (const label of ["In wait max", "Out wait max", "Input", "Output"]) metricsHead.appendChild(element("span", "", label));
    head.append(element("div", "", "Pipeline stage"), timelineHead, workHead, metricsHead);
    body.appendChild(head);
    let rowViews = [];
    const indexedGroups = model.groups.map((group, order) => ({ group, order }));
    let orderedGroups = indexedGroups;
    const virtual = indexedGroups.length > 150;
    const rowHeight = 40;
    let mountedStart = -1;
    let mountedFinish = -1;
    const beforeRows = element("div", "spacer");
    const afterRows = element("div", "spacer");
    beforeRows.setAttribute("aria-hidden", "true");
    afterRows.setAttribute("aria-hidden", "true");
    body.append(beforeRows, afterRows);
    body.tabIndex = 0;
    body.setAttribute("aria-label", "Pipeline stages. Scroll to inspect all stages.");
    const focusGroup = (group) => {
      selected = group;
      let start = Infinity;
      let finish = 0;
      for (const segment of group.segments) {
        start = Math.min(start, segment.start - model.start);
        finish = Math.max(finish, segment.finish - model.start);
      }
      if (Number.isFinite(start)) {
        const width = Math.max(finish - start, number(options.summaryBucketUs), model.window / 1000, 1);
        setView(start - width * 0.1, start + width * 1.1);
      }
    };
    function createRow(group, index) {
      const row = element("div", "row");
      if (!group.segments.length) row.classList.add("pipelineViewer__row--untimed");
      const stage = element("div", "stage");
      const stageText = element("div", "stageText");
      const title = element("strong", "stageTitle", stageTitle(group));
      const sub = element("span", "stageSub", stageProcessorLabel(group));
      if (model.attemptCount > 1) sub.textContent = `Attempt ${group.attempt + 1} · ${sub.textContent}`;
      if (overviewTables.length === 1 && /read|source|mergetree/i.test(`${group.planStepName} ${sub.textContent}`)) sub.textContent += ` · ${overviewTables[0]}`;
      stageText.title = `${title.textContent}\n${sub.textContent}\n${group.description || ""}\nHost: ${group.hostname || "unknown"}\nQuery: ${group.queryId || "unknown"}`;
      stageText.append(title, sub);
      const focus = button("⌕", `Focus activity for stage ${index + 1}: ${stageTitle(group)}`, () => focusGroup(group));
      focus.classList.add("pipelineViewer__focus");
      focus.disabled = !group.segments.length;
      stage.append(element("span", "ordinal", String(index + 1).padStart(2, "0")), stageText, focus);
      const timeline = element("div", "timeline");
      const work = element("div", "work");
      work.title = `${durationLabel(group.elapsedSum)} accumulated active work; ${workLabel(group.workShare)} of all recorded stage work. Waits are separate counters. Parallel work can exceed query duration.`;
      const workValues = element("div", "workValues");
      workValues.append(element("strong", "", durationLabel(group.elapsedSum)), element("span", "", workLabel(group.workShare)));
      const workTrack = element("div", "workTrack");
      const workBar = element("span", "workBar");
      workBar.style.width = `${group.workShare * 100}%`;
      workTrack.appendChild(workBar);
      work.append(workValues, workTrack);
      const metrics = element("div", "metrics");
      metrics.append(
        metric("In wait", durationLabel(group.inputWaitMax), "Maximum input wait on one processor; its position in time is not recorded."),
        metric("Out wait", durationLabel(group.outputWaitMax), "Maximum output/backpressure wait on one processor; its position in time is not recorded."),
        metric("Input", [group.flowApproximate ? `≈ ${fmtInt(group.inputRows)}` : fmtInt(group.inputRows), fmtBytes(group.inputBytes)], "Sum at stage entry processors; incomplete boundaries are approximate."),
        metric("Output", [group.flowApproximate ? `≈ ${fmtInt(group.outputRows)}` : fmtInt(group.outputRows), fmtBytes(group.outputBytes)], "Sum at stage exit processors; parallel lanes are included."));
      row.append(stage, timeline, work, metrics);
      return { group, row, timeline, order: index };
    }
    sort.addEventListener("change", () => {
      orderedGroups = [...indexedGroups];
      if (sort.value === "work") orderedGroups.sort((a, b) => b.group.elapsedSum - a.group.elapsedSum || a.order - b.order);
      body.scrollTop = 0;
      mountRows(true);
    });

    const hint = element("div", "hint");
    const defaultHint = () => number(options.summaryBucketUs) > 0
      ? `Summary resolution: ${durationLabel(options.summaryBucketUs)}. Shade estimates work density inside each window; gaps within a window are unknown. Hover for times; use ⌕ to focus a stage.`
      : model.envelopeCount
        ? "Dashed ranges contain unknown activity gaps. Work Σ stays available even when the temporal detail is missing."
        : "Recorded intervals use the available trace resolution. Work Σ covers the whole query; waits have no recorded position on the time axis.";
    hint.textContent = defaultHint();
    table.appendChild(body);
    root.append(table, hint);
    container.appendChild(root);

    function mountRows(force = false) {
      const offset = Math.max(0, body.scrollTop - head.offsetHeight);
      const start = virtual ? Math.max(0, Math.floor(offset / rowHeight) - 6) : 0;
      const finish = virtual ? Math.min(orderedGroups.length, start + Math.ceil(body.clientHeight / rowHeight) + 13) : orderedGroups.length;
      if (!force && start === mountedStart && finish === mountedFinish) return;
      mountedStart = start;
      mountedFinish = finish;
      const focusedOrder = rowViews.find(item => item.row.contains(document.activeElement))?.order;
      for (const item of rowViews) item.row.remove();
      rowViews = orderedGroups.slice(start, finish).map(item => createRow(item.group, item.order));
      beforeRows.style.height = `${start * rowHeight}px`;
      afterRows.style.height = `${(orderedGroups.length - finish) * rowHeight}px`;
      const fragment = document.createDocumentFragment();
      for (const item of rowViews) fragment.appendChild(item.row);
      body.insertBefore(fragment, afterRows);
      if (focusedOrder != null) {
        const focus = rowViews.find(item => item.order === focusedOrder)?.row.querySelector("button");
        (focus || body).focus({ preventScroll: true });
      }
      drawTimelines();
    }
    let animationFrame = 0;
    body.addEventListener("scroll", () => {
      if (!virtual || animationFrame) return;
      animationFrame = requestAnimationFrame(() => { animationFrame = 0; if (root.isConnected) mountRows(); });
    }, { passive: true });
    // Resizing changes the visible row count. Disconnect as soon as this view
    // is replaced; the observer must never retain an old profiling payload.
    const resize = typeof ResizeObserver === "function" && virtual ? new ResizeObserver(() => {
      if (!root.isConnected) { resize.disconnect(); return; }
      mountRows();
    }) : null;
    if (resize) resize.observe(body);
    cleanupByContainer.set(container, () => {
      if (resize) resize.disconnect();
      if (animationFrame) cancelAnimationFrame(animationFrame);
    });

    function drawTimelines() {
      timelineHead.replaceChildren(document.createTextNode(model.start ? "Activity density over time" : "Activity timing unavailable"));
      if (model.start) addTimelineTicks(timelineHead, view);
      rangeLabel.textContent = model.start
        ? `${timeLabel(view.start, view.width)} → ${timeLabel(view.finish, view.width)} · ${(model.window / view.width).toFixed(1)}×`
        : "No recorded timestamps";
      reset.disabled = !model.start || view.width >= model.window;
      back.disabled = !model.start || view.start <= 0;
      forward.disabled = !model.start || view.finish >= model.window;
      zoomOut.disabled = !model.start || view.width >= model.window;
      zoomIn.disabled = !model.start || view.width <= 1;
      end.disabled = !model.start;
      for (const { group, row, timeline } of rowViews) {
        row.classList.toggle("pipelineViewer__row--selected", group === selected);
        timeline.replaceChildren();
        const absoluteStart = model.start + view.start;
        const absoluteFinish = model.start + view.finish;
        const cells = projectActivity(group.segments, absoluteStart, absoluteFinish);
        const envelopes = group.segments.filter((segment) => segment.envelope && segment.finish >= absoluteStart && segment.start <= absoluteFinish);
        const scaleX = (value) => Math.max(0, Math.min(1000, (value - absoluteStart) * 1000 / view.width));
        if (cells.length) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.classList.add("pipelineViewer__heatmap");
          svg.setAttribute("viewBox", "0 0 1000 20");
          svg.setAttribute("preserveAspectRatio", "none");
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", `${stageTitle(group)}: ${group.timingEstimated ? "estimated stage association; " : ""}activity windows. ${durationLabel(group.elapsedSum)} total processor work.`);
          const paths = new Map();
          for (const cell of cells) {
            const intensity = cell.bucketed ? Math.min(1, cell.density / Math.max(1, model.peakDensity)) : 1;
            const level = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(intensity) * 8)));
            const x = Math.min(993.75, scaleX(cell.start));
            const measuredWidth = scaleX(cell.finish) - scaleX(cell.start);
            const width = Math.min(1000 - x, measuredWidth < 2 ? 6.25 : measuredWidth - 0.8);
            const height = 1 + 19 * intensity;
            paths.set(level, (paths.get(level) || "") + `M${x.toFixed(3)} ${(20 - height).toFixed(3)}h${width.toFixed(3)}v${height.toFixed(3)}h-${width.toFixed(3)}z`);
          }
          for (const [level, path] of paths) {
            const node = document.createElementNS(svg.namespaceURI, "path");
            node.setAttribute("d", path);
            node.setAttribute("fill", "currentColor");
            node.setAttribute("opacity", String(0.06 + level * 0.115));
            svg.appendChild(node);
          }
          if (group.timingEstimated) svg.classList.add("pipelineViewer__heatmap--estimated");
          timeline.appendChild(svg);
          timeline.onpointermove = (event) => {
            const bounds = timeline.getBoundingClientRect();
            const time = absoluteStart + (event.clientX - bounds.left) / bounds.width * view.width;
            const cell = cells.find((candidate) => time >= candidate.start && time <= candidate.finish);
            hint.textContent = cell
              ? `${stageTitle(group)}${group.timingEstimated ? " · ≈ stage match" : ""}: ${timeLabel(cell.start - model.start, view.width)} → ${timeLabel(cell.finish - model.start, view.width)} · ${cell.bucketed ? `≈ ${durationLabel(cell.workUs)} work in this display cell; activity inside the summary window is unknown.` : "Recorded intervals at the available trace resolution."}`
              : defaultHint();
          };
          timeline.onpointerleave = () => { hint.textContent = defaultHint(); };
        } else {
          timeline.onpointermove = null;
          timeline.onpointerleave = null;
        }
        for (const segment of envelopes) {
          const range = element("span", "envelope");
          const left = scaleX(segment.start) / 10;
          const width = (scaleX(segment.finish) - scaleX(segment.start)) / 10;
          range.style.left = `min(${left}%, calc(100% - 2px))`;
          range.style.width = `${width}%`;
          range.title = "First/last timestamps only. Activity and waits inside this range are unknown.";
          timeline.appendChild(range);
        }
        if (cells.length || envelopes.length) {
          let first = Infinity;
          let last = 0;
          for (const segment of [...cells, ...envelopes]) {
            first = Math.min(first, segment.start);
            last = Math.max(last, segment.finish);
          }
          const label = element("span", "timeRange", `${group.timingEstimated ? "≈ " : ""}${envelopes.length && !cells.length ? "First / last only · " : ""}${timeLabel(Math.max(0, first - model.start), view.width)} → ${timeLabel(last - model.start, view.width)}`);
          label.title = "First and last observed activity in this view; this range is not continuous work.";
          timeline.appendChild(label);
        } else {
          const untimed = element("span", "untimed");
          untimed.textContent = group.segments.length ? "Outside this time range" : "Timing unavailable";
          untimed.title = group.segments.length ? "Use Full query to see this stage's recorded activity."
            : "Processor counters exist, but no OTel span can be assigned confidently. This is not evidence of zero work.";
          timeline.appendChild(untimed);
        }
      }
    }
    mountRows(true);
    return model;
  }

  ns.pipelineViewer = { render, dispose, buildModel, operationKey, operationName, projectActivity, selectWindow };
})();
