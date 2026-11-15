// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";
import type { CastSubInfo, CastSubStyle } from "../src/lib/cast.ts";
import { fitTracksToCastSource } from "../src/lib/cast/cast-source.ts";
import {
  FILM_CHANGED,
  getExternalAudioJob,
  syncExternalAudio,
} from "../src/lib/player/external-audio.ts";
import type { TrackInfo } from "../src/lib/player/bridge.ts";

const style = { fontSize: 27 } as unknown as CastSubStyle;
const embedded: CastSubInfo = { kind: "embedded", ordinal: 1, format: "srt", off: false } as never;
const file: CastSubInfo = { kind: "external", url: "C:/subs/a.srt", format: "srt", off: false };

test("reloading a swapped stream never applies the player's track numbers to it", () => {
  // The player's file has Japanese as audio track 2; the alternative stream's order is unknown.
  const media = { subtitle: embedded, subStyle: style, audioTrackOrdinal: 1, options: {} };
  const reloaded = fitTracksToCastSource(media, true);
  assert.equal(reloaded.audioTrackOrdinal, undefined);
  assert.equal(reloaded.subtitle, null);
  assert.equal(reloaded.subStyle, null);
  assert.equal(reloaded.options, media.options);
  // A subtitle file belongs to no stream, so it still burns in.
  const withFile = fitTracksToCastSource({ ...media, subtitle: file }, true);
  assert.equal(withFile.subtitle, file);
  assert.equal(withFile.subStyle, style);
  // The player's own file keeps every choice.
  assert.equal(fitTracksToCastSource(media, false), media);
});

function mockMpv(state: { path: string; synced: () => void }, calls: unknown[][]) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { name?: string; cmd?: unknown[] }) => {
          calls.push([command, args]);
          if (command === "mpv_get_property") {
            if (args.name === "path") return state.path;
            if (args.name === "duration") return 6000;
            return null;
          }
          if (command === "external_audio_probe") {
            return { durationSec: 6000, streams: [], guessedLanguage: "ara" };
          }
          if (command === "external_audio_sync") {
            state.synced();
            return {
              jobId: "x",
              verdict: "match",
              outputPath: "C:/tmp/synced.mka",
              offsetSec: 1,
              speed: 1,
              segments: 1,
              matched: 10,
              windows: 10,
              confidence: 0.9,
              verifyWindows: 4,
              verifyMedianMs: 2,
              verifyMaxMs: 5,
              cached: false,
            };
          }
          return null;
        },
        transformCallback: () => 0,
      },
    },
  });
}

const tracks: TrackInfo[] = [
  { id: "1", type: "audio", selected: true, external: false } as unknown as TrackInfo,
];

test("a dub synced for one film is not attached after switching to another film", async () => {
  const calls: unknown[][] = [];
  const state = { path: "C:/films/A.mkv", synced: () => (state.path = "C:/films/B.mkv") };
  mockMpv(state, calls);
  try {
    await syncExternalAudio("C:/dubs/A.ar.mka", 0, tracks);
    assert.deepEqual(getExternalAudioJob(), { kind: "error", message: FILM_CHANGED });
    assert.ok(!calls.some(([c]) => c === "mpv_command"), "nothing may be added to film B");
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("a dub is attached when the same film is still playing", async () => {
  const calls: unknown[][] = [];
  const state = { path: "C:/films/A.mkv", synced: () => {} };
  mockMpv(state, calls);
  try {
    await syncExternalAudio("C:/dubs/A.ar.mka", 0, tracks);
    assert.equal(getExternalAudioJob().kind, "done");
    const added = calls.find(([c]) => c === "mpv_command") as
      | [string, { cmd: unknown[] }]
      | undefined;
    assert.deepEqual(added?.[1].cmd.slice(0, 2), ["audio-add", "C:/tmp/synced.mka"]);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
