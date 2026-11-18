import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const SHARED_KEY = "harbor.resume";
const PRIVATE_PREFIX = "harbor.resume.private.v1.";

function harness(opts: { privateId?: string | null; activeId?: string; nuvio?: boolean } = {}) {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  const activeId = opts.activeId ?? "a";
  data.set(
    "harbor.profiles.v1",
    JSON.stringify({ profiles: [{ id: activeId, isPrimary: true }], activeId }),
  );
  const full = resolve("src/lib/resume.ts");
  const compiled = ts.transpileModule(readFileSync(full, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", "localStorage", compiled)(
    (name: string) => {
      if (name === "./cw-profile") {
        return {
          privateCwProfileId: () => (opts.privateId === undefined ? null : opts.privateId),
        };
      }
      if (name === "./active-profile-id") {
        return {
          isNuvioProviderActive: () => opts.nuvio ?? false,
          getNuvioActiveSlot: () => 1,
        };
      }
      throw new Error(`Unexpected dependency ${name}`);
    },
    exports,
    storage,
  );
  return { data, api: exports as any };
}

function seed(h: ReturnType<typeof harness>, shared: unknown, priv?: unknown): void {
  h.data.set(SHARED_KEY, JSON.stringify(shared));
  if (priv !== undefined) h.data.set(PRIVATE_PREFIX + "a", JSON.stringify(priv));
}

test("the newest resume entry wins and keeps its source", () => {
  const h = harness();
  seed(
    h,
    { "tt1|s1e1": { ms: 100, t: 2_000, source: "simkl" } },
    { "tt1|s1e1": { ms: 900, t: 1_000 } },
  );

  const entry = h.api.readResumeEntry("tt1", 1, 1);
  assert.equal(entry?.ms, 100);
  assert.equal(entry?.t, 2_000);
  assert.equal(entry?.source, "simkl");
  assert.equal(h.api.readResumeMs("tt1", 1, 1), 100);
  assert.equal(h.api.readResumeSource("tt1", 1, 1), "simkl");
});

test("a newer private entry wins over a shared import", () => {
  const h = harness();
  seed(
    h,
    { "tt2|s1e2": { ms: 100, t: 1_000, source: "trakt" } },
    { "tt2|s1e2": { ms: 900, t: 3_000 } },
  );

  const entry = h.api.readResumeEntry("tt2", 1, 2);
  assert.equal(entry?.ms, 900);
  assert.equal(entry?.t, 3_000);
  assert.equal(entry?.source, undefined);
});

test("a private profile keeps the private-only view", () => {
  const h = harness({ privateId: "a" });
  seed(
    h,
    { "tt3|s1e3": { ms: 5_000, t: 9_000, source: "simkl" } },
    { "tt3|s1e3": { ms: 1, t: 1 } },
  );

  assert.equal(h.api.readResumeEntry("tt3", 1, 3)?.ms, 1);
});

test("lastPlayedEpisode and createResumeReader use the merged view", () => {
  const h = harness();
  seed(
    h,
    {
      "tt4|s1e1": { ms: 10, t: 1_000 },
      "tt4|s1e2": { ms: 20, t: 2_000 },
    },
    { "tt4|s1e3": { ms: 30, t: 3_000 } },
  );

  assert.equal(h.api.lastPlayedEpisode("tt4")?.episode, 3);
  const reader = h.api.createResumeReader();
  assert.equal(reader("tt4", 1, 1)?.ms, 10);
  assert.equal(reader("tt4", 1, 3)?.ms, 30);
});
