import { anilistRequest } from "./client";
import { loadMedia } from "@/lib/media-cache";

export type AnilistNextAiring = { episode: number; airingAt: number };

const QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    nextAiringEpisode { episode airingAt }
  }
}`;

const NEXT_AIRING_TTL = 15 * 60_000;

/**
 * The next scheduled episode for an AniList entry.
 *
 * CW timers used to trust the episode list's air dates. For currently airing
 * anime those come from the Kitsu add-on and can be a week behind AniList (the
 * same schedule the detail page shows), which made timer-mode cards count down
 * to the wrong week. AniList is the authority when its next episode matches the
 * card's target.
 */
export async function fetchAnilistNextAiring(
  anilistId: number,
  maxAge?: number,
): Promise<AnilistNextAiring | null> {
  if (!Number.isSafeInteger(anilistId) || anilistId <= 0) return null;
  const result = await loadMedia<AnilistNextAiring>(
    "anilist-next-airing",
    [anilistId],
    async () => {
      const data = await anilistRequest<{
        Media: {
          id: number;
          nextAiringEpisode: { episode: number; airingAt: number } | null;
        } | null;
      }>(QUERY, { id: anilistId }, undefined, true);
      const media = data.Media;
      if (!media || media.id !== anilistId) return null;
      const next = media.nextAiringEpisode;
      if (
        !next ||
        !Number.isInteger(next.episode) ||
        next.episode <= 0 ||
        !Number.isFinite(next.airingAt) ||
        next.airingAt <= 0
      )
        return null;
      return { episode: next.episode, airingAt: next.airingAt };
    },
    { ttl: NEXT_AIRING_TTL, maxAge },
  );
  return result.value;
}
