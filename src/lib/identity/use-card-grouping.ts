import { useEffect, useMemo, useState } from "react";

import { animeCwIdsVersion, getAnimeCwId, subscribeAnimeCwIds } from "@/lib/anime-cw-ids";
import { identityFlags } from "./flags";
import {
  groupCwCards,
  identityCardsVersion,
  subscribeIdentityCards,
  warmIdentityCards,
} from "./card-grouping";
import {
  identityMisKeyVersion,
  isIdentityMisKeyRetired,
  subscribeIdentityMisKey,
  warmIdentityMisKey,
} from "./mis-key";

type CardRow = {
  _id: string;
  state?: { season?: number; lastWatched?: string };
  _mtime?: string | number;
  cwMembers?: unknown;
};

/**
 * Display-side card grouping + mis-key filtering. Flag off → input untouched.
 * With the flag on, rows are warmed asynchronously; one re-render follows when
 * card keys or retirement decisions are known.
 */
export function useIdentityCardGrouping<T extends CardRow>(items: T[]): T[] {
  const [cardsVersion, setCardsVersion] = useState(() => identityCardsVersion());
  const [misKeyVersion, setMisKeyVersion] = useState(() => identityMisKeyVersion());
  const [aliasVersion, setAliasVersion] = useState(() => animeCwIdsVersion());

  useEffect(() => subscribeIdentityCards(() => setCardsVersion(identityCardsVersion())), []);
  useEffect(() => subscribeIdentityMisKey(() => setMisKeyVersion(identityMisKeyVersion())), []);
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
    void warmIdentityMisKey(items, probes).catch(() => {});
  }, [items, aliasVersion]);

  return useMemo(
    () => groupCwCards(items.filter((item) => !isIdentityMisKeyRetired(item._id))),
    [items, cardsVersion, misKeyVersion, aliasVersion],
  );
}
