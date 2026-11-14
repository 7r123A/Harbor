import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";
import type { TrackInfo } from "./bridge";

/**
 * "Add audio" jobs for the player's audio menu: attach another release's audio track after Harbor
 * checks it belongs to this film and re-times it, and save any audio track as a file. The work runs
 * in Rust (`external_audio.rs`); this module keeps one job's state for every window that shows the
 * audio menu, including the native overlay.
 */

export type AudioStreamInfo = {
  ordinal: number;
  codec: string;
  channels: number;
  sampleRate: number;
  language: string | null;
  title: string | null;
  default: boolean;
};

export type AudioFileInfo = {
  durationSec: number;
  streams: AudioStreamInfo[];
  guessedLanguage: string | null;
};

export type SyncResult = {
  jobId: string;
  verdict: "match" | "partial" | "mismatch";
  outputPath: string | null;
  offsetSec: number;
  speed: number;
  segments: number;
  matched: number;
  windows: number;
  confidence: number;
  verifyWindows: number;
  verifyMedianMs: number;
  verifyMaxMs: number;
  cached: boolean;
};

export type ExternalAudioJob =
  | { kind: "idle" }
  | { kind: "choose"; path: string; info: AudioFileInfo }
  | { kind: "syncing"; jobId: string; path: string; stage: string; progress: number }
  | { kind: "done"; path: string; result: SyncResult; attached: boolean; title: string }
  | { kind: "mismatch"; path: string; result: SyncResult; ordinal: number; language: string | null }
  | { kind: "exporting"; jobId: string; progress: number; dest: string }
  | { kind: "exported"; dest: string }
  | { kind: "error"; message: string };

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let job: ExternalAudioJob = { kind: "idle" };
const listeners = new Set<() => void>();

function set(next: ExternalAudioJob) {
  job = next;
  for (const fn of listeners) fn();
}

export function getExternalAudioJob(): ExternalAudioJob {
  return job;
}

export function useExternalAudioJob(): ExternalAudioJob {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getExternalAudioJob,
    getExternalAudioJob,
  );
}

export function dismissExternalAudioJob() {
  if (job.kind === "syncing" || job.kind === "exporting") return;
  set({ kind: "idle" });
}

if (isTauri) {
  void listen<{ jobId: string; stage: string; progress: number }>(
    "external-audio://progress",
    (e) => {
      const p = e.payload;
      if (job.kind === "syncing" && job.jobId === p.jobId) {
        set({ ...job, stage: p.stage, progress: p.progress });
      } else if (job.kind === "exporting" && job.jobId === p.jobId) {
        set({ ...job, progress: p.progress });
      }
    },
  ).catch(() => {});
}

const AUDIO_EXTENSIONS = [
  "mka",
  "mkv",
  "mp4",
  "m4a",
  "m4v",
  "aac",
  "ac3",
  "eac3",
  "ec3",
  "dts",
  "thd",
  "flac",
  "mp3",
  "opus",
  "ogg",
  "wav",
  "avi",
  "mov",
  "ts",
  "webm",
  "wma",
];

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

async function filmDuration(): Promise<number> {
  const value = await invoke<unknown>("mpv_get_property", { name: "duration" }).catch(() => null);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function currentSource(): Promise<{ url: string; headers: Record<string, string> } | null> {
  try {
    const path = await invoke<unknown>("mpv_get_property", { name: "path" });
    if (typeof path !== "string" || !path) return null;
    const headers: Record<string, string> = {};
    const ua = await invoke<unknown>("mpv_get_property", { name: "user-agent" }).catch(() => null);
    if (typeof ua === "string" && ua) headers["User-Agent"] = ua;
    const fields = await invoke<unknown>("mpv_get_property", { name: "http-header-fields" }).catch(
      () => null,
    );
    if (typeof fields === "string" && fields) {
      // mpv joins the list with commas; a new field starts where a "Name:" follows a comma.
      for (const field of fields.split(/,(?=[A-Za-z0-9-]+:)/)) {
        const at = field.indexOf(":");
        if (at > 0) headers[field.slice(0, at).trim()] = field.slice(at + 1).trim();
      }
    }
    return { url: path, headers };
  } catch {
    return null;
  }
}

/** The film's own audio track the new audio is compared against: the selected one when embedded. */
function referenceOrdinal(tracks: TrackInfo[]): number {
  const embedded = tracks.filter((t) => !t.external);
  const selected = embedded.find((t) => t.selected);
  if (selected) return embedded.indexOf(selected);
  const fallback = embedded.findIndex((t) => t.default);
  return fallback >= 0 ? fallback : 0;
}

/** Step 1: choose a file. Files with several audio tracks ask which one before syncing. */
export async function pickExternalAudio(tracks: TrackInfo[]): Promise<void> {
  if (!isTauri || job.kind === "syncing" || job.kind === "exporting") return;
  let path: string | null = null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    path = typeof picked === "string" ? picked : null;
  } catch {
    path = null;
  }
  if (!path) return;
  try {
    const info = await invoke<AudioFileInfo>("external_audio_probe", { path });
    if (info.streams.length > 1) {
      set({ kind: "choose", path, info });
      return;
    }
    await syncExternalAudio(path, info.streams[0]?.ordinal ?? 0, tracks, info);
  } catch (error) {
    set({ kind: "error", message: String(error) });
  }
}

