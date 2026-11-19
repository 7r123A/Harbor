import { useEffect, useMemo, useState } from "react";

import { animeCwIdsVersion, getAnimeCwId, subscribeAnimeCwIds } from "@/lib/anime-cw-ids";
import { identityFlags } from "./flags";
import {
  groupCwCards,
  identityCardsVersion,
  subscribeIdentityCards,
  warmIdentityCards,
} from "./card-grouping";

type CardRow = {
  _id: string;
  state?: { season?: number; lastWatched?: string };
  _mtime?: string | number;
  cwMembers?: unknown;
};

/**
 * Display-side card grouping. Flag off → input untouched. With the flag on,
 * rows are warmed asynchronously; one re-render follows when card keys are
 * known.
 *
 * Mis-key retirement is intentionally not applied here. Season ownership from
 * Anime-Lists is not a safe proof by itself: catalog season numbers often differ
 * from provider seasons (Black Clover, BLEACH, Gintama), and retiring a row
 * would hide a valid card. Duplicate stale rows are already collapsed by card
 * grouping; a real re-key belongs in the tracker/import layer instead.
 */
export function useIdentityCardGrouping<T extends CardRow>(items: T[]): T[] {
  const [cardsVersion, setCardsVersion] = useState(() => identityCardsVersion());
  const [aliasVersion, setAliasVersion] = useState(() => animeCwIdsVersion());

  useEffect(() => subscribeIdentityCards(() => setCardsVersion(identityCardsVersion())), []);
  useEffect(() => subscribeAnimeCwIds(() => setAliasVersion(animeCwIdsVersion())), []);

  useEffect(() => {
    if (!identityFlags().cards) return;
    const probes = (rowId: string) => {
      const ids = [rowId];
      const canonical = getAnimeCwId(rowId);
      if (canonical && canonical !== rowId) ids.push(canonical);
      return ids;
    };
    void warmIdentityCards(items, probes).catch(() => {});
  }, [items, aliasVersion]);

  return useMemo(() => groupCwCards(items), [items, cardsVersion, aliasVersion]);
}
