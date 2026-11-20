import assert from "node:assert/strict";
import test from "node:test";
import { getDeviceCaps } from "../src/lib/cast/device-caps";

const airplay = (model: string) => getDeviceCaps({ kind: "airplay", name: "Living Room", model });

test("older Apple TVs are capped at the resolution they decode", () => {
  assert.equal(airplay("AppleTV2,1").maxResolution, 720, "the second generation stops at 720p");
  assert.equal(airplay("AppleTV3,2").maxResolution, 1080);
  assert.equal(airplay("AppleTV5,3").maxResolution, 1080, "Apple TV HD");
  assert.equal(airplay("AppleTV3,2").hevc, false);
});

test("an Apple TV 4K keeps its own capabilities", () => {
  assert.ok(airplay("AppleTV14,1").maxResolution >= 2160);
});
