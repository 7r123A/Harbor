import type { LibraryItem } from "./stremio";
import type { LocalEntry } from "./watchlist";
import { isMovieWatchedLocal } from "./movie-watched";
import { isWatchedFlagged } from "./watched-flag";

/** The same watched/progress rules the Watchlist has always used for Stremio items. */
export function isStremioItemWatched(item: LibraryItem | null | undefined): boolean {
  if (!item) return false;
  return (
    (item.state?.flaggedWatched ?? 0) > 0 ||
    (item.state?.timesWatched ?? 0) > 0 ||
    (item.state?.timeOffset ?? 0) > 0
  );
}

/** Collect every id a watched Stremio item can be recognised by. */
export function collectStremioWatchedIds(items: LibraryItem[]): Set<string> {
  const watched = new Set<string>();
  for (const item of items) {
    if (!isStremioItemWatched(item)) continue;
    watched.add(item._id);
    for (const id of item.altIds ?? []) watched.add(id);
  }
  return watched;
}

/**
 * A merged Watchlist card is watched when any of its identities (Harbor's
 * movie watched store, the watched flag store, or a Stremio item's state) says
 * so. Library keeps watched cards; only the Watchlist view filters them.
 */
export function isMergedWatchlistCardWatched(
  card: { meta: { id: string; type: string }; stremioId?: string; localId?: string },
  locals: LocalEntry[],
  stremioWatchedIds: ReadonlySet<string>,
): boolean {
  const local = card.localId ? locals.find((entry) => entry.id === card.localId) : undefined;
  const ids = new Set<string>();
  ids.add(card.meta.id);
  if (card.stremioId) ids.add(card.stremioId);
  if (card.localId) ids.add(card.localId);
  if (local?.imdbId) ids.add(local.imdbId);

  for (const id of ids) {
    if (stremioWatchedIds.has(id)) return true;
    if (isWatchedFlagged(id)) return true;
  }
  if (card.meta.type === "movie") {
    for (const id of ids) {
      if (isMovieWatchedLocal(id, [...ids])) return true;
    }
  }
  return false;
}
