import assert from "node:assert/strict";
import test from "node:test";
import { applyAuthResult, reloadSession } from "@/lib/theme-auth";
import {
  cachedFriendReviewIndex,
  loadFriendReviewIndex,
  subscribeFriendReviewIndex,
} from "@/lib/social/friend-review-index";

test("a friend's newly posted ratings refresh for any title and publish new snapshots", async (t) => {
  let now = Date.now();
  let items: Array<{ itemKey: string; mediaType: string; score: number; at: string }> = [];
  let historyReads = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace("/themes/api", "");
    if (path === "/social/friends") return Response.json([{ handle: "friend", alias: "Friend" }]);
    if (path === "/social/u/friend/ratings") {
      historyReads++;
      return Response.json({ items });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  applyAuthResult({
    token: "test-session",
    user: { id: "viewer", username: "viewer", handle: "viewer" },
  });
  const snapshots: unknown[] = [];
  const off = subscribeFriendReviewIndex(() => snapshots.push(cachedFriendReviewIndex()));
  try {
    const empty = await loadFriendReviewIndex(true);
    assert.equal(empty.size, 0);
    assert.equal(await loadFriendReviewIndex(), empty);
    assert.equal(historyReads, 1);
    items = [{ itemKey: "first-title", mediaType: "movie", score: 8, at: "2026-11-19T00:00:00Z" }];
    now += 10_001;
    const first = await loadFriendReviewIndex();
    assert.deepEqual(
      first.get("movie|first-title")?.map((mark) => mark.handle),
      ["friend"],
    );
    assert.equal(empty.size, 0);
    assert.notEqual(first, empty);
    items.push({
      itemKey: "another-title",
      mediaType: "series",
      score: 9,
      at: "2026-11-19T00:01:00Z",
    });
    now += 10_001;
    const second = await loadFriendReviewIndex();
    assert.equal(second.has("series|another-title"), true);
    assert.equal(first.has("series|another-title"), false);
    assert.equal(historyReads, 3);
    assert.ok(snapshots.includes(first));
    assert.ok(snapshots.includes(second));
  } finally {
    off();
    reloadSession(true);
  }
});
