import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function load(path, mocks = {}) {
  const code = ts.transpileModule(read(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((id) => mocks[id] ?? {}, exports);
  return exports;
}

const local = (id, imdbId) => ({ id, imdbId, type: "movie", name: "Fixture", addedAt: 1 });

test("watched local entries are filtered from Watchlist but remain in the merged data", () => {
  const view = load("src/lib/watchlist-watched.ts", {
    "./movie-watched": {
      isMovieWatchedLocal: (id, altIds) => id === "tmdb:movie:1" || (altIds ?? []).includes("tt1"),
    },
    "./watched-flag": { isWatchedFlagged: () => false },
  });

  const entry = local("tmdb:movie:1", "tt1");
  const card = {
    meta: { id: "tmdb:movie:1", type: "movie" },
    localId: "tmdb:movie:1",
  };

  assert.equal(view.isMergedWatchlistCardWatched(card, [entry], new Set()), true);
});

test("watched Stremio ids filter a local card merged under another id form", () => {
  const view = load("src/lib/watchlist-watched.ts", {
    "./movie-watched": { isMovieWatchedLocal: () => false },
    "./watched-flag": { isWatchedFlagged: () => false },
  });

  const entry = local("tmdb:movie:2", "tt2");
  const card = {
    meta: { id: "tmdb:movie:2", type: "movie" },
    localId: "tmdb:movie:2",
    stremioId: "tt2",
  };

  assert.equal(view.isMergedWatchlistCardWatched(card, [entry], new Set(["tt2"])), true);
});

test("unwatched cards stay visible", () => {
  const view = load("src/lib/watchlist-watched.ts", {
    "./movie-watched": { isMovieWatchedLocal: () => false },
    "./watched-flag": { isWatchedFlagged: () => false },
  });

  assert.equal(
    view.isMergedWatchlistCardWatched(
      { meta: { id: "tt3", type: "movie" }, stremioId: "tt3" },
      [],
      new Set(),
    ),
    false,
  );
});

test("series watched flags are honoured", () => {
  const view = load("src/lib/watchlist-watched.ts", {
    "./movie-watched": { isMovieWatchedLocal: () => false },
    "./watched-flag": { isWatchedFlagged: (id) => id === "tt4" },
  });

  assert.equal(
    view.isMergedWatchlistCardWatched(
      { meta: { id: "tt4", type: "series" }, stremioId: "tt4" },
      [],
      new Set(),
    ),
    true,
  );
});

function simklFixture(state) {
  const calls = [];
  const watchlist = load("src/lib/simkl/watchlist.ts", {
    "./activities/gate": { currentActivitiesAll: async () => null },
    "./client": {
      simklRequest: async (path, options) => {
        calls.push({ path, options });
        return { added: { movies: [{ to: "plantowatch" }] } };
      },
    },
    "./ids": { simklTargetIds: () => ({ imdb: "tt1" }) },
    "./list-status": { readSimklStateStrict: async () => state },
  });
  return { watchlist, calls };
}

test("Simkl completed titles are never removed through the watchlist path", async () => {
  const f = simklFixture({ status: "completed", watched: new Set(["movie"]) });
  assert.equal(
    await f.watchlist.removeFromWatchlist({ kind: "movie", ids: { imdb: "tt1" } }),
    false,
  );
  assert.equal(f.calls.length, 0);
});

test("Simkl plan-to-watch with no history can be removed", async () => {
  const f = simklFixture({ status: "plantowatch", watched: new Set() });
  assert.equal(
    await f.watchlist.removeFromWatchlist({ kind: "movie", ids: { imdb: "tt1" } }),
    true,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/sync/history/remove");
});

test("Simkl plan-to-watch with history is left untouched", async () => {
  const f = simklFixture({ status: "plantowatch", watched: new Set(["movie"]) });
  assert.equal(
    await f.watchlist.removeFromWatchlist({ kind: "movie", ids: { imdb: "tt1" } }),
    false,
  );
  assert.equal(f.calls.length, 0);
});
