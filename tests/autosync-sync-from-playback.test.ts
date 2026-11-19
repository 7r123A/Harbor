import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MoonshineUnavailableError,
  matchPlaybackSpeech,
} from "../src/lib/subtitles/autosync/playback-asr.ts";
import {
  offsetTransform,
  playbackSyncCorrection,
} from "../src/views/player/hooks/use-auto-sync.helpers.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hook = read("src/views/player/hooks/use-auto-sync.ts");
const listen = hook.slice(
  hook.indexOf("const listen = useCallback("),
  hook.indexOf("playbackFallbackRef.current = (preferBufferedAudio)"),
);
// What Sync from playback decides before it starts capturing audio.
const listenHead = listen.slice(0, listen.indexOf("localReferenceFocusRef.current = {"));

test("a playback measurement is offered as the change from the viewer's baseline", () => {
  // The viewer had nudged the track by +1.5 s by hand; the audio says the file needs +2 s.
  // Auto sync composes onto that baseline, so the offer is +0.5 s, never +2 s on top of it.
  assert.deepEqual(
    playbackSyncCorrection({
      measuredDelaySec: 2,
      baselineDelaySec: 1.5,
      currentDelaySec: 1.5,
      toleranceSec: 0.25,
    }),
    { aligned: false, offsetSec: 0.5 },
  );
  // Without a baseline the measurement is the whole correction.
  assert.deepEqual(
    playbackSyncCorrection({
      measuredDelaySec: -3.2,
      baselineDelaySec: 0,
      currentDelaySec: 0,
      toleranceSec: 0.25,
    }),
    { aligned: false, offsetSec: -3.2 },
  );
});

test("a measurement matching the delay on screen changes nothing", () => {
  // A hand-made delay that is already right.
  assert.deepEqual(
    playbackSyncCorrection({
      measuredDelaySec: -2,
      baselineDelaySec: -2.1,
      currentDelaySec: -2.1,
      toleranceSec: 0.25,
    }),
    { aligned: true },
  );
  // An earlier automatic correction of +2 s on a zero baseline that is still right.
  assert.deepEqual(
    playbackSyncCorrection({
      measuredDelaySec: 2.1,
      baselineDelaySec: 0,
      currentDelaySec: 2,
      toleranceSec: 0.25,
    }),
    { aligned: true },
  );
  // The same earlier correction when the scene now needs +3 s: the offer replaces it, measured
  // from the baseline it is composed onto.
  assert.deepEqual(
    playbackSyncCorrection({
      measuredDelaySec: 3,
      baselineDelaySec: 0,
      currentDelaySec: 2,
      toleranceSec: 0.25,
    }),
    { aligned: false, offsetSec: 3 },
  );
  // An unknown on-screen delay is taken as the baseline.
  assert.deepEqual(
    playbackSyncCorrection({
      measuredDelaySec: 0.1,
      baselineDelaySec: 0,
      currentDelaySec: Number.NaN,
      toleranceSec: 0.25,
    }),
    { aligned: true },
  );
});

test("Moonshine reports when it could not run at all, apart from a failed comparison", async () => {
  const base = {
    path: "tap.wav",
    durationSec: 45,
    cues: [] as Array<[number, number]>,
    audioLanguage: "en",
    subtitleLanguage: "en",
    enabled: true,
    crossLanguage: true,
    sessionId: "s",
  };
  const status =
    (value: Record<string, boolean>) =>
    async <T>(command: string) => {
      if (command === "moonshine_model_status")
        return { supported: true, runtimeInstalled: true, installed: true, ...value } as T;
      throw new Error(`Unexpected command ${command}`);
    };
  for (const [input, invoke] of [
    [{ ...base, enabled: false }, status({})],
    [{ ...base, subtitleLanguage: "de", crossLanguage: false }, status({})],
    [base, status({ supported: false })],
    [base, status({ runtimeInstalled: false })],
  ] as const) {
    await assert.rejects(
      matchPlaybackSpeech(
        input,
        invoke,
        () => {},
        () => true,
      ),
      (error: unknown) => error instanceof MoonshineUnavailableError,
    );
  }
  // A missing language model still asks the viewer to download it.
  await assert.rejects(
    matchPlaybackSpeech(
      base,
      status({ installed: false }),
      () => {},
      () => true,
    ),
    (error: unknown) => !(error instanceof MoonshineUnavailableError),
  );
});

