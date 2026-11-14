import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import "./_localstorage-stub.ts";
import {
  recordAnimeCwId,
  recordAnimePlayId,
  recordAnilistMalAlias,
} from "../src/lib/anime-cw-ids.ts";
import { cwAnimeIdentityKey, dedupeAnimeCw } from "../src/lib/cw-anime-identity.ts";

test("native MAL aliases share an entry while catalog mappings need checkpoint proof", () => {
  recordAnimeCwId("mal:31646", "kitsu:11380");
  recordAnimeCwId("tt6074794", "kitsu:11380");
  assert.equal(cwAnimeIdentityKey("mal:31646"), "kitsu:11380");
  assert.equal(cwAnimeIdentityKey("tt6074794"), null);
  assert.deepEqual(
    dedupeAnimeCw([
      { _id: "mal:31646", name: "March Comes in Like a Lion", episode: 10 },
      { _id: "tt6074794", name: "3-gatsu no Lion meets BUMP OF CHICKEN", episode: 10 },
    ]).map((row) => row._id),
    ["mal:31646", "tt6074794"],
  );
});

test("distinct anime entries and the music special are never merged by shared IMDb or TVDB IDs", () => {
  recordAnimeCwId("mal:35180", "kitsu:13401");
  recordAnimeCwId("mal:28789", "kitsu:10063");
  assert.deepEqual(
    dedupeAnimeCw([{ _id: "kitsu:11380" }, { _id: "mal:35180" }, { _id: "mal:28789" }]).map(
      (row) => row._id,
    ),
    ["kitsu:11380", "mal:35180", "mal:28789"],
  );
});

test("unknown aliases are left untouched, and the newest already-sorted entry wins", () => {
  assert.equal(cwAnimeIdentityKey("tt9999999"), null);
  assert.deepEqual(
    dedupeAnimeCw([
      { id: "tt9999999" },
      { id: "mal:9999999" },
      { id: "tt6074794" },
      { id: "mal:31646" },
    ]).map((row) => row.id),
    ["tt9999999", "mal:9999999", "tt6074794", "mal:31646"],
  );
});

test("a recorded played sequel takes precedence over the catalog series alias", () => {
  recordAnimePlayId("tt6074794", "mal:35180");
  assert.equal(cwAnimeIdentityKey("tt6074794"), null);
  assert.equal(cwAnimeIdentityKey("mal:31646"), "kitsu:11380");
});

test("a saved Kitsu stream ID identifies its cour without any new mapping lookup", () => {
  recordAnimePlayId("tt6074794", "mal:31646");
  assert.equal(cwAnimeIdentityKey("mal:9999997", "kitsu:11380:10"), "kitsu:11380");
  assert.deepEqual(
    dedupeAnimeCw([
      { _id: "tt6074794", state: { video_id: "tt6074794:1:10" } },
      { _id: "mal:9999997", state: { video_id: "kitsu:11380:10" } },
    ]).map((item) => item._id),
    ["tt6074794", "mal:9999997"],
  );
});

test("saved Kitsu stream takes precedence over an advanced Kitsu card ID", () => {
  assert.equal(cwAnimeIdentityKey("kitsu:999", "kitsu:11380:10"), "kitsu:11380");
});

test("Magic Repo Man AniList/MAL duplicates collapse without AniZip Kitsu metadata", () => {
  recordAnilistMalAlias(202250, 62922);
  assert.equal(cwAnimeIdentityKey("anilist:202250"), "mal:62922");
  assert.deepEqual(
    dedupeAnimeCw([
      { _id: "mal:62922", name: "Magic Repo Man" },
      { _id: "anilist:202250", name: "Kashita Maryoku wa Revo Barai" },
    ]).map((v) => v._id),
    ["mal:62922"],
  );
});

test("unrelated AniList entries are never merged when their MAL identity is unknown", () => {
  assert.equal(cwAnimeIdentityKey("anilist:204650"), null);
  assert.deepEqual(
    dedupeAnimeCw([{ _id: "anilist:204650" }, { _id: "mal:62922" }]).map((v) => v._id),
    ["anilist:204650", "mal:62922"],
  );
});

test("AniList/MAL aliases stay unified after normal detail hydration supplies Kitsu", () => {
  recordAnilistMalAlias(202250, 62922);
  recordAnimeCwId("mal:62922", "kitsu:50993");
  assert.equal(cwAnimeIdentityKey("anilist:202250"), "kitsu:50993");
  assert.deepEqual(
    dedupeAnimeCw([{ _id: "mal:62922" }, { _id: "anilist:202250" }]).map((v) => v._id),
    ["mal:62922"],
  );
});

