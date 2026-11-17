import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const posterCard = readFileSync(
  new URL("../src/components/pick-card.tsx", import.meta.url),
  "utf8",
);
const tvCard = readFileSync(new URL("../src/components/tv-card.tsx", import.meta.url), "utf8");

test("poster cards reserve and bottom-align title space before a close friend row", () => {
  assert.match(posterCard, /flex min-h-9 flex-col justify-end/);
  assert.match(
    posterCard,
    /className="-mt-2\.5 flex h-\[15px\] items-center overflow-hidden"\s+data-friend-review-row/,
  );
  assert.ok(
    posterCard.indexOf("!settings.hidePosterTitles") < posterCard.indexOf("data-friend-review-row"),
  );
});

test("TV card friend row is below, not overlaid on, the artwork", () => {
  const buttonEnd = tvCard.indexOf("</button>", tvCard.indexOf("export const TvCard"));
  const rowStart = tvCard.indexOf("data-friend-review-row", buttonEnd);
  assert.ok(buttonEnd >= 0, "TV artwork card button exists");
  assert.ok(rowStart > buttonEnd, "friend row is a sibling after the TV artwork button");
  assert.match(
    tvCard,
    /className="-mt-2\.5 flex h-\[15px\] items-center overflow-hidden"\s+data-friend-review-row/,
  );
});
