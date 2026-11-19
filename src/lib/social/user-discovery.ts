import { socialGet } from "./client";

export type DiscoverySort = "newest" | "oldest" | "username" | "relevance";
export type DiscoveredUser = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  verified: boolean;
  memberSince: string;
  ratingCount: number;
  hasCanvas: boolean;
};
export type UserDiscoveryPage = { users: DiscoveredUser[]; total: number; nextCursor?: string };
export type UserDiscoveryFilters = {
  query: string;
  sort: DiscoverySort;
  rated: boolean;
  canvas: boolean;
};

export function fetchDiscoveredUsers(
  filters: UserDiscoveryFilters,
  signal?: AbortSignal,
  cursor?: string,
): Promise<UserDiscoveryPage> {
  const query = filters.query.trim().replace(/^@+/, "");
  const params = new URLSearchParams({
    sort: filters.sort === "relevance" && !query ? "newest" : filters.sort,
    limit: "24",
  });
  if (query) params.set("q", query);
  if (filters.rated) params.set("rated", "1");
  if (filters.canvas) params.set("canvas", "1");
  if (cursor) params.set("cursor", cursor);
  return socialGet(`/social/users?${params.toString()}`, signal);
}