function trackLanguage(info: AudioFileInfo | null, ordinal: number): string | null {
  return (
    info?.streams.find((s) => s.ordinal === ordinal)?.language ?? info?.guessedLanguage ?? null
  );
}

/** Step 2: check the audio belongs to this film, re-time it, and attach it. */
export async function syncExternalAudio(
  path: string,
  ordinal: number,
  tracks: TrackInfo[],
  known?: AudioFileInfo,
): Promise<void> {
  const source = await currentSource();
  const durationSec = await filmDuration();
  if (!source || durationSec <= 0) {
    set({ kind: "error", message: "Start the film before adding audio." });
    return;
  }
  const info =
    known ?? (await invoke<AudioFileInfo>("external_audio_probe", { path }).catch(() => null));
  const jobId = `sync-${Date.now()}`;
  set({ kind: "syncing", jobId, path, stage: "decode", progress: 0 });
  try {
    const result = await invoke<SyncResult>("external_audio_sync", {
      request: {
        jobId,
        referenceUrl: source.url,
        referenceHeaders: source.headers,
        referenceOrdinal: referenceOrdinal(tracks),
        referenceDurationSec: durationSec,
        externalPath: path,
        externalOrdinal: ordinal,
        keepPitch: false,
      },
    });
    const language = trackLanguage(info, ordinal);
    if (result.verdict === "mismatch" || !result.outputPath) {
      set({ kind: "mismatch", path, result, ordinal, language });
      return;
    }
    const title = `${fileName(path).replace(/\.[^.]+$/, "")} · ${t("Synced")}`;
    await attach(result.outputPath, title, language);
    set({ kind: "done", path, result, attached: true, title });
  } catch (error) {
    const message = String(error);
    set(message.includes("cancelled") ? { kind: "idle" } : { kind: "error", message });
  }
}

/** Adds the original file unchanged, for audio the check could not match. */
export async function attachUnsynced(path: string, language: string | null): Promise<void> {
  try {
    await attach(path, fileName(path), language);
    set({ kind: "idle" });
  } catch (error) {
    set({ kind: "error", message: String(error) });
  }
}

async function attach(path: string, title: string, language: string | null) {
  await invoke("mpv_command", { cmd: ["audio-add", path, "select", title, language ?? ""] });
  // Same-position seek: mpv otherwise holds a newly selected track until its cache drains.
  const pos = await invoke<unknown>("mpv_get_property", { name: "time-pos" }).catch(() => null);
  if (typeof pos === "number" && Number.isFinite(pos) && pos > 0) {
    await invoke("mpv_command", { cmd: ["seek", pos, "absolute+exact"] }).catch(() => {});
  }
}

export async function removeExternalAudio(trackId: string): Promise<void> {
  await invoke("mpv_command", { cmd: ["audio-remove", trackId] }).catch(() => {});
}

export function cancelExternalAudioJob() {
  if (job.kind === "syncing" || job.kind === "exporting") {
    void invoke("external_audio_cancel", { jobId: job.jobId }).catch(() => {});
  }
}

/** Saves one audio track of the film, whole, as a file the viewer chooses. */
export async function exportAudioTrack(track: TrackInfo, tracks: TrackInfo[]): Promise<void> {
  if (!isTauri || job.kind === "syncing" || job.kind === "exporting") return;
  const source = await currentSource();
  const durationSec = await filmDuration();
  if (!source) {
    set({ kind: "error", message: "Start the film before saving audio." });
    return;
  }
  const embedded = tracks.filter((t) => !t.external);
  const external =
    track.external && track.externalFilename && !/^[a-z]+:\/\//i.test(track.externalFilename);
  const ordinal = track.external ? 0 : Math.max(0, embedded.indexOf(track));
  const lang = track.lang ? `.${track.lang}` : "";
  const base =
    (track.title || "audio")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .trim()
      .slice(0, 60) || "audio";
  let dest: string | null = null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    dest = await save({
      defaultPath: `${base}${lang}.mka`,
      filters: [{ name: "Matroska audio", extensions: ["mka"] }],
    });
  } catch {
    dest = null;
  }
  if (!dest) return;
  if (!/\.mka$/i.test(dest)) dest = `${dest}.mka`;
  const jobId = `export-${Date.now()}`;
  set({ kind: "exporting", jobId, progress: 0, dest });
  try {
    const saved = await invoke<string>("audio_track_export", {
      request: {
        jobId,
        sourceUrl: external ? track.externalFilename : source.url,
        headers: external ? {} : source.headers,
        ordinal,
        destPath: dest,
        durationSec: durationSec || null,
      },
    });
    set({ kind: "exported", dest: saved });
  } catch (error) {
    const message = String(error);
    set(message.includes("cancelled") ? { kind: "idle" } : { kind: "error", message });
  }
}
