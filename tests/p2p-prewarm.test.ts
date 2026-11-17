// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

// The prewarm helper reads the same browser globals as the engine callers.
(globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: {} };
(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null };

const prewarm = await import("../src/lib/streams/p2p-prewarm.ts");

type Added = { info_hash: string; stream_base: string; already_managed: boolean; files: [] };
type Fake = {
  calls: Array<{ magnet: string; trackers: string[]; fileIdx?: number }>;
  abandoned: string[];
  settle?: (added: Added) => void;
  add: (magnet: string, trackers: string[], fileIdx?: number) => Promise<Added>;
};

const HASH = "0123456789abcdef0123456789abcdef01234567";

function target(overrides: Record<string, unknown> = {}) {
  return { infoHash: HASH, sources: [], fileIdx: 2, ...overrides } as never;
}

function fakeDeps(options: { manual?: boolean } = {}): Fake {
  const calls: Fake["calls"] = [];
  const abandoned: string[] = [];
  const fake: Fake = {
    calls,
    abandoned,
    add: (magnet, trackers, fileIdx) => {
      calls.push({ magnet, trackers, fileIdx });
      if (!options.manual) {
        return Promise.resolve({
          info_hash: HASH,
          stream_base: "http://127.0.0.1:1/stream",
          already_managed: false,
          files: [],
        });
      }
      return new Promise<Added>((resolve) => {
        fake.settle = resolve;
      });
    },
  };
  return fake;
}

function install(fake: Fake) {
  prewarm.__resetPrewarmForTest();
  prewarm.__setPrewarmDepsForTest({ add: fake.add, abandon: (hash) => fake.abandoned.push(hash) });
  return fake;
}

test("prewarms a source once and shares the in-flight add", async () => {
  const fake = install(fakeDeps({ manual: true }));
  const first = prewarm.prewarmP2pStream(target());
  const second = prewarm.prewarmP2pStream(target());
  assert.equal(first, second, "the second call must reuse the pending add");
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0]!.magnet, /^magnet:\?xt=urn:btih:/);
  assert.equal(fake.calls[0]!.fileIdx, 2);
  fake.settle!({
    info_hash: HASH,
    stream_base: "http://127.0.0.1:1/stream",
    already_managed: false,
    files: [],
  });
  await first;
  assert.equal(fake.calls.length, 1);
});

test("a successful prewarm is abandoned on request", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target());
  prewarm.abandonPrewarmedStream(target());
  assert.deepEqual(fake.abandoned, [HASH]);
});

test("abandoning while the add is in flight waits for it to exist", async () => {
  const fake = install(fakeDeps({ manual: true }));
  const pending = prewarm.prewarmP2pStream(target());
  prewarm.abandonPrewarmedStream(target());
  assert.deepEqual(fake.abandoned, [], "nothing to abandon before the add resolves");
  fake.settle!({
    info_hash: HASH,
    stream_base: "http://127.0.0.1:1/stream",
    already_managed: false,
    files: [],
  });
  await pending;
  await Promise.resolve();
  assert.deepEqual(fake.abandoned, [HASH]);
});

test("recent prewarms are not repeated for the same infohash", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target());
  assert.equal(prewarm.prewarmP2pStream(target()), null);
  assert.equal(fake.calls.length, 1);
});

test("non-P2P sources are ignored", () => {
  const fake = install(fakeDeps());
  assert.equal(prewarm.prewarmP2pStream(target({ url: "https://example.test/a.mkv" })), null);
  assert.equal(prewarm.prewarmP2pStream(target({ infoHash: null })), null);
  assert.equal(fake.calls.length, 0);
});

test("the abandon timer removes a prewarm nobody played", async () => {
  const fake = install(fakeDeps());
  await prewarm.prewarmP2pStream(target(), { abandonAfterMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fake.abandoned, [HASH]);
});
