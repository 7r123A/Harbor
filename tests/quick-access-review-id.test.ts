import assert from "node:assert/strict";
import test from "node:test";
import type { PublicRating } from "@/lib/ratings/types";
import { canLikeQuickReview, reviewFromRating } from "@/lib/social/quick-reviews";

const rating: PublicRating = {
  itemKey: "tt123",
  mediaType: "movie",
  score: 8,
  title: "Example",
  at: "2026-11-16T12:00:00Z",
};

test("legacy ratings without a review ID cannot start fake like requests", () => {
  const review = reviewFromRating(rating);
  assert.equal(review.id, undefined);
  assert.equal(canLikeQuickReview(review), false);
});

test("a real review ID enables likes and is preserved by the fallback adapter", () => {
  const review = reviewFromRating({ ...rating, reviewId: "review-42" });
  assert.equal(review.id, "review-42");
  assert.equal(canLikeQuickReview(review), true);
});
