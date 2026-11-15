import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Heart, Loader2, MessageSquare, Search, Star, UserPlus,
  Users as UsersIcon, X } from "lucide-react";
import { ModalShell, useEscape, useModalExit } from "@/components/modal-shell";
import { useT } from "@/lib/i18n";
import { requestFriendship, friendRowState } from "@/lib/social/friend-request";
import type { FriendRowState } from "@/lib/social/friend-request";
import { fetchFriends, fetchPendingRequests } from "@/lib/social/friends";
import { likeReview, unlikeReview } from "@/lib/social/review-reactions";
import { socialGet } from "@/lib/social/client";
import { openDmConversation } from "@/lib/social/dm";
import { requestOpenDm } from "@/lib/social/dm-store";
import { requestOpenProfile } from "@/lib/social/open-profile";
import { profileMediaMeta } from "@/lib/social/profile-media-meta";
type ProfileCardLook = Record<string, unknown> | null | undefined;
import { fetchUserRatings } from "@/lib/social/ratings-api";
import type { PublicRating } from "@/lib/ratings/types";
import { currentAuthor } from "@/lib/theme-auth";
import { useView } from "@/lib/view";
import { Avatar, timeAgo } from "@/views/profile/profile-bits";
import { VerifiedBadge } from "@/views/account/verified-badge";

// The review-rich profile quick menu, used from a title's User Reviews list only.
// It is deliberately not a global replacement for opening a profile: everywhere else
// a username still navigates, because that is what people expect there.

type QuickSort = "recent" | "liked" | "commented" | "highest" | "lowest";

type QuickReview = {
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
  reactions: { count: number; viewerReacted: boolean };
  comments: { count: number };
};

type QuickProfile = {
  handle: string;
  alias: string;
  avatarUrl?: string;
  bannerUrl?: string;
  verified?: boolean;
  slogan?: string;
  description?: string;
  location?: string;
  level?: number;
  status?: string;
  online?: boolean;
  memberSince?: string;
  dmPolicy?: "everyone" | "friends";
  counts?: { watched?: number; friends?: number; badges?: number };
  profileCard?: ProfileCardLook;
};

type QuickResponse = {
  profile: QuickProfile | null;
  reviews: {
    items: QuickReview[];
    nextCursor?: string;
    total: number;
    sort: QuickSort;
  };
};

const PAGE = 12;
const SORTS: QuickSort[] = ["recent", "liked", "commented", "highest", "lowest"];

const SORT_LABEL: Record<QuickSort, string> = {
  recent: "Most recent",
  liked: "Most liked",
  commented: "Most commented",
  highest: "Highest rated",
  lowest: "Lowest rated",
};

/**
 * The bundled `/quick` route is new. Until a deployment carries it, the menu falls back
 * to the two public routes production already serves: the profile row and the person's
 * rating history. The latch mirrors `user-search.ts`: probe once per session, then stop
 * paying for a 404 on every open. The new route stays the primary path when present.
 */
let quickRouteAvailable = true;

function reviewFromRating(r: PublicRating): QuickReview {
  return {
    id: r.reviewId || `rating:${r.mediaType}:${r.itemKey}:${r.at}`,
    contentType: r.mediaType,
    contentId: r.itemKey,
    score: r.score,
    title: r.title,
    posterUrl: r.posterUrl,
    review: r.review,
    spoiler: r.spoiler,
    createdAt: r.at,
    updatedAt: r.at,
    reactions: { count: r.reactions?.count ?? 0, viewerReacted: r.reactions?.mine ?? false },
    comments: { count: r.comments?.count ?? 0 },
  };
}

/** The fallback has no engagement data, so those two sorts degrade to recency rather than lying. */
function sortQuickReviews(items: QuickReview[], sort: QuickSort): QuickReview[] {
  const list = items.slice();
  const recent = (a: QuickReview, b: QuickReview) =>
    Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt);
  if (sort === "highest" || sort === "lowest") {
    const dir = sort === "highest" ? -1 : 1;
    return list.sort((a, b) => (a.score === b.score ? recent(a, b) : dir * (a.score - b.score)));
  }
  return list.sort(recent);
}

