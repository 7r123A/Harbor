import { useEffect, useMemo, useState } from "react";

import { getAnimeCwId } from "@/lib/anime-cw-ids";
import { identityFlags } from "./flags";
import {
  groupCwCards,
  identityCardsVersion,
  subscribeIdentityCards,
  warmIdentityCards,
} from "./card-grouping";

type CardRow = {
  _id: string;
  state?: { lastWatched?: string };
  _mtime?: string | number;
  cwMembers?: unknown;
};

/**
 * Display-side card grouping. Flag off → returns the input untouched. With the
 * flag on, rows are warmed asynchronously and the list re-renders once their
 * provider-show card keys are known.
 */
export function useIdentityCardGrouping<T extends CardRow>(items: T[]): T[] {
  const [version, setVersion] = useState(() => identityCardsVersion());
  useEffect(() => subscribeIdentityCards(() => setVersion(identityCardsVersion())), []);
  useEffect(() => {
    if (!identityFlags().cards) return;
    const probes = (rowId: string) => {
      const ids = [rowId];
      const canonical = getAnimeCwId(rowId);
      if (canonical && canonical !== rowId) ids.push(canonical);
      return ids;
    };
    void warmIdentityCards(items, probes).catch(() => {});
  }, [items]);
  void version;
  return useMemo(() => groupCwCards(items), [items, version]);
}
