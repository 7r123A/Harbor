import type { PublicRating, RatingMediaType } from "@/lib/ratings/types";
import { currentAuthor } from "@/lib/theme-auth";
import { fetchFriends, type Friend } from "./friends";
import { fetchUserRatings } from "./ratings-api";
import { socialGet } from "./client";
import {
  foldHandle,
  mergeTitleRatings,
  pickTitleRating,
  titleRatingFrom,
  type TitleRating,
  type TitleRef,
} from "./review-rank";
import { loadUserDirectory } from "./user-directory";

/**
 * Harbor now publishes a review hub at GET /social/reviews, which filters by title on the
 * server. It is the primary read path: one paginated request instead of one history scan per
 * person. Older deployments answer 404, so the history scan below remains the fallback and
 * the panel is never worse than it was before the route existed.
 */
const HUB_PAGE = 50;
const HUB_PAGE_CAP = 6;

type HubReview = {
  id: string;
  contentType: string;
  contentId: string;
  score: number;
  title?: string;
  posterUrl?: string;
  review?: string;
  spoiler?: boolean;
  createdAt: string;
  updatedAt: string;
  author: { handle: string; displayName?: string; avatarUrl?: string; verified?: boolean } | null;
  reactions?: { count: number; viewerReacted?: boolean };
  comments?: { count: number };
};

let hubAvailable = true;

function ratingFromHub(item: HubReview): TitleRating | null {
  const author = item.author;
  if (!author?.handle || !Number.isFinite(item.score)) return null;
  return {
    handle: author.handle,
    alias: author.displayName || author.handle,
    avatarUrl: author.avatarUrl || undefined,
    verified: author.verified || undefined,
    itemKey: item.contentId,
    mediaType: item.contentType as RatingMediaType,
    score: item.score,
    review: item.review?.trim() || undefined,
    spoiler: item.spoiler || undefined,
    at: item.updatedAt || item.createdAt,
    reviewId: item.id,
    reactions: item.reactions
      ? { count: item.reactions.count || 0, mine: item.reactions.viewerReacted === true }
      : undefined,
    comments: item.comments ? { count: item.comments.count || 0 } : undefined,
  };
}

/**
 * One server-side read of a title's reviews. Returns null when this deployment has no
 * review hub so the caller can use the history scan; refuses to silently hide a real
 * failure of a route that does exist.
 */
async function loadHubTitleRatings(
  target: TitleRef,
  scope: "friends" | "all",
  selfHandle: string | undefined,
  signedOut: boolean,
): Promise<TitleRatingsSnapshot | null> {
  if (!hubAvailable) return null;
  const ratings: TitleRating[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < HUB_PAGE_CAP; page += 1) {
    const query = new URLSearchParams({
      contentType: target.mediaType,
      contentId: target.itemKey,
      scope,
      sort: "newest",
      limit: String(HUB_PAGE),
    });
    if (cursor) query.set("cursor", cursor);
    let data: { items?: HubReview[]; nextCursor?: string };
    try {
      data = await socialGet<{ items?: HubReview[]; nextCursor?: string }>(
        `/social/reviews?${query.toString()}`,
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 405) {
        hubAvailable = false;
        return null;
      }
      throw error;
    }
    for (const item of data.items ?? []) {
      const rating = ratingFromHub(item);
      if (rating) ratings.push(rating);
    }
    complete = !data.nextCursor || data.nextCursor === cursor;
    if (complete) break;
    cursor = data.nextCursor;
  }
  return {
    ratings: mergeTitleRatings(ratings, target, selfHandle),
    complete,
    scanned: ratings.length,
    signedOut,
    source: "hub",
  };
}

/**
 * Harbor's older social API has no per-title review route: GET /social/ratings,
 * /social/ratings/{itemKey} and /social/u/{handle}/ratings/{itemKey} answer 404. On those
 * deployments reviews are only readable through a person's public rating history
 * (GET /social/u/{handle}/ratings), so a title's reviews are assembled from the people this
 * client can enumerate: your friends, and for Everyone the public community graph the app
 * can already see.
 */
/** People whose history is scanned for one title. Ratings are cached, so this is not per render. */
const FRIEND_CAP = 48;
const COMMUNITY_CAP = 40;
/** Recent pages of a person's history (20 ratings each) before we stop looking for a title. */
const PAGE_CAP = 3;
const CONCURRENCY = 4;
const CACHE_TTL = 5 * 60_000;

type AuthorMeta = {
  handle: string;
  alias?: string;
  avatarUrl?: string;
  verified?: boolean;
};

type AuthorHistory = { items: PublicRating[]; complete: boolean };

const historyCache = new Map<string, { at: number; history: AuthorHistory }>();
const historyInflight = new Map<string, Promise<AuthorHistory>>();

function historyKey(handle: string, mediaType: RatingMediaType): string {
  return `${mediaType}|${foldHandle(handle)}`;
}

function toAuthorMeta(friend: Friend | { handle: string; alias?: string; avatarUrl?: string; verified?: boolean }): AuthorMeta {
  return {
    handle: friend.handle,
    alias: "alias" in friend ? friend.alias : undefined,
    avatarUrl: "avatarUrl" in friend ? friend.avatarUrl : undefined,
    verified: "verified" in friend ? friend.verified : undefined,
  };
}

/**
 * The newest pages of one person's history for one media type. Requesting the type from the
 * server keeps a film from ever being confused with an anime that shares an id, and keeps the
 * scan small.
 */
