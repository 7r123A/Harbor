import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, LoaderCircle, RotateCcw, Speaker } from "@/components/icons/music-icons";
import { useT } from "@/lib/i18n";
import { getSpotifyStatus } from "@/lib/music/sources";
import { SpotifyDevicePairing } from "./spotify-setup";
import {
  selectableSpotifyDevices,
  setSpotifyPlaybackTarget,
  spotifyDevices,
  spotifyPlaybackTarget,
  type SpotifyDevice,
} from "@/lib/music/spotify-devices";

const CHOICE =
  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start transition-colors hover:bg-elevated";

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Local librespot account pairing belongs beside the engine's setup, not
 * beneath the output-device picker. Re-pair remains available once connected.
 */
export function SpotifyLibrespotPairing({ onPaired }: { onPaired?: () => void }) {
  const t = useT();
  const [localReady, setLocalReady] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    void getSpotifyStatus()
      .then((status) => {
        if (mounted) setLocalReady(status.playbackReady);
      })
      .catch(() => {
        if (mounted) setLocalReady(false);
      });
    return () => { mounted = false; };
  }, []);

  const paired = () => {
    setLocalReady(true);
    onPaired?.();
    window.dispatchEvent(new Event("harbor:spotify-local-paired"));
  };

  return (
    <section className="border-t border-edge-soft bg-elevated/25 px-5 py-4">
      {localReady === null ? (
        <p role="status" className="text-[12px] leading-5 text-ink-muted">
          {t("music.spotify.playbackChecking")}
        </p>
      ) : localReady ? (
        <>
          <p className="text-[13px] font-semibold leading-6 text-ink">
            {t("music.spotifySetup.pairTitle")}
          </p>
          <p role="status" className="mt-1 flex items-center gap-2 text-[12px] leading-5 text-ink-muted">
            <span className="size-1.5 shrink-0 rounded-full bg-ink-muted" aria-hidden="true" />
            {t("music.spotify.playbackConnected")}
          </p>
          <details className="group mt-3 border-t border-edge-soft pt-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md py-1 text-[12px] font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {t("music.spotifySetup.repair")}
              <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-ink-muted transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <div className="pt-3">
              <SpotifyDevicePairing disabled={false} onPaired={paired} />
            </div>
          </details>
        </>
      ) : (
        <SpotifyDevicePairing disabled={false} onPaired={paired} />
      )}
    </section>
  );
}

export function SpotifyPlaybackTarget() {
  const t = useT();
  const [localReady, setLocalReady] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<SpotifyDevice[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    // The local/remote target is a saved preference, not dependent on the
    // Spotify Web API. Still show the correct target if device discovery fails.
    Promise.allSettled([spotifyDevices(), spotifyPlaybackTarget()])
      .then(([found, chosen]) => {
        if (found.status === "fulfilled") setDevices(selectableSpotifyDevices(found.value));
        else setError(describe(found.reason));
        if (chosen.status === "fulfilled") setTarget(chosen.value);
        else setError(describe(chosen.reason));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);
  useEffect(() => {
    window.addEventListener("harbor:spotify-playback-target-changed", load);
    return () => window.removeEventListener("harbor:spotify-playback-target-changed", load);
  }, [load]);
  useEffect(() => {
    let current = true;
    const update = () => {
      void getSpotifyStatus()
        .then((status) => {
          if (current) setLocalReady(status.playbackReady);
        })
        .catch(() => {});
    };
    update();
    window.addEventListener("harbor:spotify-local-paired", update);
    return () => {
      current = false;
      window.removeEventListener("harbor:spotify-local-paired", update);
    };
  }, []);

  const choose = (device: string | null) => {
    const previous = target;
    setTarget(device);
    setError("");
    void setSpotifyPlaybackTarget(device).catch((cause) => {
      setTarget(previous);
      setError(describe(cause));
    });
  };

  return (
    <section className="border-t border-edge-soft bg-elevated/25 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-6 text-ink">
            {t("music.spotifyDevices.title")}
          </p>
          <p className="text-[13px] leading-5 text-ink-muted">{t("music.spotifyDevices.body")}</p>
          <p className="mt-1 text-[12px] font-medium text-ink-muted" role="status">
            {t(
              localReady === null
                ? "music.spotify.playbackChecking"
                : localReady
                  ? "music.spotify.playbackConnected"
                  : "music.spotify.playbackNotConnected",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-edge px-4 text-[12px] font-medium text-ink hover:bg-elevated disabled:opacity-40"
        >
          {loading ? (
            <LoaderCircle
              size={16}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <RotateCcw size={16} aria-hidden="true" />
          )}
          {t("music.spotifyDevices.refresh")}
        </button>
      </div>
      <ul className="mt-3 grid gap-0.5">
        <li>
          <button
            type="button"
            className={CHOICE}
            aria-pressed={target === null}
            onClick={() => choose(null)}
          >
            <Speaker size={17} aria-hidden="true" className="shrink-0 text-ink-muted" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
              {t("music.spotifyDevices.harbor")}
            </span>
            {target === null && (
              <Check size={17} aria-hidden="true" className="shrink-0 text-ink" />
            )}
          </button>
        </li>
        {devices.map((device) => (
          <li key={device.id}>
            <button
              type="button"
              className={CHOICE}
              aria-pressed={target === device.id}
              onClick={() => choose(device.id)}
            >
              <Speaker size={17} aria-hidden="true" className="shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={device.name}>
                {device.name}
              </span>
              <span className="shrink-0 text-[11px] text-ink-muted">{device.kind}</span>
              {target === device.id && (
                <Check size={17} aria-hidden="true" className="shrink-0 text-ink" />
              )}
            </button>
          </li>
        ))}
      </ul>
      {!loading && devices.length === 0 && (
        <p className="mt-2 text-[13px] leading-5 text-ink-subtle">
          {t("music.spotifyDevices.empty")}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] leading-5 text-danger">
          {error}
        </p>
      )}

    </section>
  );
}
