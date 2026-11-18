export type IdentityLookup = {
  id: string;
  entry: number | null;
  title: string | null;
  provisional: boolean;
};

export type IdentityStatus = {
  ready: boolean;
  dbBytes: number;
  packVersion: string | null;
  upstreamSha256: string | null;
  builtAt: number | null;
  entries: number;
  schema: number;
};

export type IdentityAlias = { scheme: string; id: string };

export type IdentityRelated = { entry: number; title: string | null };

export type IdentityWindow = {
  anidb: number | null;
  tvdb: number | null;
  tmdbtv: number | null;
  season: number | null;
  offset: number | null;
};

export type IdentityBundle = {
  entry: number;
  title: string | null;
  mediaType: string | null;
  episodes: number | null;
  aliases: IdentityAlias[];
  related: IdentityRelated[];
  windows: IdentityWindow[];
};

export type IdentityFlags = {
  pack: boolean;
  shadow: boolean;
};

export const IDENTITY_FLAG_DEFAULTS: IdentityFlags = { pack: false, shadow: false };