const PROOF_META = {
  id: "kitsu:49444",
  type: "series",
  name: "BLEACH: Thousand-Year Blood War",
  videos: [
    {
      id: "kitsu:49444:11",
      title: "GOD OF THUNDER",
      season: 1,
      episode: 11,
      imdb_id: "tt111",
      imdbSeason: 4,
      imdbEpisode: 11,
    },
  ],
};

function loadIdentityHarness(
  onNotify: () => void = () => {},
  overrides: Record<string, unknown> = {},
) {
  const mocks: Record<string, unknown> = {
    "@/lib/anime-cw-ids": {
      getAnimeCwId: () => null,
      getAnimeCanonicalId: () => null,
      getAnilistMalAlias: () => null,
      recordAnimeCwId: () => {},
      notifyAnimeCwIds: onNotify,
    },
    "@/lib/anime-identity-db": {
      animeDbReadEntry: async () => null,
      animeDbReadProvider: async () => null,
      animeDbWriteProvider: async () => {},
    },
    "@/lib/providers/anime-entry": { resolveAnimeEntry: async () => null },
    "@/lib/providers/anime-kitsu-addon": { animeKitsuMeta: async () => PROOF_META },
    "@/lib/anime-tracker-entry": {
      resolveTrackerAnimeEntry: async () => ({ id: "kitsu:49444" }),
    },
    "@/lib/providers/tmdb/tmdb-imdb-resolve": {
      tmdbImdbCached: () => null,
      tmdbImdbId: async () => "tt111",
    },
    "@/lib/publicmetadb/mappings": { getImdbForTmdb: async () => null },
    ...overrides,
  };
  const source = readFileSync(new URL("../src/lib/cw-anime-identity.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)(
    (name: string) => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
  );
  return module.exports as typeof import("../src/lib/cw-anime-identity.ts");
}

function catalogProofItem(id: string, extra: { altIds?: string[]; imdbId?: string } = {}) {
  return {
    _id: id,
    type: "series",
    name: "Bleach",
    state: {
      season: 4,
      episode: 11,
      video_id: `${id}:4:11`,
      ...(extra.imdbId ? { imdb_id: extra.imdbId } : {}),
    },
    ...(extra.altIds ? { altIds: extra.altIds } : {}),
  };
}

test("a catalog proof keyed by an alt IMDb id resolves the exact cour", async () => {
  const identity = loadIdentityHarness();
  const item = catalogProofItem("tmdb:tv:900", { altIds: ["tt111"] });

  await identity.warmCwAnimeIdentities([item]);

  assert.equal(identity.provenCwAnimeIdentity(item), "kitsu:49444");
});

test("a catalog proof keyed by state.imdb_id resolves the exact cour", async () => {
  const identity = loadIdentityHarness();
  const item = catalogProofItem("tmdb:tv:901", { imdbId: "tt111" });

  await identity.warmCwAnimeIdentities([item]);

  assert.equal(identity.provenCwAnimeIdentity(item), "kitsu:49444");
});

test("a catalog proof resolves through the cached asynchronous TMDB to IMDb mapping", async () => {
  const identity = loadIdentityHarness();
  const item = catalogProofItem("tmdb:tv:902");

  await identity.warmCwAnimeIdentities([item], { tmdbKey: "fixture" });

  // The item carries neither an IMDb id nor an alias; the proof can only exist
  // because the asynchronous mapping was recorded and reused.
  assert.equal(identity.provenCwAnimeIdentity(item), "kitsu:49444");
});

test("overlapping warming calls coalesce into one notification", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let notifications = 0;
  const identity = loadIdentityHarness(() => {
    notifications += 1;
  });

  await Promise.all([
    identity.warmCwAnimeIdentities([catalogProofItem("tmdb:tv:904", { altIds: ["tt111"] })]),
    identity.warmCwAnimeIdentities([catalogProofItem("tmdb:tv:905", { altIds: ["tt111"] })]),
  ]);
  assert.equal(notifications, 0);
  t.mock.timers.tick(200);
  assert.equal(notifications, 1);
});

test("rewarming an unchanged identity does not notify again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let notifications = 0;
  const identity = loadIdentityHarness(() => {
    notifications += 1;
  });
  const item = catalogProofItem("tmdb:tv:907", { altIds: ["tt111"] });

  await identity.warmCwAnimeIdentities([item]);
  t.mock.timers.tick(200);
  const afterFirst = notifications;
  assert.equal(afterFirst, 1);

  await identity.warmCwAnimeIdentities([item]);
  t.mock.timers.tick(200);
  assert.equal(notifications, afterFirst);
});

