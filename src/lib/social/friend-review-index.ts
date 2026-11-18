import { useEffect, useState } from "react";
import { authToken, currentAuthor } from "@/lib/theme-auth";
import { socialPost } from "./client";
import { fetchFriends, type Friend } from "./friends";
import { fetchUserRatings } from "./ratings-api";
import { foldHandle } from "./review-rank";

/**
 * Poster badges need "which friends rated this title" for every card without a request per card.
 * Harbor has no per-title review route, but every rating is readable in its author's public
 * history, so one bounded scan of the viewer's friends builds an index every card looks up. The
 * friends feed is not the source: it only lists activity friends chose to share, so a rating that
 * shows up in someone's history can be missing there.
 */
export type FriendReviewMark = {
  handle: string;
  alias: string;
  avatarUrl?: string;
  at: number;
  totalCount?: number;
};
export type FriendReviewIndex = Map<string, FriendReviewMark[]>;

/** Friends scanned, and how many recent history pages (20 ratings each) per friend. */
const FRIEND_CAP = 40;
const PAGE_CAP = 3;
const CONCURRENCY = 4;
const CACHE_TTL = 5 * 60_000;
const MAX_MARKS = 12;
/** Re-rendering every mounted badge per finished batch would be wasteful on long rails. */
const PUBLISH_INTERVAL = 1200;

let index: FriendReviewIndex = new Map();
const averageScores = new Map<string, number | null>();
let builtAt = 0;
let running = 0;
let inflight: Promise<FriendReviewIndex> | null = null;
let lastPublish = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function publish(force = false): void {
  const now = Date.now();
  if (!force && now - lastPublish < PUBLISH_INTERVAL) return;
  lastPublish = now;
  notify();
}

/** A title is identified by its media type and item key, not the key alone. */
export function markKeyForItem(mediaType: string, itemKey: string): string {
  return `${mediaType.trim()}|${itemKey.trim()}`;
}

function addMark(
  out: FriendReviewIndex,
  mediaType: string,
  itemKey: string,
  mark: FriendReviewMark,
): void {
  const key = markKeyForItem(mediaType, itemKey);
  const handle = mark.handle.trim();
  if (!key || !handle) return;
  const list = out.get(key) ?? [];
  const folded = foldHandle(handle);
  if (list.some((existing) => foldHandle(existing.handle) === folded)) return;
  if (list.length >= MAX_MARKS) return;
  list.push({ ...mark, handle });
  list.sort((a, b) => b.at - a.at);
  out.set(key, list);
}

async function scanFriend(friend: Friend, out: FriendReviewIndex): Promise<void> {
  const base = {
    handle: friend.handle,
    alias: friend.alias || friend.handle,
    avatarUrl: friend.avatarUrl,
  };
  let cursor: string | undefined;
  for (let page = 0; page < PAGE_CAP; page += 1) {
    try {
      const result = await fetchUserRatings(friend.handle, cursor ? { cursor } : {});
      for (const rating of result.items ?? []) {
        if (!rating?.itemKey || typeof rating.score !== "number") continue;
        const at = Date.parse(rating.at);
        addMark(out, rating.mediaType, rating.itemKey, {
          ...base,
          at: Number.isFinite(at) ? at : 0,
        });
      }
      if (!result.nextCursor || result.nextCursor === cursor) return;
      cursor = result.nextCursor;
    } catch {
      // A refused or flaky history contributes nothing; the rest of the index still stands.
      return;
    }
  }
}

async function build(): Promise<FriendReviewIndex> {
  const out: FriendReviewIndex = new Map();
  if (!authToken()) return out;

  let friends: Friend[];
  try {
    friends = await fetchFriends();
  } catch {
    return out;
  }

  const me = foldHandle(currentAuthor()?.handle ?? "");
  const targets = friends
    .filter((friend) => friend.handle && foldHandle(friend.handle) !== me)
    .slice(0, FRIEND_CAP);

  const ticket = ++running;
  index = out;
  publish(true);

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (ticket !== running) break;
    await Promise.all(targets.slice(i, i + CONCURRENCY).map((f) => scanFriend(f, out)));
    if (ticket !== running) break;
    publish();
  }
  return out;
}

