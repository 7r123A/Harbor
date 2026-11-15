import type { CastSubInfo, CastSubStyle } from "@/lib/cast";

type TrackSelection = {
  subtitle: CastSubInfo | null;
  subStyle: CastSubStyle | null;
  audioTrackOrdinal: number | undefined;
};

/**
 * Track choices for the stream the TV actually plays. A swapped stream is another file, so the
 * player's track numbers say nothing about its tracks: its default audio plays and only subtitle
 * files (not embedded tracks) burn in. Every load and reload of that cast goes through here.
 */
export function fitTracksToCastSource<T extends TrackSelection>(media: T, swapped: boolean): T {
  if (!swapped) return media;
  const subtitle = media.subtitle?.kind === "embedded" ? null : media.subtitle;
  return {
    ...media,
    audioTrackOrdinal: undefined,
    subtitle,
    subStyle: subtitle ? media.subStyle : null,
  };
}