test("a native identity notifies once and not again after the cache expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let notifications = 0;
  const aliases = new Map<string, string>();
  const identity = loadIdentityHarness(undefined, {
    "@/lib/anime-cw-ids": {
      getAnimeCwId: (id: string) => aliases.get(id) ?? null,
      getAnimeCanonicalId: () => null,
      getAnilistMalAlias: () => null,
      recordAnimeCwId: (id: string, canonical: string) => {
        aliases.set(id, canonical);
      },
      notifyAnimeCwIds: () => {
        notifications += 1;
      },
    },
    "@/lib/providers/anime-entry": { resolveAnimeEntry: async () => ({ kitsuId: 333 }) },
  });
  const item = {
    _id: "mal:222",
    type: "series",
    name: "Native row",
    state: { season: 1, episode: 1, video_id: "mal:222:1:1" },
  };

  await identity.warmCwAnimeIdentities([item]);
  t.mock.timers.tick(200);
  // First discovery changes the alias map once.
  assert.equal(notifications, 1);
  assert.equal(aliases.get("mal:222"), "kitsu:333");

  // Let the warm cache expire, then resolve the same canonical identity again.
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await identity.warmCwAnimeIdentities([item]);
  t.mock.timers.tick(200);
  assert.equal(notifications, 1);
});

test("warm identity key includes proof metadata and nested members", () => {
  const identity = loadIdentityHarness();
  const base = catalogProofItem("tmdb:tv:906", { altIds: ["tt111"] });
  const withAlt = { ...base, altIds: ["tt111", "tt222"] };
  const withImdb = { ...base, state: { ...base.state, imdb_id: "tt333" } };
  const withMember = {
    ...base,
    cwMembers: [{ _id: "tt444", type: "series", state: { video_id: "tt444:1:1" } }],
  };

  assert.notEqual(identity.cwWarmIdentityKey(base), identity.cwWarmIdentityKey(withAlt));
  assert.notEqual(identity.cwWarmIdentityKey(base), identity.cwWarmIdentityKey(withImdb));
  assert.notEqual(identity.cwWarmIdentityKey(base), identity.cwWarmIdentityKey(withMember));
});

test("an unwarmed catalog row has no proof", () => {
  const identity = loadIdentityHarness();
  const item = catalogProofItem("tmdb:tv:903", { altIds: ["tt111"] });

  assert.equal(identity.provenCwAnimeIdentity(item), null);
});

for (const localIsNewer of [true, false]) {
  test(`verified anime merge keeps ${localIsNewer ? "newer local rewatch" : "newer Simkl completion"} regardless of input order`, () => {
    recordAnimeCwId("mal:2001", "kitsu:1801");
    const older = "2026-11-13T10:00:00Z";
    const newer = "2026-11-14T10:00:00Z";
    const local = {
      _id: "kitsu:1801",
      type: "series",
      local: true,
      state: {
        season: 1,
        episode: 5,
        timeOffset: 94574,
        duration: 1462802,
        lastWatched: localIsNewer ? newer : older,
      },
    };
    const remote = {
      _id: "mal:2001",
      type: "series",
      external: "simkl",
      _mtime: "2026-11-15T10:00:00Z",
      state: {
        season: 1,
        episode: 14,
        timeOffset: 0,
        duration: 0,
        flaggedWatched: 1,
        lastWatched: localIsNewer ? older : newer,
      },
    };
    for (const rows of [
      [remote, local],
      [local, remote],
    ]) {
      const [winner] = dedupeAnimeCw(rows);
      assert.equal(winner._id, localIsNewer ? local._id : remote._id);
      assert.equal(winner.state.episode, localIsNewer ? 5 : 14);
      assert.equal(winner.state.timeOffset, localIsNewer ? 94574 : 0);
      assert.equal(winner.cwMembers?.length, 2);
      assert.ok(winner.cwMembers?.includes(local));
      assert.ok(winner.cwMembers?.includes(remote));
    }
  });
}

test("anime ranking preserves input order when playback timestamps are missing, invalid, or equal", () => {
  recordAnimeCwId("mal:2001", "kitsu:1801");
  for (const timestamp of [undefined, "invalid", "1970-01-01T00:00:00Z", "2026-11-14T10:00:00Z"]) {
    const first = { _id: "mal:2001", state: { lastWatched: timestamp } };
    const second = { _id: "kitsu:1801", state: { lastWatched: "2026-11-14T10:00:00Z" } };
    assert.equal(dedupeAnimeCw([first, second])[0]._id, first._id);
  }
});
