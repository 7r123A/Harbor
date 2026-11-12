#!/usr/bin/env node
// Summarizes a copied Harbor startup trace (`__harborStartup.export()`).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function latestTrace(trace, previous) {
  if (!previous) return true;
  return (trace?.at ?? 0) > (previous?.at ?? 0);
}

export function summarizeStartupTraces(data) {
  const traces = new Map();
  for (const trace of [data?.current, ...(Array.isArray(data?.traces) ? data.traces : [])]) {
    if (!trace || typeof trace !== "object") continue;
    const id =
      typeof trace.launchId === "string" && trace.launchId
        ? `launch:${trace.launchId}`
        : `at:${trace.at}`;
    const previous = traces.get(id);
    if (latestTrace(trace, previous)) traces.set(id, trace);
  }

  const order = [];
  const values = new Map();
  let stalled = 0;
  for (const trace of traces.values()) {
    if (trace.stalled === true) {
      stalled += 1;
      continue;
    }
    for (const measure of Array.isArray(trace.measures) ? trace.measures : []) {
      if (typeof measure?.name !== "string" || typeof measure?.ms !== "number") continue;
      if (!values.has(measure.name)) {
        values.set(measure.name, []);
        order.push(measure.name);
      }
      values.get(measure.name).push(measure.ms);
    }
  }

  const percentile = (sorted, p) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

  return {
    launches: traces.size,
    stalled,
    rows: order.map((name) => {
      const sorted = [...values.get(name)].sort((a, b) => a - b);
      return {
        name,
        n: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
    }),
  };
}

const isCli = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/startup-trace-summary.mjs <trace.json>");
    process.exit(2);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Could not read ${file}: ${error.message}`);
    process.exit(1);
  }

  const summary = summarizeStartupTraces(data);
  if (summary.launches === 0) {
    console.error("No startup traces found.");
    process.exit(1);
  }

  console.log(`launches\t${summary.launches}`);
  console.log(`stalled\t${summary.stalled}`);
  const longestLongTask = Math.max(
    0,
    ...(Array.isArray(data?.traces) ? data.traces : []).map(
      (trace) => trace?.longTasks?.longestMs ?? 0,
    ),
    data?.current?.longTasks?.longestMs ?? 0,
  );
  const longestPostRevealLongTask = Math.max(
    0,
    ...(Array.isArray(data?.traces) ? data.traces : []).map(
      (trace) => trace?.longTasks?.postRevealLongestMs ?? 0,
    ),
    data?.current?.longTasks?.postRevealLongestMs ?? 0,
  );
  console.log(
    `long-tasks\tlongest=${longestLongTask.toFixed(1)}\tpost-reveal-longest=${longestPostRevealLongTask.toFixed(1)}`,
  );
  if (summary.rows.length === 0) {
    console.log("No complete startup measures found.");
  }
  for (const row of summary.rows) {
    console.log(
      `${row.name}\tn=${row.n}\tp50=${row.p50.toFixed(1)}\tp95=${row.p95.toFixed(1)}\tmin=${row.min.toFixed(1)}\tmax=${row.max.toFixed(1)}`,
    );
  }
}
