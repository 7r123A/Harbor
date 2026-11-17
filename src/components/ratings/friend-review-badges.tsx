import { useT } from "@/lib/i18n";
import { useEffect } from "react";
import { ensureMarksForTitle, markKeyForItem, useFriendReviewIndex } from "@/lib/social/friend-review-index";
import { Avatar } from "@/views/profile/profile-bits";

/**
 * The poster-side half of the social signal: up to three friends who rated this title, plus how
 * many more did. Reads the shared friends-feed index, so a rail of cards costs one feed read.
 */
function contentTypeFor(metaId: string, kind?: string): string {
  // The card knows what it is; the id prefix is only a fallback for callers that do not.
  if (kind === "series" || kind === "movie" || kind === "anime" || kind === "manga") return kind;
  if (/^(kitsu|mal|anilist|anidb):/i.test(metaId)) return "anime";
  return "movie";
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

  const marks = index.get(markKeyForItem(metaId));
  if (!marks || marks.length === 0) return null;

  const shown = marks.slice(0, 3);
  const extra = marks.length - shown.length;
  const label =
    marks.length === 1
      ? t("1 friend rated this")
      : t("{count} friends rated this", { count: marks.length });

  return (
    <div
      aria-hidden="true"
      title={label}
      className={`pointer-events-none z-10 flex items-center ${className}`}
    >
      {shown.map((mark, i) => (
        <span
          key={mark.handle}
          className="inline-flex shrink-0 overflow-hidden rounded-full bg-canvas ring-2 ring-canvas"
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
        <span className="ms-1 rounded-full bg-canvas/90 px-1 text-[9.5px] font-bold leading-4 text-ink ring-1 ring-edge-soft">
          +{extra}
        </span>
      )}
    </div>
  );
}
