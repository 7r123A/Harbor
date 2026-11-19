// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

function load(): any {
  const source = readFileSync("src/views/detail/anime-episodes/anime-season-key.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (id === "@/lib/providers/kitsu")
      return { parseKitsuId: (value: string) => Number(/^kitsu:(\d+)$/.exec(value)?.[1]) || null };
    if (id === "@/lib/streams/anime-identity-core")
      return { splitFranchiseDisplaySeason: () => null };
    throw new Error(`unexpected import ${id}`);
  }, exports);
  return exports;
}

const pool = [{ sourceMetaId: "kitsu:49847" }, { sourceMetaId: "kitsu:49847" }];

test("a catalog season switches to the native entry that owns it", () => {
  const { canonicalSeasonOwnerId } = load();
  assert.equal(canonicalSeasonOwnerId("tt2359704", 6, "kitsu:49847", pool), "kitsu:49847");
});

test("the page stays on its anchor when it already is the owner", () => {
  const { canonicalSeasonOwnerId } = load();
  assert.equal(canonicalSeasonOwnerId("kitsu:49847", 6, "kitsu:49847", pool), null);
});

test("no switch happens when the owner has no episodes in the loaded pool", () => {
  const { canonicalSeasonOwnerId } = load();
  assert.equal(canonicalSeasonOwnerId("tt2359704", 6, "kitsu:1", pool), null);
});

test("an invalid or absent season does not switch entries", () => {
  const { canonicalSeasonOwnerId } = load();
  assert.equal(canonicalSeasonOwnerId("tt2359704", null, "kitsu:49847", pool), null);
  assert.equal(canonicalSeasonOwnerId("tt2359704", 0, "kitsu:49847", pool), null);
});

test("catalog cards use the native progress owner and airdate for the same provider episode", () => {
  const { nativeSeasonRows } = load();
  const catalog = {
    number: 8,
    imdbEpisode: 8,
    imdbSeason: 2,
    imdbId: "tt1",
    airdate: "2026-11-21",
  };
  const native = { ...catalog, number: 3, sourceMetaId: "kitsu:17", airdate: "2026-11-17" };
  const unrelated = { ...catalog, imdbId: "tt2" };
  assert.deepEqual(nativeSeasonRows([catalog, unrelated], [native], 2), [native, unrelated]);
});
