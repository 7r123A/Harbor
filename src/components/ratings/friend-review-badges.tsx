import { useT } from "@/lib/i18n";
import { useEffect } from "react";
import {
  ensureMarksForTitle,
  markKeyForItem,
  useFriendReviewIndex,
} from "@/lib/social/friend-review-index";
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

  useEffect(() => {
    ensureMarksForTitle(contentTypeFor(metaId, kind), metaId);
  }, [metaId, kind]);
  if (!index) return null;

  const marks = index.get(markKeyForItem(contentTypeFor(metaId, kind), metaId));
  if (!marks || marks.length === 0) return null;

  const { shown, extra, total: totalCount } = friendBadgePlan(marks);
  const label =
    totalCount === 1
      ? t("1 friend rated this")
      : t("{count} friends rated this", { count: totalCount });

  return (
    <div
      aria-hidden="true"
      title={label}
      className={`pointer-events-none z-10 flex items-center ${className}`}
    >
      {shown.map((mark, i) => (
        <span
          key={mark.handle}
          className="inline-flex shrink-0 overflow-hidden rounded-full bg-canvas ring-1 ring-canvas"
          style={{
            width: avatarSize,
            height: avatarSize,
            marginInlineStart: i === 0 ? 0 : -Math.round(avatarSize / 3),
          }}
        >
          <Avatar src={mark.avatarUrl} size={avatarSize} alias={mark.alias} />
        </span>
      ))}
      {extra > 0 && (
        <span className="ms-0.5 rounded-full bg-canvas/90 px-1 text-[9px] font-bold leading-[14px] text-ink ring-1 ring-edge-soft">
          +{extra}
        </span>
      )}
    </div>
  );
}
