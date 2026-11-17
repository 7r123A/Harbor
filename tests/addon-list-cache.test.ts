import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

// The module wires its invalidation to window events at import time.
const events = Object.assign(new EventTarget(), { location: { hostname: "app.test" } });
(globalThis as { window?: unknown }).window = events;
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
};

const addons = await import("../src/lib/addons.ts");
const catalogCache = await import("../src/lib/addon-catalog-cache.ts");
const policy = await import("../src/lib/metadata-policy.ts");

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

function mockStremioApi(status = 200) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    calls.push(url);
    const result = url.endsWith("/addonCollectionGet")
      ? {
          addons: [
            { transportUrl: "https://a.example/manifest.json", manifest: { id: "a", name: "A" } },
          ],
        }
      : { success: true };
    return new Response(JSON.stringify({ result }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const reads = (calls: string[]) => calls.filter((u) => u.endsWith("/addonCollectionGet")).length;

test("concurrent and repeated addon list reads share one request", async () => {
  addons.invalidateUserAddons();
  const api = mockStremioApi();
  try {
    const [a, b] = await Promise.all([
      addons.cachedUserAddons("key"),
      addons.cachedUserAddons("key"),
    ]);
    const c = await addons.cachedUserAddons("key");
    assert.equal(reads(api.calls), 1);
    assert.equal(a.length, 1);
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
    // Each caller gets its own array, so one caller filtering in place cannot
    // change what the next one sees.
    a.pop();
    assert.equal((await addons.cachedUserAddons("key")).length, 1);
  } finally {
    api.restore();
  }
});

test("another account key does not reuse the cached list", async () => {
  addons.invalidateUserAddons();
  const api = mockStremioApi();
  try {
    await addons.cachedUserAddons("key-1");
    await addons.cachedUserAddons("key-2");
    assert.equal(reads(api.calls), 2);
  } finally {
    api.restore();
  }
});

test("an addon change or a write makes the next read fetch again", async () => {
  addons.invalidateUserAddons();
  const api = mockStremioApi();
  try {
    await addons.cachedUserAddons("key");
    events.dispatchEvent(new Event("harbor:addons-changed"));
    await addons.cachedUserAddons("key");
    assert.equal(reads(api.calls), 2);

    await addons.setUserAddonsRaw("key", [
      { transportUrl: "https://b.example/manifest.json", manifest: { id: "b", name: "B" } },
    ]);
    await addons.cachedUserAddons("key");
    assert.equal(reads(api.calls), 3);

    await addons.setUserAddons("key", []);
    await addons.cachedUserAddons("key");
    assert.equal(reads(api.calls), 4);
  } finally {
    api.restore();
  }
});

test("a read that overlaps a write is not kept", async () => {
  addons.invalidateUserAddons();
  const api = mockStremioApi();
  try {
    const during = addons.cachedUserAddons("key");
    await addons.setUserAddonsRaw("key", [
      { transportUrl: "https://b.example/manifest.json", manifest: { id: "b", name: "B" } },
    ]);
    await during;
    await addons.cachedUserAddons("key");
    assert.equal(reads(api.calls), 2);
  } finally {
    api.restore();
  }
});

test("a failed addon list read is not remembered", async () => {
  addons.invalidateUserAddons();
  const failing = mockStremioApi(500);
  try {
    assert.deepEqual(await addons.cachedUserAddons("key"), []);
  } finally {
    failing.restore();
  }
  const api = mockStremioApi();
  try {
    assert.equal((await addons.cachedUserAddons("key")).length, 1);
    assert.equal(reads(api.calls), 1);
  } finally {
    api.restore();
  }
});

function withClock<T>(start: number, run: (advance: (ms: number) => void) => Promise<T>) {
  const original = Date.now;
  let now = start;
  Date.now = () => now;
  return run((ms) => (now += ms)).finally(() => (Date.now = original));
}

test("a catalog row past its TTL is served at once and refreshed in the background", () =>
  withClock(1_000_000, async (advance) => {
    let loads = 0;
    const load = async () => ({ value: `v${++loads}`, ok: true });
    assert.equal((await catalogCache.cachedCatalogRow("swr", load)).value, "v1");

    advance(11 * 60 * 1000);
    assert.equal((await catalogCache.cachedCatalogRow("swr", load)).value, "v1");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(loads, 2);
    assert.equal((await catalogCache.cachedCatalogRow("swr", load)).value, "v2");

    // Far past the stale window the caller waits for fresh data again.
    advance(2 * 60 * 60 * 1000);
    assert.equal((await catalogCache.cachedCatalogRow("swr", load)).value, "v3");
  }));

test("a failed background refresh keeps the last good catalog row", () =>
  withClock(5_000_000, async (advance) => {
    let ok = true;
    const load = async () => ({ value: ok ? "good" : null, ok });
    await catalogCache.cachedCatalogRow("keep", load);
    ok = false;
    advance(11 * 60 * 1000);
    assert.equal((await catalogCache.cachedCatalogRow("keep", load)).value, "good");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((await catalogCache.cachedCatalogRow("keep", load)).value, "good");
  }));

test("a failed background refresh backs off before the next one", () =>
  withClock(7_000_000, async (advance) => {
    let ok = true;
    let loads = 0;
    const load = async () => (++loads, { value: ok ? "good" : null, ok });
    await catalogCache.cachedCatalogRow("backoff", load);
    ok = false;
    advance(11 * 60 * 1000);
    await catalogCache.cachedCatalogRow("backoff", load);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(loads, 2);

    // Within the backoff the stale row is served without another request.
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await catalogCache.cachedCatalogRow("backoff", load)).value, "good");
    }
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(loads, 2);

    advance(16 * 1000);
    ok = true;
    assert.equal((await catalogCache.cachedCatalogRow("backoff", load)).value, "good");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(loads, 3);
    assert.equal((await catalogCache.cachedCatalogRow("backoff", load)).value, "good");
  }));