test("an applied offer always reaches its delay, even after a session restore", () => {
  // A tiny shift is skipped only while the delay on screen is already its target. A resumed
  // session or a nudge can leave another delay on screen, and skipping would keep it.
  assert.match(
    hook,
    /const targetDelaySec = a\.subDelayBefore \+ t\.offsetSec;[\s\S]{0,300}?Math\.abs\(t\.offsetSec\) < OFFSET_EPS &&\s*!a\.transform &&\s*Math\.abs\(liveSnapRef\.current\.subDelaySec - targetDelaySec\) < OFFSET_EPS\s*\)\s*return true;[\s\S]{0,400}?b\.setSubDelay\(a\.subDelayBefore \+ t\.offsetSec\);/,
  );
});

test("a refined generated track keeps its rewrite in the saved correction", () => {
  assert.deepEqual(offsetTransform({ kind: "affine", offsetSec: 1, ratio: 1.001 }, 0.5), {
    kind: "affine",
    offsetSec: 1.5,
    ratio: 1.001,
  });
  assert.deepEqual(
    offsetTransform(
      {
        kind: "piecewise",
        segments: [
          { fromSec: 0, toSec: 600, offsetSec: 2, ratio: 1 },
          { fromSec: 600, toSec: Infinity, offsetSec: 3, ratio: 1.0005 },
        ],
      },
      -0.4,
    ),
    {
      kind: "piecewise",
      segments: [
        { fromSec: 0, toSec: 600, offsetSec: 1.6, ratio: 1 },
        { fromSec: 600, toSec: Infinity, offsetSec: 2.6, ratio: 1.0005 },
      ],
    },
  );
  // The delay refinement is folded into the rewrite, replacing an earlier refinement, and the
  // saved correction uses the rewrite with the original cues.
  assert.match(
    hook,
    /a\.transform = offsetTransform\(a\.transform, t\.offsetSec - \(a\.refinementSec \?\? 0\)\);\s*a\.refinementSec = t\.offsetSec;/,
  );
  assert.match(hook, /a\.sourceCues = cues;\s*a\.refinementSec = 0;/);
  assert.match(
    hook,
    /persistAppliedCorrection\(\s*rewritten\?\.sourceCues \?\? cues,\s*rewritten\?\.transform \?\? t,/,
  );
  // A nudge keeps the refinement out of the viewer's saved baseline.
  assert.match(hook, /: value - \(applied\.refinementSec \?\? 0\);/);
});

test("Sync from playback measures from the viewer's current baseline", () => {
  assert.ok(listen.length > 0 && listenHead.length > 0);
  // Both the source-audio and the buffered result go through the baseline correction.
  assert.equal(listen.match(/playbackSyncCorrection\(\{/g)?.length, 2);
  assert.doesNotMatch(listen, /usedMoonshine && result\.offsetSec === 0/);
  assert.doesNotMatch(listen, /offsetSec: result\.offsetSec,/);
  assert.doesNotMatch(listen, /offsetSec: sceneResult\.offsetSec,/);
  // With nothing applied, the delay is the viewer's own: an earlier scope does not keep a
  // stale baseline for the offer.
  assert.match(
    listenHead,
    /\} else if \(!appliedRef\.current\.changed\) \{[^}]*appliedRef\.current\.subDelayBefore = viewerDelaySec;/,
  );
});

test("Sync from playback explains a track it cannot sync, on every request", () => {
  assert.match(
    listenHead,
    /liveSnap\.durationSec < MIN_DURATION_SEC\s*\? "The video is too short to sync from playback\."/,
  );
  assert.match(
    listenHead,
    /isSyncedTrack\(selectedTrack\) &&\s*!isOwnGeneratedSyncTrack\(selectedTrack, appliedRef\.current\.generatedTrackPath\)\s*\? "Select the original subtitle track to sync it from playback\."/,
  );
  // Decided before an earlier scope is reused, so a second click never slips past it.
  assert.ok(
    listenHead.indexOf("const refusal =") <
      listenHead.indexOf("let scope = statusScopeRef.current;"),
  );
  // The explanation replaces whatever the popover showed, including a Moonshine prompt.
  assert.match(
    listenHead,
    /if \(refusal\) \{[^}]*setMoonshineModelLanguage\(null\);[^}]*setStatus\("error"\);\s*return;/,
  );
});

test("a refused request never marks the track as handled", () => {
  // Auto sync skips a track and audio marked as done, so only an accepted request may mark it.
  const doneAt = listenHead.indexOf("doneKeyRef.current = autoSyncRunKey(");
  assert.ok(doneAt > listenHead.indexOf("if (refusal) {"));
  assert.equal(listenHead.split("doneKeyRef.current =").length - 1, 1);
});

test("Sync from playback ends the Live sync hold only when it runs", () => {
  const refusalAt = listenHead.indexOf("if (refusal) {");
  const holdAt = listenHead.search(
    /if \(manualTimingMediaRef\.current === autoSyncMediaKey\(media\)\) \{\s*manualTimingMediaRef\.current = null;/,
  );
  assert.ok(refusalAt > 0 && holdAt > refusalAt);
  assert.ok(listenHead.indexOf("if (!isCurrentAutoSyncScope(scope)) return;") > holdAt);
});

test("thumbs on a playback result never rate an earlier Auto sync result", () => {
  // The report is dropped when a sync from playback starts, and feedback only sends a report
  // made in the scope on screen, so a new run, video or restored correction is covered too.
  assert.match(listenHead, /lastReportRef\.current = null;/);
  assert.match(hook, /confidence: o\.decision\.pCorrect,\s*scope: statusScope,/);
  assert.match(hook, /if \(!r \|\| r\.scope !== statusScopeRef\.current\) return;/);
});

test("a Moonshine prompt or setup message never hides the outcome it does not explain", () => {
  // Moonshine that never ran does not replace the Silero outcome in Automatic mode.
  assert.match(listen, /error instanceof MoonshineUnavailableError && !directMoonshine/);
  // A new Auto sync run drops a prompt left by an earlier sync from playback.
  const beginRun = hook.slice(
    hook.indexOf("const beginRun = useCallback("),
    hook.indexOf("const cancelled = { current: false };"),
  );
  assert.match(beginRun, /setMoonshineModelLanguage\(null\);\s*setMoonshineDownloadError\(null\);/);
});

test("Try again repeats the viewer's sync from playback", () => {
  // Auto sync's own fallback to playback is not the viewer's request, so retrying it still
  // runs Auto sync.
  assert.match(
    listenHead,
    /if \(requestedBy === "viewer"\) playbackRequestScopeRef\.current = scope;/,
  );
  assert.match(
    hook,
    /playbackFallbackRef\.current = \(preferBufferedAudio\) =>\s*listen\(preferBufferedAudio, "auto-sync"\)/,
  );
  assert.match(
    hook,
    /const playbackRequest =\s*statusScopeRef\.current !== null && playbackRequestScopeRef\.current === statusScopeRef\.current;\s*if \(\(track && !track\.external\) \|\| playbackRequest\) listen\(true\);\s*else run\(\);/,
  );
});

test("each new sync from playback starts with a clean result", () => {
  // Both cache cuts fail with the same code.
  assert.equal(listen.match(/throw new Error\("cache-audio-dump-command-failed"\)/g)?.length, 2);
  // A result that changes nothing never shows the shift of an earlier offer.
  const popover = read("src/components/player/autosync/autosync-popover.tsx");
  assert.match(popover, /phase === "analyzing" \|\| phase === "listening" \|\| phase === null/);
});