const PRESENCE_DOT: Record<string, string> = {
  online: "bg-emerald-400",
  away: "bg-amber-400",
  dnd: "bg-rose-500",
  offline: "bg-ink-subtle",
};

function ReviewerReviewRow({
  review,
  onOpenTitle,
}: {
  review: QuickReview;
  onOpenTitle: (review: QuickReview) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [likes, setLikes] = useState(review.reactions?.count ?? 0);
  const [liked, setLiked] = useState(review.reactions?.viewerReacted === true);
  const [liking, setLiking] = useState(false);
  const text = review.review ?? "";
  const hidden = review.spoiler === true && !revealed;
  const long = text.length > 260;

  return (
    <article className="rounded-xl bg-elevated/40 p-3 ring-1 ring-edge-soft">
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={() => onOpenTitle(review)}
          aria-label={t("Open {title}", { title: review.title || review.contentId })}
          className="h-[72px] w-[50px] shrink-0 overflow-hidden rounded-md bg-canvas/70"
        >
          {review.posterUrl ? (
            <img
              src={review.posterUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              draggable={false}
            />
          ) : null}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpenTitle(review)}
              className="min-w-0 flex-1 truncate text-start text-[14px] font-semibold text-ink transition-colors hover:text-accent"
            >
              {review.title || review.contentId}
            </button>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-canvas/60 px-2 py-1 text-[12.5px] font-bold tabular-nums text-ink">
              <Star size={10} className="fill-current" />
              {review.score}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-subtle">
            <span>{timeAgo(review.updatedAt || review.createdAt)}</span>
            <span aria-hidden>·</span>
            <button
              type="button"
              aria-pressed={liked}
              aria-label={liked ? t("Unlike this review") : t("Like this review")}
              disabled={liking}
              onClick={async () => {
                const next = !liked;
                setLiking(true);
                setLiked(next);
                setLikes((n) => Math.max(0, n + (next ? 1 : -1)));
                try {
                  const result = next ? await likeReview(review.id) : await unlikeReview(review.id);
                  setLikes(result.count);
                  setLiked(result.reacted);
                } catch {
                  setLiked(!next);
                  setLikes(review.reactions?.count ?? 0);
                } finally {
                  setLiking(false);
                }
              }}
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors ${liked ? "text-accent" : "text-ink-subtle hover:text-ink"}`}
            >
              <Heart size={12} className={liked ? "fill-current" : undefined} /> {likes}
            </button>
            <button
              type="button"
              aria-label={t("Comments")}
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-ink-subtle transition-colors hover:text-ink"
            >
              <MessageSquare size={12} /> {review.comments?.count ?? 0}
            </button>
          </div>
          {text ? (
            hidden ? (
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="mt-1.5 rounded-md bg-canvas/60 px-2 py-1 text-[11.5px] font-medium text-ink-muted transition-colors hover:text-ink"
              >
                {t("Contains spoilers — show review")}
              </button>
            ) : (
              <p className="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-muted">
                {long && !expanded ? `${text.slice(0, 260)}…` : text}
                {long && (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="ms-1 text-[11.5px] font-semibold text-ink"
                  >
                    {expanded ? t("Less") : t("More")}
                  </button>
                )}
              </p>
            )
          ) : (
            <p className="mt-1.5 text-[11.5px] italic text-ink-subtle">{t("Rated without a written review")}</p>
          )}
        </div>
      </div>
    </article>
  );
}

export function ReviewerQuickMenu({
  handle,
  fallback,
  excludeContentType,
  excludeContentId,
  onClose,
}: {
  handle: string;
  /** What the review row already knows, shown until the profile arrives. */
  fallback?: { alias?: string; avatarUrl?: string };
  /** The title whose review list opened this menu, so "other reviews" means other. */
  excludeContentType?: string;
  excludeContentId?: string;
  onClose: () => void;
}) {
  const t = useT();
  const { openMeta } = useView();
  const { closing, close } = useModalExit(onClose);
  useEscape(close);
  const me = currentAuthor();

  const [profile, setProfile] = useState<QuickProfile | null>(null);
  const [items, setItems] = useState<QuickReview[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<QuickSort>("recent");
  const [query, setQuery] = useState("");
  const [withReview, setWithReview] = useState(false);
  const [friend, setFriend] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [friendship, setFriendship] = useState<FriendRowState>("idle");

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchFriends().catch(() => []), fetchPendingRequests().catch(() => [])]).then(([frs, pend]) => {
      if (!alive) return;
      setFriendship(
        friendRowState(handle, {
          self: me?.handle ?? null,
          friends: frs.map((f) => f.handle),
          pending: pend.map((r) => r.from.handle),
        }),
      );
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);
  const [debounced, setDebounced] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [paging, setPaging] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(!quickRouteAvailable);
  const requestId = useRef(0);
  const fallbackRatings = useRef<QuickReview[] | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(id);
  }, [query]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", String(PAGE));
    p.set("sort", sort);
    if (debounced) p.set("q", debounced);
    if (withReview) p.set("withReview", "1");
    if (excludeContentId) {
      p.set("excludeContentId", excludeContentId);
      if (excludeContentType) p.set("excludeContentType", excludeContentType);
    }
    return p.toString();
  }, [sort, debounced, withReview, excludeContentId, excludeContentType]);

  const loadFallback = useCallback(
    async (offset: number): Promise<QuickResponse> => {
      const profilePromise = socialGet<QuickProfile>(
        `/social/u/${encodeURIComponent(handle)}`,
      ).catch(() => null);
      if (!fallbackRatings.current) {
        const all: QuickReview[] = [];
        let ratingsCursor: string | undefined;
        // Five pages is 100 ratings: enough for a quick menu, bounded so opening a
        // prolific profile cannot walk an unlimited history.
        for (let page = 0; page < 5; page += 1) {
          const res = await fetchUserRatings(
            handle,
            ratingsCursor ? { cursor: ratingsCursor } : {},
          );
          for (const item of res.items ?? []) all.push(reviewFromRating(item));
          if (!res.nextCursor || res.nextCursor === ratingsCursor) break;
          ratingsCursor = res.nextCursor;
        }
        fallbackRatings.current = all;
      }
      const q = debounced.toLowerCase();
      const filtered = fallbackRatings.current.filter((review) => {
        const sameTitle =
          !!excludeContentId &&
          review.contentId === excludeContentId &&
          (!excludeContentType || review.contentType === excludeContentType);
        if (sameTitle) return false;
        if (!q) return true;
        return `${review.title || ""} ${review.review || ""} ${review.contentId}`
          .toLowerCase()
          .includes(q);
      });
      const sorted = sortQuickReviews(filtered, sort);
      const nextOffset = offset + PAGE;
      return {
        profile: (await profilePromise) as QuickProfile | null,
        reviews: {
          items: sorted.slice(offset, nextOffset),
          nextCursor: nextOffset < sorted.length ? `off:${nextOffset}` : undefined,
          total: sorted.length,
          sort,
        },
      };
    },
    [handle, debounced, sort, excludeContentId, excludeContentType],
  );

  const load = useCallback(
    (nextCursor?: string) => {
      const ticket = ++requestId.current;
      if (nextCursor) setPaging(true);
      else setState("loading");
      const offset = nextCursor?.startsWith("off:") ? Number(nextCursor.slice(4)) || 0 : 0;
      const run = quickRouteAvailable
        ? socialGet<QuickResponse>(
            `/social/u/${encodeURIComponent(handle)}/quick?${params}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}`,
          ).catch((error: unknown) => {
            const status = (error as { status?: number }).status;
            if (status !== 404 && status !== 405) throw error;
            quickRouteAvailable = false;
            setDegraded(true);
            return loadFallback(offset);
          })
        : loadFallback(offset);
      return run
        .then((data) => {
          if (ticket !== requestId.current) return;
          if (data.profile) setProfile(data.profile);
          setItems((cur) => (nextCursor ? [...cur, ...data.reviews.items] : data.reviews.items));
          setCursor(data.reviews.nextCursor);
          setTotal(data.reviews.total);
          setState("ready");
        })
        .catch(() => {
          if (ticket === requestId.current) setState("error");
        })
        .finally(() => {
          if (ticket === requestId.current) setPaging(false);
        });
    },
    [handle, params, loadFallback],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openTitle = (review: QuickReview) => {
    close();
    openMeta(
      profileMediaMeta(review.contentId, review.contentType, {
        name: review.title || review.contentId,
        poster: review.posterUrl,
      }),
    );
  };

  const message = () => {
    if (!profile || messaging) return;
    setMessaging(true);
    setMessageError(null);
    // The quick payload carries the handle, not the id; a conversation needs the id,
    // so it is asked for through the same route the profile hero uses rather than
    // guessed from the handle.
    socialGet<{ id: string }>(`/social/u/${encodeURIComponent(profile.handle)}`)
      .then((row) => openDmConversation(row.id))
      .then((conversation) => {
        close();
        requestOpenDm(conversation.id);
      })
      .catch((err: unknown) => {
        setMessageError(
          err instanceof Error && /friend/i.test(err.message)
            ? t("This account only accepts messages from friends.")
            : t("A conversation could not be started."),
        );
      })
      .finally(() => setMessaging(false));
  };

  const mine = !!me && (me.handle || "").toLowerCase() === handle.toLowerCase();
  const profileHandle = profile?.handle || handle;
  const openFullProfile = () => {
    close();
    requestOpenProfile(profileHandle);
  };
  const sortChoices = degraded
    ? SORTS.filter((s) => s !== "liked" && s !== "commented")
    : SORTS;

  return (
    <ModalShell closing={closing} onDismiss={close} width={560} labelledBy="reviewer-quick-title">
      <div className="relative flex max-h-[min(84vh,760px)] flex-col overflow-hidden">
        <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative h-24 w-full shrink-0 overflow-hidden bg-elevated">
          {profile?.bannerUrl ? (
            <img src={profile.bannerUrl} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <div className="h-full w-full bg-gradient-to-r from-elevated to-canvas" />
          )}
          <button
            type="button"
            onClick={close}
            aria-label={t("Close")}
            className="absolute end-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-canvas/70 text-ink transition-colors hover:bg-canvas"
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>

        <div className="relative shrink-0 px-4 pb-3">
          <div className="-mt-8 flex items-end gap-3">
            <button
              type="button"
              onClick={openFullProfile}
              aria-label={t("Open full profile")}
              className="shrink-0 rounded-full transition-transform enabled:hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Avatar src={profile?.avatarUrl ?? fallback?.avatarUrl} size={64} alias={profile?.alias || fallback?.alias || handle} />
            </button>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={openFullProfile}
                  className="min-w-0 truncate text-start text-[17.5px] font-semibold text-ink transition-colors hover:text-accent"
                >
                  <span id="reviewer-quick-title">{profile?.alias || fallback?.alias || handle}</span>
                </button>
                {profile?.verified && <VerifiedBadge size="sm" />}
                {friendship === "friends" && (
                  <span
                    title={t("Your friend")}
                    aria-label={t("Your friend")}
                    className="shrink-0 text-ink-subtle"
                  >
                    <UsersIcon size={13} strokeWidth={2.2} />
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[13px] text-ink-subtle">
                <span className={`h-2 w-2 rounded-full ${PRESENCE_DOT[profile?.status || "offline"] || PRESENCE_DOT.offline}`} />
                <span className="truncate">@{profile?.handle || handle}</span>
                {profile?.level ? <span className="shrink-0">· {t("Level {n}", { n: profile.level })}</span> : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 pb-1">
              {!mine && (
              <span className="inline-flex" title={friendship === "friends" ? t("This user is your friend.") : friendship === "requested" ? t("Friend request pending") : undefined}>
                <button
                  type="button"
                  onClick={async () => {
                    setFriend("sending");
                    try {
                      const result = await requestFriendship(profile?.handle || handle);
                      setFriend(result === "requested" ? "sent" : "error");
                    } catch {
                      setFriend("error");
                    }
                  }}
                  disabled={friendship === "friends" || friendship === "requested" || friend === "sending" || friend === "sent"}
                  aria-label={t("Add friend")}
                  title={undefined}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${friendship === "friends" ? "cursor-default bg-elevated/30 text-ink-subtle opacity-55" : "bg-elevated/60 text-ink-muted hover:text-ink"}`}
                >
                  {friend === "sending" ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} strokeWidth={2.2} />}
                </button>
                </span>
              )}
              {!mine && (
                <button
                  type="button"
                  onClick={message}
                  disabled={messaging}
                  className="flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[12px] font-semibold text-canvas transition-transform enabled:hover:scale-[1.02] disabled:opacity-60"
                >
                  {messaging ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />}
                  {t("Message")}
                </button>
              )}
            </div>
          </div>
          {profile?.slogan && <p className="mt-2 line-clamp-1 text-[12.5px] text-ink-muted">{profile.slogan}</p>}
          {messageError && <p className="mt-1 text-[11.5px] text-ink-muted">{messageError}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-2 px-4">
          <div className="relative flex-1">
            <Search size={14} strokeWidth={2.2} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Search their reviews")}
              className="h-8 w-full rounded-full bg-elevated/60 ps-8 pe-3 text-[12.5px] text-ink outline-none placeholder:text-ink-subtle focus:ring-1 focus:ring-inset focus:ring-accent/40"
            />
          </div>
                    <button
            type="button"
            onClick={() => setWithReview((v) => !v)}
            aria-pressed={withReview}
            title={t("Only ratings that include a written review")}
            className={`h-8 shrink-0 rounded-full px-2.5 text-[12px] font-medium transition-colors ${withReview ? "bg-ink text-canvas" : "bg-elevated/60 text-ink-muted hover:text-ink"}`}
          >
            {t("With review")}
          </button>
<select
            value={sort}
            onChange={(e) => setSort(e.target.value as QuickSort)}
            aria-label={t("Sort reviews")}
            className="h-8 rounded-full bg-elevated/60 px-2 text-[12px] text-ink-muted outline-none"
          >
            {sortChoices.map((s) => (
              <option key={s} value={s}>
                {t(SORT_LABEL[s])}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-2 flex-1 overflow-y-auto px-4 pb-4">
          <div className="mb-2 flex items-center justify-between text-[11.5px] uppercase tracking-wider text-ink-subtle">
            <span>{t("Other reviews")}</span>
            {state === "ready" && <span className="tabular-nums">{total}</span>}
          </div>

          {state === "loading" && (
            <div className="flex items-center justify-center py-10 text-ink-subtle">
              <Loader2 size={16} className="animate-spin" />
            </div>
          )}
          {state === "error" && (
            <button
              type="button"
              onClick={() => void load()}
              className="w-full rounded-lg bg-elevated/50 py-3 text-[12.5px] text-ink-muted transition-colors hover:text-ink"
            >
              {t("Reviews could not be loaded. Retry")}
            </button>
          )}
          {state === "ready" && !items.length && (
            <p className="py-8 text-center text-[12.5px] text-ink-muted">
              {debounced ? t("No reviews match that search.") : t("No other reviews yet.")}
            </p>
          )}
          <div className="flex flex-col gap-2.5">
            {items.map((review) => (
              <ReviewerReviewRow key={review.id} review={review} onOpenTitle={openTitle} />
            ))}
          </div>
          {state === "ready" && cursor && (
            <button
              type="button"
              onClick={() => void load(cursor)}
              disabled={paging}
              className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-elevated/50 text-[12.5px] font-medium text-ink-muted transition-colors enabled:hover:text-ink"
            >
              {paging && <Loader2 size={13} className="animate-spin" />}
              {t("Load more")}
            </button>
          )}
        </div>
        </div>
      </div>
    </ModalShell>
  );
}