test("background refreshes of stale rows run at most six at a time", () =>
  withClock(8_000_000, async (advance) => {
    const keys = Array.from({ length: 10 }, (_, i) => `bounded-${i}`);
    for (const key of keys)
      await catalogCache.cachedCatalogRow(key, async () => ({ value: 0, ok: true }));
    advance(11 * 60 * 1000);

    let active = 0;
    let peak = 0;
    let started = 0;
    const gates: (() => void)[] = [];
    const load = () => {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<{ value: number; ok: boolean }>((resolve) =>
        gates.push(() => {
          active -= 1;
          resolve({ value: 1, ok: true });
        }),
      );
    };
    for (const key of keys) {
      // The stale value still comes back at once.
      assert.equal((await catalogCache.cachedCatalogRow(key, load)).value, 0);
    }
    assert.equal(started, 6);
    while (gates.length > 0) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    assert.equal(started, 10);
    assert.equal(peak, 6);
  }));

test("a queued catalog refresh sends the language its cache key was built with", () =>
  withClock(10_000_000, async (advance) => {
    store.set("harbor.settings", JSON.stringify({ region: "US", tmdbLanguage: "en" }));
    const original = globalThis.fetch;
    const languages: (string | null)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes("/catalog/")) {
        languages.push(new Headers(init?.headers).get("Accept-Language"));
      }
      return new Response(JSON.stringify({ metas: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const addon = {
        transportUrl: "https://lang.example/manifest.json",
        manifest: { id: "lang", name: "Lang" },
      } as unknown as Parameters<typeof addons.fetchCatalogRow>[0];
      const cat = { id: "top", type: "movie", name: "Top" };
      const blockers = Array.from({ length: 6 }, (_, i) => `lang-blocker-${i}`);
      for (const key of blockers) {
        await catalogCache.cachedCatalogRow(key, async () => ({ value: 0, ok: true }));
      }
      await addons.fetchCatalogRow(addon, cat);
      advance(11 * 60 * 1000);

      // Six stale refreshes fill the background lanes, so the next one waits.
      const gates: (() => void)[] = [];
      const hang = () =>
        new Promise<{ value: number; ok: boolean }>((resolve) =>
          gates.push(() => resolve({ value: 1, ok: true })),
        );
      for (const key of blockers) await catalogCache.cachedCatalogRow(key, hang);
      await addons.fetchCatalogRow(addon, cat);
      store.set("harbor.settings", JSON.stringify({ region: "FR", tmdbLanguage: "fr" }));
      while (gates.length > 0) {
        gates.shift()?.();
        await new Promise((r) => setTimeout(r, 0));
      }
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(languages, ["en-US,en;q=0.8", "en-US,en;q=0.8"]);
    } finally {
      globalThis.fetch = original;
      store.delete("harbor.settings");
    }
  }));

test("a failed catalog row is retried after its short backoff, never served stale", () =>
  withClock(9_000_000, async (advance) => {
    let loads = 0;
    const load = async () => ({ value: null, ok: false, n: ++loads });
    await catalogCache.cachedCatalogRow("fail", load);
    await catalogCache.cachedCatalogRow("fail", load);
    assert.equal(loads, 1);
    advance(16 * 1000);
    await catalogCache.cachedCatalogRow("fail", load);
    assert.equal(loads, 2);
  }));

test("the most used catalog rows survive eviction", async () => {
  let loads = 0;
  const load = async () => ({ value: ++loads, ok: true });
  await catalogCache.cachedCatalogRow("hot", load);
  for (let i = 0; i < 79; i += 1) {
    await catalogCache.cachedCatalogRow(`cold-${i}`, load);
    // Reading the hot row keeps it at the recent end.
    await catalogCache.cachedCatalogRow("hot", load);
  }
  await catalogCache.cachedCatalogRow("one-more", load);
  const before = loads;
  await catalogCache.cachedCatalogRow("hot", load);
  assert.equal(loads, before);
});

test("settings flags follow every change to the stored settings", () => {
  store.delete("harbor.settings");
  assert.equal(policy.addonOnlyMetadata(), false);
  assert.equal(policy.useTmdbTopMatch(), true);
  store.set("harbor.settings", JSON.stringify({ addonOnlyMetadata: true }));
  assert.equal(policy.addonOnlyMetadata(), true);
  store.set(
    "harbor.settings",
    JSON.stringify({ addonOnlyMetadata: false, searchTmdbTopMatch: false }),
  );
  assert.equal(policy.addonOnlyMetadata(), false);
  assert.equal(policy.useTmdbTopMatch(), false);
  store.set("harbor.settings", "{not json");
  assert.equal(policy.addonOnlyMetadata(), false);
  assert.equal(policy.useTmdbTopMatch(), true);
  store.set("harbor.settings", "null");
  assert.equal(policy.addonOnlyMetadata(), false);
});
