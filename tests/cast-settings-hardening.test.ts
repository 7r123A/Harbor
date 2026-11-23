import assert from "node:assert/strict";
import test from "node:test";
import "./_localstorage-stub.ts";
import { DEFAULT_CAST_OPTIONS, type CastDeviceInfo, type CastSubInfo } from "../src/lib/cast.ts";
import {
  castNeedsConversion,
  directReloadRequest,
  pictureNeedsConversion,
} from "../src/lib/cast/cast-source.ts";
import { knownStreamHeight } from "../src/lib/cast/device-caps.ts";

// Preferences written by an older build, or edited by hand: wrong types, unknown choices and
// fractional numbers the Rust side would refuse.
localStorage.setItem(
  "harbor.cast.preferences.v1",
  JSON.stringify({
    options: {
      quality: "8k",
      audioMode: "surround",
      volumeBoost: -20,
      audioDelayMs: 1250.6,
      subDelayMs: 99_000_000,
      nightMode: "yes",
      subEncoding: "windows-1256",
    },
    look: { sizePercent: 9000, color: "red", lift: -5, background: true },
    devices: {
      "dlna-tv": {
        device: { name: "TV", kind: "dlna", model: null },
        overrides: { quality: "720p", volumeBoost: 50, aspect: "huge" },
      },
    },
    lastDeviceId: "dlna-tv",
  }),
);

const prefs = await import("../src/lib/cast/cast-preferences.ts");

function device(id: string): CastDeviceInfo {
  return {
    id,
    name: id,
    host: "192.0.2.20",
    port: 0,
    model: null,
    kind: "chromecast",
    control_url: null,
    audio_only: false,
  };
}

test("stored settings the converter cannot take are repaired when they load", () => {
  const { options, look, devices } = prefs.getCastPreferences();
  assert.equal(options.quality, DEFAULT_CAST_OPTIONS.quality, "an unknown quality is dropped");
  assert.equal(options.audioMode, "surround", "a valid choice is kept");
  assert.equal(options.volumeBoost, 0, "a negative boost is dropped");
  assert.equal(options.audioDelayMs, 1251, "a fractional delay becomes whole milliseconds");
  assert.equal(options.subDelayMs, prefs.CAST_DELAY_LIMIT_MS, "a runaway delay is bounded");
  assert.equal(options.nightMode, false, "a non-boolean switch is dropped");
  assert.equal(options.subEncoding, "windows-1256");
  assert.equal(look.sizePercent, 400);
  assert.equal(look.color, "#FFFFFF", "only #RRGGBB colours are kept");
  assert.equal(look.lift, 0);
  assert.equal(look.background, true);
  // A device keeps only its own settings, and only valid ones.
  assert.deepEqual(devices["dlna-tv"].overrides, { quality: "720p" });
});

test("sanitizing keeps every value the panel itself can produce", () => {
  const clean = prefs.sanitizeCastOptions({ ...DEFAULT_CAST_OPTIONS, volumeBoost: 100 });
  assert.deepEqual(clean, { ...DEFAULT_CAST_OPTIONS, volumeBoost: 100 });
  assert.deepEqual(prefs.sanitizeCastOptions(null), {});
  assert.deepEqual(prefs.sanitizeCastOptions({ volumeBoost: 30 }), {}, "not a panel step");
  assert.deepEqual(prefs.sanitizeCastOptions({ subEncoding: "x; rm -rf" }), {});
});

test("only the most recent devices keep their own settings", () => {
  for (let i = 0; i < 40; i++) prefs.rememberCastDevice(device(`cc-${i}`));
  // A device cast to again moves to the newest end instead of being forgotten.
  prefs.rememberCastDevice(device("cc-5"));
  const ids = Object.keys(prefs.getCastPreferences().devices);
  assert.equal(ids.length, 32);
  assert.equal(ids.at(-1), "cc-5");
  assert.ok(!ids.includes("dlna-tv"), "the oldest device is forgotten first");
  assert.ok(ids.includes("cc-39"));
  assert.equal(prefs.getCastPreferences().lastDeviceId, "cc-5");
});

test("the converter runs exactly when the cast needs something a copy cannot give", () => {
  const plain = { subtitle: null, audioTrackOrdinal: undefined, options: DEFAULT_CAST_OPTIONS };
  assert.equal(castNeedsConversion("compat", false, plain), false);
  assert.equal(castNeedsConversion("swapped", false, plain), false);
  assert.equal(castNeedsConversion("transcode", false, plain), true);
  assert.equal(castNeedsConversion("compat", true, plain), true, "live TV");
  const subtitle: CastSubInfo = { kind: "external", url: "C:/a.srt", format: "srt", off: false };
  assert.equal(castNeedsConversion("compat", false, { ...plain, subtitle }), true);
  assert.equal(castNeedsConversion("compat", false, { ...plain, audioTrackOrdinal: 1 }), true);
  assert.equal(castNeedsConversion("compat", false, { ...plain, audioTrackOrdinal: 0 }), false);
  for (const change of [
    { volumeBoost: 25 },
    { nightMode: true },
    { dialogueBoost: true },
    { audioDelayMs: -50 },
    { forceConversion: true },
  ]) {
    const options = { ...DEFAULT_CAST_OPTIONS, ...change };
    assert.equal(castNeedsConversion("compat", false, { ...plain, options }), true);
  }
  // Settings the converter only uses when it runs anyway do not start it.
  const passive = { ...DEFAULT_CAST_OPTIONS, subDelayMs: 500, quality: "720p" as const };
  assert.equal(castNeedsConversion("compat", false, { ...plain, options: passive }), false);
});

