import { useT } from "@/lib/i18n";
import { useEffect } from "react";
import {
  ensureMarksForTitle,
  markKeyForItem,
  useFriendReviewIndex,
  useTitleHoverSummary,
} from "@/lib/social/friend-review-index";
import { Star } from "lucide-react";
import { Avatar } from "@/views/profile/profile-bits";
import type { FriendReviewMark } from "@/lib/social/friend-review-index";

/**
 * The poster-side half of the social signal: up to three friends who rated this title, plus how
 * many more did. Reads the shared friends-feed index, so a rail of cards costs one feed read.
 */
function contentTypeFor(metaId: string, kind?: string): string {
  if (kind === "manga") return "manga";
  // Anime IDs can be carried by metas whose display type is only movie or series.
  if (/^(kitsu|mal|anilist|anidb):/i.test(metaId)) return "anime";
  if (kind === "series" || kind === "movie" || kind === "anime") return kind;
  return "movie";
}

/**
 * How many avatars to draw and how many to count as "+N". The backend sends an uncapped friend
 * count but only a few avatars, so the remainder has to be arithmetic — and it must never go
 * negative when a cached scan holds fewer marks than the count claims.
 */
export function friendBadgePlan(
  marks: FriendReviewMark[],
  max = 3,
): { shown: FriendReviewMark[]; extra: number; total: number } {
  const shown = marks.slice(0, max);
  const total = Math.max(marks[0]?.totalCount ?? marks.length, marks.length);
  return { shown, extra: Math.max(0, total - shown.length), total };
}

export function FriendReviewBadges({
  metaId,
  kind,
  className = "absolute bottom-1.5 start-1.5",
  avatarSize = 18,
}: {
  metaId: string;
  kind?: string;
  className?: string;
  avatarSize?: number;
}) {
  const t = useT();
  const index = useFriendReviewIndex();
  const contentType = contentTypeFor(metaId, kind);
  const summary = useTitleHoverSummary(contentType, metaId);
  const averageScore = summary?.averageScore ?? null;

  useEffect(() => {
    ensureMarksForTitle(contentTypeFor(metaId, kind), metaId);
  }, [metaId, kind]);
  const friends = summary?.friends ?? index?.get(markKeyForItem(contentType, metaId)) ?? [];
  const marks = friends.length > 0 ? friends : (summary?.community ?? []);
  if (marks.length === 0 && averageScore === null && !summary) return null;

  const { shown, extra, total: totalCount } = friendBadgePlan(marks);
  const label =
    friends.length > 0
      ? totalCount === 1
        ? t("1 friend rated this")
        : t("{count} friends rated this", { count: totalCount })
      : t("Recently rated by Harbor users");

  if (marks.length === 0 && averageScore === null) {
    return (
      <div className={`pointer-events-none z-10 flex items-center ${className}`}>
        <span className="inline-flex items-center gap-1 rounded-full bg-elevated/80 px-2 py-1 text-[11px] font-medium leading-none text-ink-muted">
          <Star size={12} aria-hidden />
          {t("Rate it")}
        </span>
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={[
        totalCount > 0 ? label : "",
        averageScore !== null
          ? `${t("Harbor users average score")} ${averageScore.toFixed(1)}/10`
          : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      title={totalCount > 0 ? label : undefined}
      className={`pointer-events-none z-10 flex items-center ${className}`}
    >
      <span className="inline-flex shrink-0 items-center">
        {shown.length > 0 && (
          <span className="relative z-10 inline-flex shrink-0 items-center">
            {shown.map((mark, i) => (
              <span
                key={mark.handle}
                className="relative inline-flex shrink-0 rounded-full bg-canvas ring-1 ring-canvas"
                style={{
                  width: avatarSize,
                  height: avatarSize,
                  marginInlineStart: i === 0 ? 0 : -Math.round(avatarSize / 3),
                }}
              >
                <span className="inline-flex overflow-hidden rounded-full">
                  <Avatar src={mark.avatarUrl} size={avatarSize} alias={mark.alias} />
                </span>
                {i === shown.length - 1 && extra > 0 && (
                  <span className="absolute -right-1 -top-1 z-10 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-elevated px-0.5 text-[9px] font-medium leading-none tabular-nums text-ink ring-1 ring-canvas">
                    +{extra}
                  </span>
                )}
              </span>
            ))}
          </span>
        )}
        {averageScore !== null && (
          <span
            title={t("Harbor users average score")}
            className="inline-flex shrink-0 items-center rounded-full pe-2 text-[12px] font-semibold leading-none tabular-nums text-ink"
            style={{
              height: Math.max(18, Math.round(avatarSize * 0.86)),
              marginInlineStart: shown.length > 0 ? -Math.round(avatarSize / 2) : 0,
              paddingInlineStart: shown.length > 0 ? Math.round(avatarSize / 2) + 4 : 8,
              backgroundColor: "color-mix(in srgb, var(--color-ink) 10%, var(--color-canvas))",
            }}
          >
            <span>{averageScore.toFixed(1)}</span>
          </span>
        )}
      </span>
    </div>
  );
}
