import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { authToken } from "@/lib/theme-auth";
import { parseQuotedBody, ratingQuoteLength } from "@/lib/ratings/quote";
import type { Comment } from "@/views/profile/profile-types";
import { CommentCompose } from "@/views/profile/comment-compose";
import { Avatar, timeAgo } from "@/views/profile/profile-bits";
import { UserHoverCard } from "@/views/profile/user-hover-card";
import { requestOpenProfile } from "@/lib/social/open-profile";
import {
  COMMENT_MAX,
  segmentProfanity,
  stripUrls,
  validateComment,
  type ComposeIssue,
} from "@/views/profile/text-safety";
import { loadReviewThread, replyToReview, reviewQuote } from "@/lib/social/review-comments";
import {
  createReviewComment,
  loadReviewCommentPage,
  type ReviewCommentApiRow,
} from "@/lib/social/review-comment-api";
import type { TitleRef } from "@/lib/social/review-rank";

function fromReviewComment(row: ReviewCommentApiRow): Comment {
  const handle = row.author?.handle || "?";
  return {
    id: row.id,
    body: row.body,
    at: row.at,
    edited: row.edited,
    authorHandle: handle,
    authorAlias: row.author?.displayName || handle,
    authorAvatarUrl: row.author?.avatarUrl,
    authorVerified: row.author?.verified,
  };
}

function Body({ text }: { text: string }) {
  const t = useT();
  return (
    <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-muted">
      {segmentProfanity(text).map((segment, index) =>
        segment.masked ? (
          <span
            key={index}
            title={t("Hidden language")}
            className="cursor-default rounded-[4px] bg-elevated px-1 blur-[5px] transition-[filter] duration-150 hover:blur-0"
          >
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

/**
 * The discussion under one review. Replies are stored as profile comments that quote the rated
 * title, so this thread and the reviewer's profile show the same conversation.
 */
export function ReviewComments({
  handle,
  target,
  score,
  onCount,
  reviewId,
}: {
  handle: string;
  target: TitleRef;
  score: number;
  onCount?: (count: number) => void;
  reviewId?: string;
}) {
  const t = useT();
  const signedIn = !!authToken();
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [comments, setComments] = useState<Comment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [serverCount, setServerCount] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let live = true;
    setState("loading");
    (reviewId
      ? loadReviewCommentPage(reviewId).then((page) => ({
          comments: (page.comments ?? []).map(fromReviewComment),
          nextCursor: page.nextCursor,
          total: page.total,
        }))
      : loadReviewThread(handle, target)
    )
      .then((thread) => {
        if (!live) return;
        setComments(thread.comments);
        setNextCursor(thread.nextCursor);
        setServerCount("total" in thread ? thread.total : null);
        setState(thread.comments.length ? "ready" : "empty");
      })
      .catch(() => {
        if (live) setState("error");
      });
    return () => {
      live = false;
    };
  }, [handle, target, reviewId]);

  useEffect(() => {
    onCount?.(reviewId ? (serverCount ?? comments.length) : comments.length);
  }, [comments.length, onCount, reviewId, serverCount]);

  const more = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadError("");
    try {
      const thread = reviewId
        ? await loadReviewCommentPage(reviewId, nextCursor).then((page) => ({
            comments: (page.comments ?? []).map(fromReviewComment),
            nextCursor: page.nextCursor,
          }))
        : await loadReviewThread(handle, target, nextCursor);
      setComments((cur) => [...cur, ...thread.comments]);
      setNextCursor(thread.nextCursor);
    } catch {
      setLoadError(t("Could not load more comments."));
    } finally {
      setLoadingMore(false);
    }
  };

  const submit = async (raw: string): Promise<ComposeIssue> => {
    if (!signedIn) return "signin";
    const quote = reviewId ? null : reviewQuote(handle, target, score);
    const budget = COMMENT_MAX - (quote ? ratingQuoteLength(quote) : 0);
    const issue = validateComment(raw, 0, Date.now(), budget);
    if (issue) return issue;
    setSending(true);
    try {
      const body = stripUrls(raw.trim());
      const created = reviewId
        ? fromReviewComment(await createReviewComment(reviewId, body))
        : await replyToReview(handle, target, score, body);
      setComments((cur) => [created, ...cur]);
      if (reviewId) setServerCount((count) => (count ?? comments.length) + 1);
      setState("ready");
      return null;
    } catch (error) {
      return (error as { status?: number }).status === 429 ? "cooldown" : "failed";
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2 border-t border-edge-soft pt-2">
      {state === "loading" && (
        <p className="flex items-center gap-1.5 py-2 text-[12px] text-ink-subtle">
          <Loader2 size={12} className="animate-spin" />
          {t("Loading comments…")}
        </p>
      )}

      {state === "error" && (
        <p className="py-2 text-[12px] text-ink-subtle">{t("Could not load comments")}</p>
      )}

      {state === "empty" && (
        <p className="py-2 text-[12px] text-ink-subtle">{t("No comments yet on this review.")}</p>
      )}

      {comments.length > 0 && (
        <ul className="flex flex-col gap-2">
          {comments.map((comment) => {
            const body = parseQuotedBody(comment.body).text;
            return (
              <li key={comment.id} className="flex items-start gap-2">
                <UserHoverCard handle={comment.authorHandle}>
                  <button
                    type="button"
                    onClick={() => requestOpenProfile(comment.authorHandle)}
                    aria-label={t("Open {alias} profile", {
                      alias: comment.authorAlias || comment.authorHandle,
                    })}
                    className="shrink-0 rounded-full"
                  >
                    <Avatar
                      src={comment.authorAvatarUrl}
                      size={24}
                      alias={comment.authorAlias || comment.authorHandle}
                    />
                  </button>
                </UserHoverCard>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <UserHoverCard handle={comment.authorHandle}>
                      <button
                        type="button"
                        onClick={() => requestOpenProfile(comment.authorHandle)}
                        className="truncate text-[12px] font-semibold text-ink hover:text-accent"
                      >
                        {comment.authorAlias || `@${comment.authorHandle}`}
                      </button>
                    </UserHoverCard>
                    <span className="text-[11.5px] text-ink-subtle">{timeAgo(comment.at)}</span>
                  </div>
                  <Body text={body} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {nextCursor && (
        <button
          type="button"
          onClick={() => void more()}
          disabled={loadingMore}
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium text-ink-subtle transition-colors hover:text-ink disabled:opacity-50"
        >
          {loadingMore && <Loader2 size={12} className="animate-spin" />}
          {t("Show more comments")}
        </button>
      )}

      {loadError && <p className="mt-1 text-[12px] text-danger">{loadError}</p>}

      <div className="mt-2">
        <CommentCompose onSubmit={submit} sending={sending} disabled={!signedIn} sources={[]} />
      </div>
    </div>
  );
}
