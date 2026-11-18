import assert from "node:assert/strict";
import test from "node:test";
import { invalidateTitleReviewCaches, loadTitleRatingSummary } from "@/lib/social/title-reviews";
import { clearUserDirectoryCache } from "@/lib/social/user-directory";

test("hover averages use cached community histories on older servers without loading matches", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const target = { mediaType: "movie", itemKey: "hover-average-test" } as const;
  invalidateTitleReviewCaches();
  clearUserDirectoryCache();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/themes/api", "");
    requests.push(path);
    if (path === "/social/reviews") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (path === "/social/groups/discover") {
      return Response.json({
        groups: [{ id: "test-group", memberPreview: [{ handle: "alpha" }, { handle: "beta" }] }],
      });
    }
    if (path === "/social/groups/test-group") return Response.json({ members: [] });
    if (path.endsWith("/friends")) return Response.json([]);
    if (path === "/social/u/alpha/ratings" || path === "/social/u/beta/ratings") {
      return Response.json({
        items: [
          {
            ...target,
            score: path.includes("/alpha/") ? 6 : 10,
            title: "Test title",
            at: path.includes("/alpha/") ? "2026-11-18T00:00:00.000Z" : "2026-11-19T00:00:00.000Z",
          },
          {
            itemKey: target.itemKey,
            mediaType: "anime",
            score: 1,
            at: "2026-11-19T00:00:00.000Z",
          },
        ],
      });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  try {
    const [first, duplicate] = await Promise.all([
      loadTitleRatingSummary(target),
      loadTitleRatingSummary(target),
    ]);
    assert.equal(first.averageScore, 8);
    assert.equal(first.total, 2);
    assert.deepEqual(
      first.recentRatings.map((rating) => rating.handle),
      ["beta", "alpha"],
    );
    assert.deepEqual(duplicate, first);
    assert.deepEqual(await loadTitleRatingSummary(target), first);
    assert.equal(requests.filter((path) => path.endsWith("/ratings")).length, 2);
    assert.equal(
      requests.some((path) => path.includes("/mutual")),
      false,
    );
    assert.deepEqual(await loadTitleRatingSummary({ ...target, itemKey: "unrated" }), {
      averageScore: null,
      total: 0,
      recentRatings: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
    invalidateTitleReviewCaches();
    clearUserDirectoryCache();
  }
});
