// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

const at = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(at(path), "utf8");

const clock = read("src/lib/player/playback-clock.ts");
const timeDisplay = read("src/components/player/transport/time-display.tsx");
const player = read("src/views/player.tsx");
const uiFallback = read("src/lib/i18n/locales/ui-fallback.ts");

test("the player cache dot only reflects P2P cache state", () => {
  assert.match(clock, /let downloadedFromP2p = false/);
  assert.match(clock, /export function setPlaybackDownloadedFromP2p/);
  assert.match(clock, /export function usePlaybackDownloadedFromP2pGated/);
  assert.match(player, /setPlaybackDownloadedFromP2p\(isP2pEngine\)/);
  assert.match(timeDisplay, /usePlaybackDownloadedFromP2pGated\(active\)/);
  assert.match(timeDisplay, /if \(!fromP2p\) \{/);
});

test("the cache dot is orange while caching and green once cached", () => {
  assert.match(timeDisplay, /const caching = fromP2p && !cached && downloaded > 0/);
  assert.match(timeDisplay, /if \(!cached && !caching\) return null/);
  assert.match(timeDisplay, /bg-\[#fb923c\]/);
  assert.match(timeDisplay, /bg-\[#22c55e\]/);
});

test("clicking the cache dot toggles the P2P status chip without cycling the time format", () => {
  assert.match(timeDisplay, /update\(\{ playerP2pChip: !settings\.playerP2pChip \}\)/);
  assert.match(timeDisplay, /aria-pressed=\{settings\.playerP2pChip\}/);
  assert.match(timeDisplay, /event\.stopPropagation\(\)/);
  assert.match(timeDisplay, /role="button"/);
});

test("the new cache-dot copy has a fallback translation entry", () => {
  assert.match(
    uiFallback,
    /"Cached · click to toggle P2P stats": "Cached · click to toggle P2P stats"/,
  );
  assert.match(
    uiFallback,
    /"Caching · click to toggle P2P stats": "Caching · click to toggle P2P stats"/,
  );
  assert.match(uiFallback, /"Toggle P2P stats": "Toggle P2P stats"/);
});
