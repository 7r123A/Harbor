import assert from "node:assert/strict";
import test from "node:test";

import { setIdentityInvoker } from "../src/lib/identity/client.ts";
import {
  clearIdentityCardCache,
  groupCwCards,
  warmIdentityCards,
} from "../src/lib/identity/card-grouping.ts";
import { resetIdentityFlags, setIdentityFlags } from "../src/lib/identity/flags.ts";

const rows = [
  { _id: "mal:14719", state: { lastWatched: "2020-01-01T00:00:00Z" } },
  { _id: "kitsu:49847", state: { lastWatched: "2026-11-18T20:00:00Z" } },
  { _id: "kitsu:99999", state: { lastWatched: "2026-11-18T22:00:00Z" } },
];

function mockHints(): void {
  setIdentityInvoker(async (command, args) => {
    assert.equal(command, "identity_card_hints");
    const ids = (args as { ids: string[] }).ids;
    return ids.map((id) => {
      if (id === "kitsu:99999") {
        return {
          id,
          entry: 9,
          title: "Unmapped",
          mediaType: "TV",
          cardKey: null,
          tvdb: null,
          tmdb: null,
          season: null,
          offset: null,
          provisional: true,
        };
      }
      return {
        id,
        entry: id === "kitsu:49847" ? 2 : 1,
        title: id,
        mediaType: "TV",
        cardKey: "tvdb:262954",
        tvdb: 262954,
        tmdb: 45790,
        season: id === "kitsu:49847" ? 6 : 1,
        offset: 0,
        provisional: false,
      };
    });
  });
}

function reset(): void {
  resetIdentityFlags();
  setIdentityInvoker(null);
  clearIdentityCardCache();
}

test("series-like rows on the same provider show become one card at the newest checkpoint", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  mockHints();

  const changed = await warmIdentityCards(rows);
  assert.equal(changed, true);

  const grouped = groupCwCards(rows);
  assert.equal(grouped.length, 2, "JoJo rows merge; the unknown row stays separate");
  const jojo = grouped.find((item) => item.cwMembers);
  assert.ok(jojo);
  assert.equal(jojo._id, "kitsu:49847", "representative is the most recent activity");
  assert.equal((jojo.cwMembers as unknown[]).length, 2);
  assert.equal(grouped[1]?._id, "kitsu:99999");
});

test("card grouping is disabled unless the cards flag is on", async () => {
  reset();
  setIdentityFlags({ pack: true });
  mockHints();
  await warmIdentityCards(rows);

  const grouped = groupCwCards(rows);
  assert.equal(grouped, rows, "flag off returns the same array");
});

test("movies on a shared provider show stay on their own card", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  setIdentityInvoker(async (command, args) => {
    assert.equal(command, "identity_card_hints");
    const ids = (args as { ids: string[] }).ids;
    return ids.map((id) => ({
      id,
      entry: id === "kitsu:42586" ? 3 : 4,
      title: id,
      mediaType: id === "kitsu:42586" ? "MOVIE" : "TV",
      cardKey: "tvdb:348545",
      tvdb: 348545,
      tmdb: null,
      season: id === "kitsu:42586" ? 0 : 1,
      offset: null,
      provisional: false,
    }));
  });
  const movieRows = [
    { _id: "kitsu:42586", state: { lastWatched: "2026-11-18T20:00:00Z" } },
    { _id: "kitsu:41370", state: { lastWatched: "2026-11-18T21:00:00Z" } },
  ];
  await warmIdentityCards(movieRows);

  assert.equal(groupCwCards(movieRows).length, 2);
});

test("an unresolved identity leaves the row untouched", async () => {
  reset();
  setIdentityFlags({ pack: true, cards: true });
  setIdentityInvoker(async () => null);

  const changed = await warmIdentityCards([rows[0]!]);
  assert.equal(changed, false);
  assert.equal(groupCwCards([rows[0]!]).length, 1);
});