function snapshotIndex(): FriendReviewIndex | null {
  if (builtAt && Date.now() - builtAt > CACHE_TTL) return null;
  return index.size > 0 ? index : null;
}

export function cachedFriendReviewIndex(): FriendReviewIndex | null {
  return snapshotIndex();
}

export function subscribeFriendReviewIndex(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function loadFriendReviewIndex(force = false): Promise<FriendReviewIndex> {
  if (!force) {
    const hit = snapshotIndex();
    if (hit) return hit;
  }
  if (inflight) return inflight;

  inflight = build()
    .then((next) => {
      index = next;
      builtAt = Date.now();
      publish(true);
      return next;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Null until the first batch of friends has been scanned (or when nobody is signed in). */
export function useFriendReviewIndex(): FriendReviewIndex | null {
  const [snapshot, setSnapshot] = useState<FriendReviewIndex | null>(snapshotIndex);

  useEffect(() => {
    let live = true;
    const sync = () => {
      if (live) setSnapshot(snapshotIndex());
    };
    const off = subscribeFriendReviewIndex(sync);
    void loadFriendReviewIndex()
      .then(sync)
      .catch(() => {
        /* A failed scan simply leaves posters without overlays. */
      });
    return () => {
      live = false;
      off();
    };
  }, []);

  return snapshot;
}

export function useTitleAverageScore(mediaType: string, itemKey: string): number | null {
  const key = markKeyForItem(mediaType, itemKey);
  const [snapshot, setSnapshot] = useState<{ key: string; score: number | null }>(() => ({
    key,
    score: averageScores.get(key) ?? null,
  }));
  useEffect(() => {
    const sync = () => setSnapshot({ key, score: averageScores.get(key) ?? null });
    const off = subscribeFriendReviewIndex(sync);
    sync();
    return off;
  }, [key]);
  return snapshot.key === key ? snapshot.score : (averageScores.get(key) ?? null);
}

/**
 * Authoritative path: ask the review hub which friends reviewed this exact title.
 * The bounded friend-history scan above is a best-effort warm-up and, by construction,
 * misses any title outside its window; this call is per visible card and batched, so a
 * rail of posters costs one request instead of a full history sweep.
 */
const summaryPending = new Map<string, { contentType: string; contentId: string }>();
let summaryTimer: number | null = null;
const SUMMARIES_MAX = 50;

export function ensureMarksForTitle(contentType: string, contentId: string): void {
  if (!contentType || !contentId) return;
  summaryPending.set(contentType + "\u0000" + contentId, { contentType, contentId });
  if (summaryTimer !== null) return;
  summaryTimer = window.setTimeout(() => {
    summaryTimer = null;
    void flushSummaryBatch();
  }, 40);
}

async function flushSummaryBatch(): Promise<void> {
  const batch = [...summaryPending.values()].slice(0, SUMMARIES_MAX);
  for (const item of batch) summaryPending.delete(item.contentType + "\u0000" + item.contentId);
  if (!batch.length) return;
  try {
    const res = await socialPost<{
      items: Array<{
        contentType: string;
        contentId: string;
        friendsCount: number;
        averageScore?: number | null;
        friends: Array<{ handle: string; displayName: string; avatarUrl?: string }>;
      }>;
    }>("/social/reviews/summaries", { items: batch });
    const next = new Map(index);
    for (const row of res.items ?? []) {
      const key = markKeyForItem(row.contentType, row.contentId);
      averageScores.set(
        key,
        typeof row.averageScore === "number" &&
          Number.isFinite(row.averageScore) &&
          row.averageScore >= 0 &&
          row.averageScore <= 10
          ? row.averageScore
          : null,
      );
      const marks: FriendReviewMark[] = (row.friends ?? []).slice(0, MAX_MARKS).map((f) => ({
        handle: f.handle,
        alias: f.displayName || f.handle,
        avatarUrl: f.avatarUrl,
        at: 0,
        totalCount: row.friendsCount,
      }));
      if (marks.length) next.set(key, marks);
      else next.delete(key);
    }
    index = next;
    publish(true);
  } catch {
    /* The scan may still fill these in; a failure here just leaves the badge absent. */
  } finally {
    if (summaryPending.size) {
      summaryTimer = window.setTimeout(() => {
        summaryTimer = null;
        void flushSummaryBatch();
      }, 40);
    }
  }
}
