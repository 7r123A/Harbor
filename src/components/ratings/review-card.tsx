import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Heart, Loader2, MessageSquare, Star } from "lucide-react";
import { useT } from "@/lib/i18n";
import { findQuickReviewId } from "@/lib/social/quick-reviews";
import { cachedReviewCommentCount, loadReviewThread } from "@/lib/social/review-comments";
import { likeReview, unlikeReview } from "@/lib/social/review-reactions";
import { useReviewEngagement } from "@/lib/social/review-engagement";
import { MutualMatchLabel } from "./mutual-match-badge";
import { ReviewSpoiler } from "./review-spoiler";
import type { TitleRating, TitleRef } from "@/lib/social/review-rank";
import { Avatar, timeAgo } from "@/views/profile/profile-bits";
import { UserHoverCard } from "@/views/profile/user-hover-card";
import { VerifiedBadge } from "@/views/account/verified-badge";
import { ReviewComments } from "./review-comments";
import { RatingStars } from "./rating-stars";

const LONG_REVIEW = 320;

/**
 * One person's review of the title being viewed. The hierarchy is author → score → text →
 * engagement, so a long list stays scannable; everything interactive keeps its accessible
 * button and the comment thread opens inline rather than navigating away.
 */
export function ReviewCard({
  review,
  target,
  prefetchComments = false,
  onOpenAuthor,
}: {
  review: TitleRating;
  target: TitleRef;
  /** Loading the thread early is what puts a real comment count on the button. */
  prefetchComments?: boolean;
  onOpenAuthor: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [thread, setThread] = useState(false);
  const [liking, setLiking] = useState(false);
  const [resolvedReviewId, setResolvedReviewId] = useState<string>();
  const id = review.reviewId ?? resolvedReviewId;
  const { value: engagement, update } = useReviewEngagement(id);
  const like = engagement.like ?? review.reactions ?? { count: 0, mine: false };
  const [likeError, setLikeError] = useState<"auth" | "request" | null>(null);
  const [commentCount, setCommentCount] = useState<number | null>(() =>
    review.reviewId
      ? (review.comments?.count ?? null)
      : cachedReviewCommentCount(review.handle, target),
  );
  const visibleCount = engagement.comments ?? commentCount;
  const onCommentCount = useCallback(
    (count: number) => {
      setCommentCount(count);
      if (id) update({ comments: count });
    },
    [id, update],
  );
  const [openingThread, setOpeningThread] = useState(false);

  useEffect(() => {
    // A hub review has its own thread; only the legacy profile-quote thread needs a prefetch.
    if (!prefetchComments || review.reviewId || commentCount !== null) return;
    let live = true;
    loadReviewThread(review.handle, target)
      .then((result) => {
        if (live) setCommentCount(result.comments.length);
      })
      .catch(() => {
        /* The button still works; the count appears once the thread is opened. */
      });
    return () => {
      live = false;
    };
  }, [prefetchComments, commentCount, review.handle, review.reviewId, target]);

  const text = review.review ?? "";
  const spoilerHidden = review.spoiler === true && !revealed;
  const long = text.length > LONG_REVIEW;
  const collapsed = long && !expanded;

  async function toggleLike() {
    if (liking) return;
    setLiking(true);
    setLikeError(null);
    try {
      const reviewId = id ?? (await findQuickReviewId(review.handle, target));
      if (!reviewId) {
        setLikeError("request");
        return;
      }
      setResolvedReviewId(reviewId);
      const result = await (like.mine ? unlikeReview(reviewId) : likeReview(reviewId));
      update({ like: { count: result.count, mine: result.reacted } }, reviewId);
    } catch (error) {
      setLikeError((error as { status?: number }).status === 401 ? "auth" : "request");
    } finally {
      setLiking(false);
    }
  }

  async function toggleThread() {
    if (thread || id) {
      setThread(!thread);
      return;
    }
    setOpeningThread(true);
    try {
      setResolvedReviewId(await findQuickReviewId(review.handle, target));
    } catch {
      // Keep the profile-quote thread available on servers that lack the review hub.
    } finally {
      setOpeningThread(false);
      setThread(true);
    }
  }

  return (
    <article className="group overflow-hidden rounded-2xl bg-elevated/35 ring-1 ring-edge-soft transition-colors duration-150 hover:bg-elevated/50">
      <div className="p-3.5">
        <header className="flex items-start gap-3">
          <UserHoverCard handle={review.handle}>
            <button
              type="button"
              onClick={onOpenAuthor}
              aria-label={t("Open {alias} profile", { alias: review.alias })}
              className="shrink-0 rounded-full transition-transform enabled:hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Avatar src={review.avatarUrl} size={38} alias={review.alias} />
            </button>
          </UserHoverCard>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <UserHoverCard handle={review.handle}>
                <button
                  type="button"
                  onClick={onOpenAuthor}
                  className="min-w-0 truncate text-[13.5px] font-semibold text-ink transition-colors hover:text-accent"
                >
                  {review.alias}
                </button>
              </UserHoverCard>
              {review.verified && <VerifiedBadge size="sm" />}
              <span className="shrink-0 text-[11.5px] text-ink-subtle">@{review.handle}</span>
              <MutualMatchLabel match={review.match} />
              <span aria-hidden className="shrink-0 text-[11px] text-ink-subtle">
                ·
              </span>
              <span className="shrink-0 text-[11.5px] text-ink-subtle">{timeAgo(review.at)}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex h-6 items-center rounded-full bg-canvas/70 px-2 text-[12px] font-bold tabular-nums text-ink ring-1 ring-inset ring-edge-soft">
                <Star size={11} className="me-1 fill-current text-amber-400" />
                {review.score}
                <span className="font-normal text-ink-subtle">/10</span>
              </span>
              <RatingStars value={review.score} readOnly size={12} />
            </div>
          </div>
        </header>

        {text && (
          <div className="relative mt-2.5">
            <ReviewSpoiler hidden={spoilerHidden} onReveal={() => setRevealed(true)}>
              <p
                className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-muted ${
                  collapsed ? "line-clamp-5" : ""
                }`}
              >
                {text}
              </p>
            </ReviewSpoiler>
            {!spoilerHidden && long && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-ink-subtle transition-colors hover:text-ink"
              >
                <ChevronDown
                  size={13}
                  className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                />
                {expanded ? t("Show less") : t("Read more")}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-edge-soft/70 px-2.5 py-1.5">
        <button
          type="button"
          disabled={liking}
          aria-pressed={like.mine}
          aria-label={t(like.mine ? "Remove like" : "Like this review")}
          onClick={toggleLike}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-semibold tabular-nums transition-colors ${
            like.mine
              ? "bg-accent/15 text-accent"
              : "text-ink-subtle hover:bg-elevated/70 hover:text-ink-muted"
          }`}
        >
          {liking ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Heart size={14} className={like.mine ? "fill-current" : ""} />
          )}
          {like.count > 0 ? like.count : null}
        </button>
        <button
          type="button"
          onClick={toggleThread}
          disabled={openingThread}
          aria-expanded={thread}
          aria-label={t("Comments")}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] tabular-nums text-ink-subtle transition-colors hover:bg-elevated/70 hover:text-ink-muted ${
            thread ? "text-ink" : ""
          }`}
        >
          <MessageSquare size={14} />
          {visibleCount === null ? t("Comments") : visibleCount}
        </button>
      </div>

      {likeError && (
        <p role="status" className="px-3.5 pb-2 text-[12px] text-ink-muted">
          {likeError === "auth" ? t("Sign in to like reviews.") : t("Could not update this like.")}
        </p>
      )}

      {thread && (
        <div className="border-t border-edge-soft/70 px-3.5 pb-3 pt-2">
          <ReviewComments
            handle={review.handle}
            target={target}
            score={review.score}
            reviewId={id}
            onCount={onCommentCount}
          />
        </div>
      )}
    </article>
  );
}