const direct = { subtitle: null, audioTrackOrdinal: undefined, options: DEFAULT_CAST_OPTIONS };
const withOptions = (change: Partial<typeof DEFAULT_CAST_OPTIONS>) => ({
  ...direct,
  options: { ...DEFAULT_CAST_OPTIONS, ...change },
});

test("picture settings send a directly compatible stream through the converter", () => {
  // A 1080p stream the receiver plays as it is.
  assert.equal(castNeedsConversion("compat", false, direct, 1080), false);
  assert.equal(castNeedsConversion("compat", false, withOptions({ quality: "720p" }), 1080), true);
  assert.equal(castNeedsConversion("compat", false, withOptions({ aspect: "4:3" }), 1080), true);
  assert.equal(castNeedsConversion("compat", false, withOptions({ aspect: "fill" }), 1080), true);
  assert.equal(
    castNeedsConversion("compat", false, withOptions({ deinterlace: "always" }), 1080),
    true,
  );
  assert.equal(castNeedsConversion("compat", false, withOptions({ tonemap: "on" }), 1080), true);
  // A swapped alternative is judged by its own height, like the player's file.
  assert.equal(castNeedsConversion("swapped", false, withOptions({ quality: "720p" }), 1080), true);
});

test("a quality setting converts only a source known to be taller than it", () => {
  const at = (quality: typeof DEFAULT_CAST_OPTIONS.quality, height: number | undefined) =>
    pictureNeedsConversion({ ...DEFAULT_CAST_OPTIONS, quality }, height);
  assert.equal(at("1080p", 1080), false, "already that size");
  assert.equal(at("1080p-hq", 1080), false);
  assert.equal(at("720p", 720), false);
  assert.equal(at("720p", 800), true, "a 1920x800 scope film is taller than 720p");
  assert.equal(at("1080p", 2160), true);
  assert.equal(at("4k", 2160), false);
  assert.equal(at("original", 4320), false);
  // An unknown height is left to the converter's probe instead of converting every cast.
  assert.equal(at("720p", undefined), false);
  assert.equal(at("720p", 0), false);
  // Settings the converter applies only when it runs anyway.
  for (const change of [{ deinterlace: "auto" as const }, { tonemap: "off" as const }]) {
    assert.equal(pictureNeedsConversion({ ...DEFAULT_CAST_OPTIONS, ...change }, 1080), false);
  }
});

test("a stream's height is the decoded or named one, never a guess", () => {
  assert.equal(knownStreamHeight({ liveHeight: 800 }), 800);
  assert.equal(knownStreamHeight({ parsedTitle: "Film.2024.2160p.WEB-DL" }), 2160);
  assert.equal(knownStreamHeight({ title: "Film 720p" }), 720);
  assert.equal(knownStreamHeight({ title: "Film" }), undefined);
  assert.equal(knownStreamHeight({ liveHeight: 0, title: "Film" }), undefined);
});

test("changing a picture setting during a direct cast reloads it through the converter", () => {
  // The TV plays a compatible 1080p stream directly.
  const loaded = {
    url: "https://cdn.example/film.m3u8",
    startTimeSec: 0,
    transcode: false,
    options: DEFAULT_CAST_OPTIONS,
    subtitle: null,
    subStyle: null,
    audioTrackOrdinal: 0,
  };
  const media = withOptions({ aspect: "4:3" });
  const change = {
    options: media.options,
    subtitle: media.subtitle,
    subStyle: null,
    audioTrackOrdinal: 0,
    transcode: castNeedsConversion("compat", false, media, 1080),
  };
  const next = directReloadRequest(loaded, change, 754.5);
  assert.equal(next.transcode, true, "the 4:3 picture needs the converter");
  assert.equal(next.options.aspect, "4:3");
  assert.equal(next.startTimeSec, 754.5, "it continues where the TV was");
  assert.equal(next.url, loaded.url);
  // Going back to the default picture mid-cast keeps the conversion running.
  const back = directReloadRequest(
    next,
    {
      options: DEFAULT_CAST_OPTIONS,
      transcode: castNeedsConversion("compat", false, direct, 1080),
    },
    800,
  );
  assert.equal(back.transcode, true);
  // A change that needs nothing leaves a direct cast direct, and keeps what it did not mention.
  const louder = directReloadRequest(loaded, { audioTrackOrdinal: 0, transcode: false }, 10);
  assert.equal(louder.transcode, false);
  assert.equal(louder.options, DEFAULT_CAST_OPTIONS);
  assert.equal(louder.subtitle, null);
});
