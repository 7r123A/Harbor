import { lruGet, lruSet } from "@/lib/cache";
import { registerEvictable } from "@/lib/maintenance";

// Every catalog of every installed addon is swept by the home page AND by the
// anime page, both on mount, with the anime page then discarding everything that
// is not anime. On a loaded profile that is the great majority of the bridge
// crossings a cold boot pays, and tab hopping paid it again every single time.
// One short-lived memory cache in front of the row fetch, shared by all callers,
// plus in-flight dedupe so two surfaces mounting at once ask once.
const TTL_MS = 10 * 60 * 1000;
// A good row past its TTL is still returned at once for this long while a
// background refresh replaces it, so returning to a tab never waits on every
// addon again. Failed rows are never served stale.
const STALE_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 15 * 1000;
const MAX_ENTRIES = 80;

export type CatalogLoad<T> = { value: T; ok: boolean };

// `retryAt` is set when a background refresh of a good row fails, so the stale
// row keeps its own deadline while refreshes back off like a failed row would.
type Entry<T> = { v: CatalogLoad<T>; t: number; ttl: number; retryAt?: number };

const rows = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<CatalogLoad<unknown>>>();

registerEvictable("addon-catalog-rows", (aggressive) => {
  if (aggressive) return rows.clear();
  const now = Date.now();
  for (const [k, e] of rows) if (now - e.t > staleLimit(e)) rows.delete(k);
});

function staleLimit(e: Entry<unknown>): number {
  return e.v.ok ? e.ttl + STALE_MS : e.ttl;
}

function refresh<T>(key: string, load: () => Promise<CatalogLoad<T>>): Promise<CatalogLoad<T>> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<CatalogLoad<T>>;
  const p = (async () => {
    try {
      const v = await load();
      const prev = rows.get(key);
      // A failed background refresh keeps the last good row while it may still be served.
      if (!v.ok && prev?.v.ok && Date.now() - prev.t < staleLimit(prev)) {
        prev.retryAt = Date.now() + FAIL_TTL_MS;
        return prev.v as CatalogLoad<T>;
      }
      lruSet(rows, key, { v, t: Date.now(), ttl: v.ok ? TTL_MS : FAIL_TTL_MS }, MAX_ENTRIES);
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// A stale hit resolves at once, so the caller's lanes move on without waiting for
// its refresh. Background refreshes get their own bound, matching the six catalog
// lanes, so a sweep over many stale rows cannot fire one request per row at once.
const BACKGROUND_LANES = 6;
let backgroundActive = 0;
const backgroundQueue: (() => void)[] = [];
const backgroundKeys = new Set<string>();

function pumpBackground(): void {
  while (backgroundActive < BACKGROUND_LANES && backgroundQueue.length > 0) {
    backgroundQueue.shift()?.();
  }
}

function refreshInBackground<T>(key: string, load: () => Promise<CatalogLoad<T>>): void {
  if (inflight.has(key) || backgroundKeys.has(key)) return;
  backgroundKeys.add(key);
  backgroundQueue.push(() => {
    const current = rows.get(key);
    // A foreground load may have refreshed the row while this one waited.
    if (current && Date.now() - current.t < current.ttl) {
      backgroundKeys.delete(key);
      return;
    }
    backgroundActive += 1;
    void refresh(key, load)
      .catch(() => {})
      .finally(() => {
        backgroundKeys.delete(key);
        backgroundActive -= 1;
        pumpBackground();
      });
  });
  pumpBackground();
}

export function cachedCatalogRow<T>(
  key: string,
  load: () => Promise<CatalogLoad<T>>,
): Promise<CatalogLoad<T>> {
  const hit = lruGet(rows, key) as Entry<T> | undefined;
  if (hit) {
    const age = Date.now() - hit.t;
    if (age < hit.ttl) return Promise.resolve(hit.v);
    if (age < staleLimit(hit)) {
      if (hit.retryAt === undefined || Date.now() >= hit.retryAt) {
        refreshInBackground(key, load);
      }
      return Promise.resolve(hit.v);
    }
  }
  return refresh(key, load);
}
