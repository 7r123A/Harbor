import { composeQuotedBody, type RatingQuote } from "@/lib/ratings/quote";
import type { Comment } from "@/views/profile/profile-types";
import { fetchComments, postComment } from "@/views/profile/profile-api";
import { commentQuotesTitle, foldHandle, type TitleRef } from "./review-rank";

/**
 * A review's discussion reuses the profile comment system: a comment answers a review by quoting
 * the rated title, which is the same marker the profile composer writes. Keeping that as the only
 * store means a reply made here shows up on the profile, and a reply made there shows up here.
 */
const CACHE_TTL = 2 * 60_000;

export type ReviewThread = {
  comments: Comment[];
  nextCursor?: string;
  hasMore: boolean;
};

const cache = new Map<string, { at: number; thread: ReviewThread }>();
const inflight = new Map<string, Promise<ReviewThread>>();

function keyOf(handle: string, target: TitleRef): string {
  return `${target.mediaType}|${target.itemKey}|${foldHandle(handle)}`;
}

function matching(comments: readonly Comment[], target: TitleRef): Comment[] {
  return comments.filter((comment) => commentQuotesTitle(comment.body, target));
}

/** Count from a recent load, so cards can show it without asking the API again. */
export function cachedReviewCommentCount(handle: string, target: TitleRef): number | null {
  const hit = cache.get(keyOf(handle, target));
  return hit && Date.now() - hit.at < CACHE_TTL ? hit.thread.comments.length : null;
}

export async function loadReviewThread(
  handle: string,
  target: TitleRef,
  cursor?: string,
): Promise<ReviewThread> {
  const key = keyOf(handle, target);
  if (!cursor) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.thread;
    const running = inflight.get(key);
    if (running) return running;
  }

  const task = (async (): Promise<ReviewThread> => {
    const page = await fetchComments(handle, cursor);
    const thread: ReviewThread = {
      comments: matching(page.comments ?? [], target),
      nextCursor: page.nextCursor,
      hasMore: !!page.nextCursor,
    };
    if (!cursor) cache.set(key, { at: Date.now(), thread });
    return thread;
  })().finally(() => inflight.delete(key));

  if (!cursor) inflight.set(key, task);
  return task;
}

export function reviewQuote(handle: string, target: TitleRef, score: number): RatingQuote {
  return {
    authorHandle: handle.trim(),
    itemKey: target.itemKey,
    mediaType: target.mediaType,
    score,
  };
}

/** Posts a reply straight to the reviewer's profile, quoting the review it answers. */
export async function replyToReview(
  handle: string,
  target: TitleRef,
  score: number,
  text: string,
): Promise<Comment> {
  const created = await postComment(
    handle,
    composeQuotedBody(reviewQuote(handle, target, score), text),
  );
  cache.delete(keyOf(handle, target));
  return created;
}
