import { identityEnabled, identityFlags } from "./flags";

type CardRow = {
  _id: string;
  state?: { lastWatched?: string };
  _mtime?: string | number;
  cwMembers?: unknown;
};

const CARD_TTL_MS = 5 * 60_000;
const cardCache = new Map<string, { at: number; key: string | null }>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Synchronous card key for a row, populated by warmIdentityCards. */
export function identityCardKey(rowId: string): string | null {
  const hit = cardCache.get(rowId);
  if (!hit) return null;
  if (Date.now() - hit.at > CARD_TTL_MS) {
    cardCache.delete(rowId);
    return null;
  }
  return hit.key;
}

export function subscribeIdentityCards(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearIdentityCardCache(): void {
  cardCache.clear();
  notify();
}

function activity(row: CardRow): number {
  const watched = Date.parse(row.state?.lastWatched ?? "");
  if (Number.isFinite(watched)) return watched;
  const mtime = typeof row._mtime === "number" ? row._mtime : Date.parse(String(row._mtime ?? ""));
  return Number.isFinite(mtime) ? mtime : 0;
}

/**
 * Resolve displayed CW rows to a provider-show card key.
 *
 * The probe list is supplied by the caller because catalog rows (`tt…`) first
 * need the app's existing catalog-to-entry mapping. Rows without a reliable
 * series card (movies, OVAs, specials, unknown) keep their own card.
 */
export async function warmIdentityCards(
  rows: CardRow[],
  probesForRow: (rowId: string) => string[] = (rowId) => [rowId],
): Promise<boolean> {
  if (!identityEnabled()) return false;
  const probesByRow = new Map<string, string[]>();
  const probes = new Set<string>();
  for (const row of rows) {
    const rowProbes = [...new Set(probesForRow(row._id).filter(Boolean))];
    probesByRow.set(row._id, rowProbes);
    for (const probe of rowProbes) probes.add(probe);
  }
  if (probes.size === 0) return false;

  const hints = await identityCardHints([...probes]);
  if (!hints) return false;
  const byId = new Map(hints.map((hint) => [hint.id, hint]));
  let changed = false;
  for (const row of rows) {
    let key: string | null = null;
    for (const probe of probesByRow.get(row._id) ?? []) {
      const hint = byId.get(probe);
      if (!hint || hint.provisional || !hint.cardKey) continue;
      // Only series-like entries share a card; movies/specials keep their own.
      const seriesLike = hint.mediaType === "TV" || hint.mediaType === "ONA";
      if (!seriesLike) continue;
      key = hint.cardKey;
      break;
    }
    const previous = cardCache.get(row._id);
    if (!previous || previous.key !== key) {
      cardCache.set(row._id, { at: Date.now(), key });
      changed = true;
    }
  }
  if (changed) notify();
  return changed;
}

/**
 * Merge rows that resolve to the same provider-show card. The representative is
 * the member with the most recent real activity; the other members ride along
 * in `cwMembers` so dismissal/cleanup can cover them later.
 */
export function groupCwCards<T extends CardRow>(items: T[]): T[] {
  if (!identityFlags().cards) return items;
  const order: Array<T | { group: T[] }> = [];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = identityCardKey(item._id);
    if (!key) {
      order.push(item);
      continue;
    }
    const existing = groups.get(key);
    if (!existing) {
      const members = [item];
      groups.set(key, members);
      order.push({ group: members });
      continue;
    }
    existing.push(item);
  }
  let merged = false;
  const output: T[] = [];
  for (const entry of order) {
    if (!("group" in entry)) {
      output.push(entry);
      continue;
    }
    const members = entry.group;
    if (members.length < 2) {
      output.push(members[0] as T);
      continue;
    }
    merged = true;
    const representative = members.reduce((best, member) =>
      activity(member) > activity(best) ? member : best,
    );
    output.push({ ...representative, cwMembers: members } as T);
  }
  return merged ? output : items;
}

export function identityCardsVersion(): number {
  return version;
}

// Kept here to avoid a cycle: index exports the command wrapper.
import type { IdentityCardHint } from "./types";
import { invokeIdentity } from "./client";

async function identityCardHints(ids: string[]): Promise<IdentityCardHint[] | null> {
  return invokeIdentity<IdentityCardHint[]>("identity_card_hints", { ids });
}
