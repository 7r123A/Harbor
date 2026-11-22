import type { CastOptions, CastSubInfo, CastSubStyle } from "@/lib/cast";

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

/**
 * Whether the cast goes through Harbor's converter. A copied stream plays its first audio track
 * untouched, so another track or any audio processing needs the conversion too.
 */
export function castNeedsConversion(
  resolvedKind: "compat" | "swapped" | "transcode",
  liveIptv: boolean,
  media: {
    subtitle: CastSubInfo | null;
    audioTrackOrdinal: number | undefined;
    options: CastOptions;
  },
): boolean {
  const o = media.options;
  const audioWork =
    (media.audioTrackOrdinal ?? 0) > 0 ||
    o.volumeBoost > 0 ||
    o.nightMode ||
    o.dialogueBoost ||
    o.audioDelayMs !== 0;
  return (
    resolvedKind === "transcode" ||
    liveIptv ||
    media.subtitle != null ||
    audioWork ||
    o.forceConversion
  );
}
