import assert from "node:assert/strict";
import test from "node:test";
import { invalidateTitleReviewCaches, loadTitleAverageScore } from "@/lib/social/title-reviews";
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
            at: "2026-11-19T00:00:00.000Z",
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
    assert.deepEqual(
      await Promise.all([loadTitleAverageScore(target), loadTitleAverageScore(target)]),
      [8, 8],
    );
    assert.equal(await loadTitleAverageScore(target), 8);
    assert.equal(requests.filter((path) => path.endsWith("/ratings")).length, 2);
    assert.equal(
      requests.some((path) => path.includes("/mutual")),
      false,
    );
    assert.equal(await loadTitleAverageScore({ ...target, itemKey: "unrated" }), null);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateTitleReviewCaches();
    clearUserDirectoryCache();
  }
});
