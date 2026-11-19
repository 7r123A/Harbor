import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, flushPromises } from "./helpers/hook-harness.ts";

function source(episode: number) {
  return {
    meta: { id: "mal:14719", type: "series", name: "JoJo" },
    isAnime: true,
    url: "mock://playback",
    episode: { season: 6, episode, kitsuStreamId: "kitsu:49847:" + episode },
  };
}

function createHarness() {
  const pending: Array<{ episode: number; settle: (result: any) => void }> = [];
  const hook = hookHarness(
    "src/lib/identity/use-live-scrobble.ts",
    "useLiveScrobbleResolution",
    {
      "./live-scrobble": {
        resolveLiveAnimeScrobble: (src: any) => new Promise((resolve) => {
          pending.push({ episode: src.episode.episode, settle: resolve });
        }),
      },
    },
  );
  return {
    pending,
    render: (episode: number, enabledSetting = true) =>
      hook.render({ src: source(episode), enabledSetting }),
    unmount: () => hook.unmount(),
  };
}

test("Stage 1 runs once per playback identity and reuses its verified result", async () => {
  const h = createHarness();
  assert.equal(h.render(1).phase, "resolving");
  assert.equal(h.pending.length, 1);
  h.pending[0].settle({ work: { entryId: "kitsu:49847", entryEpisode: 1 } });
  await flushPromises();
  assert.equal(h.render(1).proof?.work.entryId, "kitsu:49847");
  assert.equal(h.render(1).phase, "ready");
  assert.equal(h.pending.length, 1, "rerenders should not start another lookup");
  h.unmount();
});

test("late result for the previous episode cannot modify the current scrobble target", async () => {
  const h = createHarness();
  assert.equal(h.render(1).phase, "resolving");
  assert.equal(h.render(2).phase, "resolving");
  assert.equal(h.pending.length, 2);
  h.pending[0].settle({ work: { entryId: "kitsu:49847", entryEpisode: 1 } });
  await flushPromises();
  assert.equal(h.render(2).phase, "resolving", "stale episode cannot win");
  h.pending[1].settle({ work: { entryId: "kitsu:49847", entryEpisode: 2 } });
  await flushPromises();
  assert.equal(h.render(2).proof?.work.entryEpisode, 2);
  h.unmount();
});

test("disabled live-scrobbling never invokes the database and uses stock behavior", () => {
  const h = createHarness();
  assert.equal(h.render(1, false).phase, "off");
  assert.equal(h.pending.length, 0);
  h.unmount();
});

test("missing proof releases tracking to its preexisting provider fallback", async () => {
  const h = createHarness();
  assert.equal(h.render(1).phase, "resolving");
  h.pending[0].settle(null);
  await flushPromises();
  assert.deepEqual(h.render(1), { phase: "ready", proof: null });
  h.unmount();
});


test("disabling then re-enabling while the same episode plays starts a fresh proof", async () => {
  const h = createHarness();
  h.render(1);
  h.pending[0].settle({ work: { entryId: "kitsu:49847", entryEpisode: 1 } });
  await flushPromises();
  assert.equal(h.render(1).phase, "ready");
  assert.equal(h.render(1, false).phase, "off");
  assert.equal(h.render(1).phase, "resolving");
  assert.equal(h.pending.length, 2);
  h.pending[1].settle(null);
  await flushPromises();
  assert.deepEqual(h.render(1), { phase: "ready", proof: null });
  h.unmount();
});
