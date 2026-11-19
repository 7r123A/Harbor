import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, flushPromises } from "./helpers/hook-harness.ts";

test("PublicMetaDB Stage 2 pauses to the verified TMDB episode, not the parent MAL entry", async () => {
  const saves: any[] = [];
  let inferred = 0;
  let position = 320;
  const handlers = new Map<string, () => void>();
  const hook = hookHarness(
    "src/lib/publicmetadb/scrobble-hook.ts",
    "usePublicMetaDbScrobble",
    {
      "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
      "@/lib/settings": {
        useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }),
      },
      "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
      "./ids": {
        resolvePmdbEpisodeTarget: async () => {
          inferred++;
          return { id_type: "mal", id_value: "14719", media_type: "tv", season: 6, episode: 1 };
        },
        resolvePmdbTarget: async () => null,
      },
      "./scrobble": {
        pmdbSaveResume: async (target: any, pos: number) => {
          saves.push({ target, pos });
          return { action: "saved" };
        },
        pmdbDeleteResumeForTarget: async () => true,
      },
      "./pending-sync": {
        recordPendingResume: () => {},
        syncPendingResume: async (_t: any, _p: number, _d: number, writer: () => Promise<boolean>) => writer(),
      },
      "./history": { markPmdbWatched: async () => true },
    },
    {
      Date: { now: () => 200_000 },
      window: {
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout: () => 2,
        clearTimeout: () => {},
        addEventListener: (name: string, cb: () => void) => handlers.set(name, cb),
        removeEventListener: (name: string) => handlers.delete(name),
      },
    },
  );
  const src = {
    meta: { id: "mal:14719", name: "JoJo", type: "series" },
    episode: { season: 6, episode: 1, kitsuStreamId: "kitsu:49847:1" },
  };
  const snap = { status: "playing", positionSec: position, durationSec: 1000 };
  const verifiedTarget = {
    tmdb_id: 45790, media_type: "tv", season: 6, episode: 1,
  };
  const proof = {
    work: { entryId: "kitsu:49847", entryEpisode: 1 },
    episode: { ...src.episode, sourceMetaId: "kitsu:49847" },
    pmdbTarget: verifiedTarget,
    traktTarget: null,
  };
  hook.render({ src, snap, liveScrobble: { phase: "ready", proof } });
  await flushPromises();
  hook.render({ src, snap: { ...snap, status: "paused" },
    liveScrobble: { phase: "ready", proof } });
  await flushPromises();
  assert.equal(inferred, 0, "do not resolve a different MAL episode when exact TMDB proof exists");
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].target, verifiedTarget);
  assert.equal(saves[0].pos, 320_000);
  position = 0;
  hook.unmount();
});

test("PMDB does not write while shared anime identity is still resolving", async () => {
  const hook = hookHarness(
    "src/lib/publicmetadb/scrobble-hook.ts",
    "usePublicMetaDbScrobble",
    {
      "@/lib/player/playback-clock": { getPlaybackPosition: () => 300 },
      "@/lib/settings": { useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }) },
      "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
      "./ids": { resolvePmdbEpisodeTarget: async () => null, resolvePmdbTarget: async () => null },
      "./scrobble": { pmdbSaveResume: async () => { throw Error("must not write"); }, pmdbDeleteResumeForTarget: async () => false },
      "./pending-sync": { syncPendingResume: async () => { throw Error("must not sync"); }, recordPendingResume: () => {} },
      "./history": { markPmdbWatched: async () => false },
    },
    {
      Date: { now: () => 200_000 },
      window: {
        setInterval: () => 1, clearInterval: () => {},
        setTimeout: () => 2, clearTimeout: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
      },
    },
  );
  hook.render({
    src: {
      meta: { id: "mal:14719", type: "series" },
      episode: { season: 6, episode: 1 },
    },
    snap: { status: "paused", positionSec: 300, durationSec: 1000 },
    liveScrobble: { phase: "resolving", proof: null },
  });
  await flushPromises();
  hook.unmount();
});
