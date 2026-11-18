import assert from "node:assert/strict";
import test from "node:test";

import { clearIdentityCache, identifyBatch, identityBundle } from "../src/lib/identity/index.ts";
import { setIdentityInvoker } from "../src/lib/identity/client.ts";
import { resetIdentityFlags, setIdentityFlags } from "../src/lib/identity/flags.ts";
import {
  clearIdentityShadowLog,
  identityShadowLog,
  recordIdentityShadow,
} from "../src/lib/identity/shadow.ts";

function reset(): void {
  resetIdentityFlags();
  setIdentityInvoker(null);
  clearIdentityCache();
  clearIdentityShadowLog();
}

test("identifyBatch is provisional and offline when the feature flags are off", async () => {
  reset();
  let calls = 0;
  setIdentityInvoker(async () => {
    calls += 1;
    return [];
  });

  const result = await identifyBatch(["kitsu:49847"]);

  assert.equal(calls, 0);
  assert.equal(result.get("kitsu:49847")?.provisional, true);
  assert.equal(result.get("kitsu:49847")?.entry, null);
});

test("identifyBatch resolves, caches, and falls back for unknown ids", async () => {
  reset();
  setIdentityFlags({ pack: true });
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  setIdentityInvoker(async (command, args) => {
    calls.push({ command, args });
    return [
      { id: "kitsu:49847", entry: 7, title: "Steel Ball Run", provisional: false },
      { id: "mal:14719", entry: null, title: null, provisional: true },
    ];
  });

  const first = await identifyBatch(["kitsu:49847", "mal:14719", "tt2359704"]);
  assert.equal(first.get("kitsu:49847")?.entry, 7);
  assert.equal(first.get("mal:14719")?.provisional, true);
  assert.equal(first.get("tt2359704")?.provisional, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, { ids: ["kitsu:49847", "mal:14719", "tt2359704"] });

  const second = await identifyBatch(["kitsu:49847"]);
  assert.equal(second.get("kitsu:49847")?.entry, 7);
  assert.equal(calls.length, 1, "a resolved id is served from the hot cache");
});

test("a failing identity command degrades to provisional instead of throwing", async () => {
  reset();
  setIdentityFlags({ pack: true });
  setIdentityInvoker(async () => {
    throw new Error("tauri unavailable");
  });

  const result = await identifyBatch(["kitsu:49847"]);

  assert.equal(result.get("kitsu:49847")?.provisional, true);
});

test("identityBundle is null when disabled and returns the Rust bundle when enabled", async () => {
  reset();
  assert.equal(await identityBundle("kitsu:49847"), null);

  setIdentityFlags({ pack: true });
  setIdentityInvoker(async (command, args) => {
    assert.equal(command, "identity_entry_bundle");
    assert.deepEqual(args, { key: "kitsu:49847" });
    return {
      entry: 7,
      title: "Steel Ball Run",
      mediaType: "ONA",
      episodes: 1,
      aliases: [{ scheme: "kitsu", id: "49847" }],
      related: [{ entry: 3, title: "JoJo 2012" }],
      windows: [],
    };
  });

  const bundle = await identityBundle("kitsu:49847");
  assert.equal(bundle?.entry, 7);
  assert.equal(bundle?.related[0]?.title, "JoJo 2012");
});

test("shadow observations are bounded and never mutate behavior", () => {
  reset();
  for (let i = 0; i < 120; i++) {
    recordIdentityShadow({ at: i, ids: [`kitsu:${i}`], resolved: 0, provisional: [`kitsu:${i}`] });
  }
  const log = identityShadowLog();
  assert.equal(log.length, 100);
  assert.equal(log[0]?.at, 20);
});
