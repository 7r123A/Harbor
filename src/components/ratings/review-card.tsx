import { useEffect, useState } from "react";
import { ChevronDown, Eye, Heart, Loader2, MessageSquare, Star } from "lucide-react";
import { RatingStars } from "@/components/ratings/rating-stars";
import { useT } from "@/lib/i18n";
import { cachedReviewCommentCount, loadReviewThread } from "@/lib/social/review-comments";
import { likeReview, unlikeReview } from "@/lib/social/review-reactions";
import type { TitleRating, TitleRef } from "@/lib/social/review-rank";
import { Avatar, timeAgo } from "@/views/profile/profile-bits";
import { UserHoverCard } from "@/views/profile/user-hover-card";
import { VerifiedBadge } from "@/views/account/verified-badge";
import { ReviewComments } from "./review-comments";

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
  const [like, setLike] = useState(review.reactions ?? { count: 0, mine: false });
  const [liking, setLiking] = useState(false);
  const [commentCount, setCommentCount] = useState<number | null>(() =>
    review.reviewId
      ? (review.comments?.count ?? null)
      : cachedReviewCommentCount(review.handle, target),
  );

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
  const long = text.length > LONG_REVIEW;
  const collapsed = long && !expanded;

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
              <span aria-hidden className="shrink-0 text-[11px] text-ink-subtle">
                ·
              </span>
              <span className="shrink-0 text-[11.5px] text-ink-subtle">{timeAgo(review.at)}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex h-6 items-center gap-1 rounded-full bg-canvas/70 px-2 text-[12px] font-bold tabular-nums text-ink ring-1 ring-inset ring-edge-soft">
                <Star size={11} className="fill-current text-accent" />
                {review.score}
                <span className="font-normal text-ink-subtle">/10</span>
              </span>
              <RatingStars value={review.score} readOnly size={12} />
            </div>
          </div>
        </header>

        {text && (
          <div className="relative mt-2.5">
            <p
              className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-muted ${
                collapsed ? "line-clamp-5" : ""
              } ${review.spoiler && !revealed ? "select-none blur-sm" : ""}`}
            >
              {text}
            </p>
            {review.spoiler && !revealed ? (
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-lg bg-canvas/40 text-[12px] font-semibold text-ink transition-colors hover:bg-canvas/20"
              >
                <Eye size={13} />
                {t("Show spoiler")}
              </button>
            ) : (
              long && (
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
              )
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-edge-soft/70 px-2.5 py-1.5">
        {review.reviewId && (
          <button
            type="button"
            disabled={liking}
            aria-pressed={like.mine}
            aria-label={t(like.mine ? "Remove like" : "Like this review")}
            onClick={() => {
              if (!review.reviewId || liking) return;
              setLiking(true);
              const run = like.mine ? unlikeReview(review.reviewId) : likeReview(review.reviewId);
              run
                .then((res) => setLike({ count: res.count, mine: res.reacted }))
                .catch(() => {
                  /* Undeployed backend or offline: the count stays as it was. */
                })
                .finally(() => setLiking(false));
            }}
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
            {like.count > 0 ? like.count : t("Like")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setThread((value) => !value)}
          aria-expanded={thread}
          aria-label={t("Comments")}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] tabular-nums text-ink-subtle transition-colors hover:bg-elevated/70 hover:text-ink-muted ${
            thread ? "text-ink" : ""
          }`}
        >
          <MessageSquare size={14} />
          {commentCount === null ? t("Comments") : commentCount}
        </button>
      </div>

      {thread && (
        <div className="border-t border-edge-soft/70 px-3.5 pb-3 pt-2">
          <ReviewComments
            handle={review.handle}
            target={target}
            score={review.score}
            reviewId={review.reviewId}
            onCount={setCommentCount}
          />
        </div>
      )}
    </article>
  );
}