async function scanHistory(handle: string, mediaType: RatingMediaType): Promise<AuthorHistory> {
  const key = historyKey(handle, mediaType);
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.history;
  const running = historyInflight.get(key);
  if (running) return running;

  const task = (async (): Promise<AuthorHistory> => {
    const items: PublicRating[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < PAGE_CAP; page += 1) {
      try {
        const result = await fetchUserRatings(
          handle,
          cursor ? { type: mediaType, cursor } : { type: mediaType },
        );
        for (const item of result.items ?? []) {
          if (seen.has(item.itemKey)) continue;
          seen.add(item.itemKey);
          items.push(item);
        }
        if (!result.nextCursor || result.nextCursor === cursor) {
          complete = true;
          break;
        }
        cursor = result.nextCursor;
      } catch (error) {
        // A refused history is final; a flaky page is retried the next time the panel opens.
        const status = (error as { status?: number }).status;
        if (status === 403 || status === 404) complete = true;
        break;
      }
    }
    const history = { items, complete };
    if (items.length || complete) historyCache.set(key, { at: Date.now(), history });
    return history;
  })().finally(() => historyInflight.delete(key));

  historyInflight.set(key, task);
  return task;
}

async function scanAuthors(
  authors: readonly AuthorMeta[],
  target: TitleRef,
): Promise<{ ratings: TitleRating[]; complete: boolean }> {
  const ratings: TitleRating[] = [];
  let complete = true;
  for (let i = 0; i < authors.length; i += CONCURRENCY) {
    const slice = authors.slice(i, i + CONCURRENCY);
    const scans = await Promise.all(
      slice.map(async (author) => ({
        author,
        history: await scanHistory(author.handle, target.mediaType),
      })),
    );
    for (const { author, history } of scans) {
      if (!history.complete) complete = false;
      const raw = pickTitleRating(history.items, target);
      const rating = raw ? titleRatingFrom(raw, author) : null;
      if (rating) ratings.push(rating);
    }
  }
  return { ratings, complete };
}

export type TitleRatingsSnapshot = {
  ratings: TitleRating[];
  /** False when a history or the author list was cut short, so a review may still be missing. */
  complete: boolean;
  scanned: number;
  /** The viewer has no Harbor account, so there is no friend list to read. */
  signedOut: boolean;
  /** "hub" is the server-side review list; "scan" is the older per-profile fallback. */
  source?: "hub" | "scan";
};

/** Friends' ratings of one title, which is what the avatar stack and the Friends tab show. */
export async function loadFriendTitleRatings(target: TitleRef): Promise<TitleRatingsSnapshot> {
  const self = currentAuthor();
  if (!self?.handle) return { ratings: [], complete: true, scanned: 0, signedOut: true };

  const hub = await loadHubTitleRatings(target, "friends", self.handle, false);
  if (hub) return hub;

  let friends: Friend[];
  try {
    friends = await fetchFriends();
  } catch (error) {
    const status = (error as { status?: number }).status;
    return { ratings: [], complete: status !== 401, scanned: 0, signedOut: status === 401 };
  }

  const authors = friends.slice(0, FRIEND_CAP).map(toAuthorMeta);
  const { ratings, complete } = await scanAuthors(authors, target);
  return {
    ratings: mergeTitleRatings(ratings, target, self.handle),
    complete: complete && friends.length <= FRIEND_CAP,
    scanned: authors.length,
    signedOut: false,
    source: "scan",
  };
}

/**
 * Everyone: your friends plus the public community graph. This is deliberately loaded only when
 * the Everyone tab is opened, because it costs one history scan per person.
 */
export async function loadCommunityTitleRatings(
  target: TitleRef,
): Promise<TitleRatingsSnapshot> {
  const self = currentAuthor();
  const hub = await loadHubTitleRatings(target, "all", self?.handle ?? undefined, !self?.handle);
  if (hub) return hub;

  const authors = new Map<string, AuthorMeta>();
  const add = (meta: AuthorMeta) => {
    const key = foldHandle(meta.handle);
    if (!key) return;
    const existing = authors.get(key);
    if (!existing) {
      authors.set(key, { ...meta });
      return;
    }
    if (!existing.avatarUrl && meta.avatarUrl) existing.avatarUrl = meta.avatarUrl;
    if (!existing.alias && meta.alias) existing.alias = meta.alias;
  };

  let signedOut = !self?.handle;
  if (self?.handle) {
    try {
      for (const friend of await fetchFriends()) add(toAuthorMeta(friend));
    } catch (error) {
      if ((error as { status?: number }).status === 401) signedOut = true;
    }
  }

  let truncated = false;
  try {
    const directory = await loadUserDirectory();
    for (const user of directory.users) {
      add({
        handle: user.handle,
        alias: user.alias,
        avatarUrl: user.avatarUrl,
        verified: user.verified,
      });
    }
    truncated = directory.truncated;
  } catch {
    truncated = true;
  }

  const pool = [...authors.values()].slice(0, COMMUNITY_CAP);
  const { ratings, complete } = await scanAuthors(pool, target);
  return {
    ratings: mergeTitleRatings(ratings, target, self?.handle),
    complete: complete && !truncated && authors.size <= COMMUNITY_CAP,
    scanned: pool.length,
    signedOut,
    source: "scan",
  };
}

/** Drops every cached history, so the next open reflects ratings changed elsewhere. */
export function invalidateTitleReviewCaches(): void {
  historyCache.clear();
}
