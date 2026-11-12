// The export contains the live snapshot and the persisted history; one launch
// must count once even though those timestamps differ.
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeStartupTraces } from "../scripts/startup-trace-summary.mjs";

test("a completed launch exported twice is counted once", () => {
  const trace = {
    launchId: "launch-1",
    at: 100,
    measures: [{ name: "root-revealed", ms: 1800 }],
  };
  const summary = summarizeStartupTraces({ current: trace, traces: [trace] });
  assert.equal(summary.launches, 1);
  assert.equal(summary.rows[0].n, 1);
});

test("the post-reveal snapshot replaces the same launch", () => {
  const early = {
    launchId: "launch-1",
    at: 100,
    measures: [{ name: "root-revealed", ms: 1800 }],
  };
  const late = {
    launchId: "launch-1",
    at: 500,
    measures: [
      { name: "root-revealed", ms: 1800 },
      { name: "root-revealed→navigation-usable", ms: 90 },
    ],
  };
  const summary = summarizeStartupTraces({ traces: [early, late] });
  assert.equal(summary.launches, 1);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows.find((row) => row.name === "root-revealed").n, 1);
});

test("different launches remain separate samples", () => {
  const summary = summarizeStartupTraces({
    traces: [
      { launchId: "one", at: 1, measures: [{ name: "start", ms: 100 }] },
      { launchId: "two", at: 2, measures: [{ name: "start", ms: 200 }] },
    ],
  });
  assert.equal(summary.launches, 2);
  assert.equal(summary.rows[0].n, 2);
  assert.equal(summary.rows[0].p50, 100);
});

test("stalled launches are counted but excluded from percentiles", () => {
  const summary = summarizeStartupTraces({
    traces: [
      { launchId: "ok", at: 1, measures: [{ name: "start", ms: 100 }] },
      { launchId: "stuck", at: 2, stalled: true, measures: [{ name: "start", ms: 5 }] },
    ],
  });
  assert.equal(summary.launches, 2);
  assert.equal(summary.stalled, 1);
  assert.equal(summary.rows[0].n, 1);
  assert.equal(summary.rows[0].p50, 100);
});
