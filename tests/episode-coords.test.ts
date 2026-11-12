// One coordinate policy for Continue Watching display and provider clearing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveEpisode } from "../src/lib/cw-dismiss.ts";
import { resolvedEpisodeCoords, type LibraryItem } from "../src/lib/stremio.ts";

const item = (id: string, state: Partial<NonNullable<LibraryItem["state"]>>): LibraryItem =>
  ({ _id: id, type: "series", state }) as LibraryItem;

test("complete state coordinates win over the video id", () => {
  const card = item("tt0434665", { season: 4, episode: 11, video_id: "tt0434665:1:2" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 4, episode: 11 });
});

test("season-zero Specials keep their valid coordinates", () => {
  const card = item("tt0434665", { season: 0, episode: 5, video_id: "tt0434665:4:11" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 0, episode: 5 });
});

test("a native anime stream resolves to season one", () => {
  const card = item("tt0434665", { video_id: "kitsu:49444:11" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 1, episode: 11 });
});

test("a native anime stream with no episode invents nothing", () => {
  const card = item("kitsu:49444", { video_id: "kitsu:49444:0" });
  assert.equal(resolvedEpisodeCoords(card), null);
});

test("incomplete state falls back to the provider video id", () => {
  const card = item("tt0434665", { season: 2, video_id: "tt0434665:3:7" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 3, episode: 7 });
});

test("a native anime card with a provider video id uses the provider coordinates", () => {
  const card = item("kitsu:49444", { video_id: "tt0434665:4:11" });
  assert.deepEqual(resolvedEpisodeCoords(card), { season: 4, episode: 11 });
});

test("no complete coordinates resolve to null", () => {
  assert.equal(resolvedEpisodeCoords(item("tt0434665", { video_id: "tt0434665" })), null);
});

test("dismissal matching keeps its intentional partial coordinates", () => {
  const card = item("kitsu:1", { season: 2, video_id: "kitsu:1:3:7" });
  assert.deepEqual(resolveEpisode(card), { season: 2, episode: 7 });
});

test("the card and provider paths share the coordinate helper", () => {
  const advance = readFileSync("src/views/home/hooks/use-cw-advance.ts", "utf8");
  const provider = readFileSync("src/lib/cw-provider-dismiss.ts", "utf8");
  assert.match(advance, /return resolvedEpisodeCoords\(i\);/);
  assert.match(provider, /return resolvedEpisodeCoords\(item\);/);
});
