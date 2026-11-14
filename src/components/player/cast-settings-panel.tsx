import { HelpCircle, Loader2, Minus, Plus, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { CastCapabilities, CastDeviceInfo, CastPreview, CastTranscodeStats } from "@/lib/cast";
import {
  castOptionsFor,
  deviceHasOverrides,
  panelDevice,
  resetCastPreferences,
  resetDeviceCastOptions,
  setCastOptions,
  updateCastPreferences,
  useCastPreferences,
} from "@/lib/cast/cast-preferences";
import { automaticDeviceOptions, automaticStreamFormat } from "@/lib/cast/device-settings";
import { useT } from "@/lib/i18n";
import type { TrackInfo } from "@/lib/player/bridge";
import { languageName } from "@/lib/subtitles/language";
import { Tooltip } from "./transport/tooltip";

/** "auto" follows the player, "off" sends no subtitles, "file" is a picked file, else a track id. */
export type CastSubtitleChoice = string;

export type CastSettingsPanelProps = {
  audioTracks: TrackInfo[];
  subtitleTracks: TrackInfo[];
  audioChoice: string;
  subtitleChoice: CastSubtitleChoice;
  subtitleFileName: string | null;
  burnSubs: boolean;
  onAudioChoice: (choice: string) => void;
  onSubtitleChoice: (choice: CastSubtitleChoice) => void;
  onAddSubtitleFile: () => void;
  onBurnSubs: (on: boolean) => void;
  preview: CastPreview | null;
  previewBusy: boolean;
  caps: CastCapabilities | null;
  device: CastDeviceInfo | null;
  casting: boolean;
  applying: boolean;
  stats: CastTranscodeStats | null;
};

const SIZE_STEPS = [75, 100, 125, 150, 175, 200, 250, 300];

function trackName(track: TrackInfo, fallback: string): string {
  const lang = track.lang ? languageName(track.lang) : "";
  const title = track.title && track.title !== track.lang ? track.title : "";
  const base = [lang, title].filter(Boolean).join(" · ") || track.label || fallback;
  const channels = track.channelCount
    ? ` (${track.channelCount > 2 ? `${track.channelCount - 1}.1` : `${track.channelCount}.0`})`
    : "";
  return `${base}${track.kind === "audio" ? channels : ""}`;
}

function Help({ text }: { text: string }) {
  return (
    <Tooltip label={text} align="end">
      <span
        tabIndex={0}
        aria-label={text}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-subtle outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
      >
        <HelpCircle size={13} strokeWidth={2.2} />
      </span>
    </Tooltip>
  );
}

function Row({
  label,
  children,
  help,
  strong,
}: {
  label: string;
  children: ReactNode;
  help?: string;
  strong?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-h-[30px] items-center gap-2">
      <span
        id={id}
        className={`w-[92px] shrink-0 text-[12px] ${strong ? "font-bold text-ink" : "text-ink-muted"}`}
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5" aria-labelledby={id}>
        {children}
      </div>
      {help ? <Help text={help} /> : <span className="w-5 shrink-0" />}
    </div>
  );
}

function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      disabled={disabled}
      value={String(value)}
      onChange={(e) => {
        const hit = options.find(([v]) => String(v) === e.target.value);
        if (hit) onChange(hit[0]);
      }}
      className="h-[28px] min-w-0 flex-1 truncate rounded-md border border-edge-soft bg-canvas/60 px-2 text-[12px] text-ink outline-none transition-colors hover:border-edge focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
    >
      {options.map(([v, text]) => (
        <option key={String(v)} value={String(v)}>
          {text}
        </option>
      ))}
    </select>
  );
}

function Check({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex min-h-[26px] cursor-pointer items-center gap-2 text-[12px] text-ink ${disabled ? "opacity-40" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-accent"
      />
      <span>{label}</span>
    </label>
  );
}

function Stepper({
  valueMs,
  onChange,
  label,
}: {
  valueMs: number;
  onChange: (ms: number) => void;
  label: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-1 items-center gap-1.5">
      <button
        type="button"
        aria-label={`${label} −`}
        onClick={() => onChange(valueMs - 50)}
        className="flex h-[26px] w-[26px] items-center justify-center rounded-md border border-edge-soft bg-canvas/60 text-ink hover:border-edge"
      >
        <Minus size={12} />
      </button>
      <button
        type="button"
        aria-label={`${label} +`}
        onClick={() => onChange(valueMs + 50)}
        className="flex h-[26px] w-[26px] items-center justify-center rounded-md border border-edge-soft bg-canvas/60 text-ink hover:border-edge"
      >
        <Plus size={12} />
      </button>
      <span
        className={`ms-1 font-mono text-[12px] tabular-nums ${valueMs ? "text-accent" : "text-ink-muted"}`}
      >
        {valueMs > 0 ? "+" : ""}
        {(valueMs / 1000).toFixed(2)}s
      </span>
      {valueMs !== 0 && (
        <button
          type="button"
          aria-label={t("Reset sync")}
          onClick={() => onChange(0)}
          className="ms-auto flex h-[24px] w-[24px] items-center justify-center rounded-md text-ink-subtle hover:bg-raised hover:text-ink"
        >
          <RotateCcw size={11} />
        </button>
      )}
    </div>
  );
}

function Divider() {
  return <div className="my-1.5 h-px bg-edge-soft" />;
}

/** Marks the choice the device would make by itself. */
function withAuto<T extends string | number>(
  options: Array<[T, string]>,
  automatic: T | undefined,
  autoLabel: string,
): Array<[T, string]> {
  return options.map(([value, text]) => [
    value,
    value === automatic ? `${text} · ${autoLabel}` : text,
  ]);
}

/** Plain-language account of what the converter does with this film. */
export function describePlan(
  preview: CastPreview | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (!preview) return null;
  const s = preview.summary;
  const video =
    s.video === "copy"
      ? t("Video sent as is")
      : t("Video converted to H.264 {height}p", { height: s.outputHeight });
  const audio = s.audio.includes("original")
    ? t("Audio sent as is")
    : t("Audio as {codec}", { codec: s.audio });
  return { video, audio, from: [s.sourceVideo, s.sourceAudio].filter(Boolean).join(" · ") };
}

export function CastSettingsPanel(props: CastSettingsPanelProps) {
  const t = useT();
  const prefs = useCastPreferences();
  // Device settings belong to the device casting, or the last one cast to; the rest are shared.
  const target = panelDevice(prefs, props.device);
  const o = castOptionsFor(target, prefs);
  const auto = target ? automaticDeviceOptions(target) : undefined;
  const customised = deviceHasOverrides(target, prefs);
  const noDevice = !target;
  const look = prefs.look;
  const [view, setView] = useState<"settings" | "about" | "troubleshoot">("settings");
  const setOption = (patch: Partial<typeof o>) => setCastOptions(target, patch);
  const setLook = (patch: Partial<typeof look>) => updateCastPreferences({ look: patch });
  const autoLabel = t("Auto");
  const autoStream = target
    ? automaticStreamFormat(target) === "ts"
      ? "MPEG-TS"
      : "HLS"
    : "MPEG-TS / HLS";

  const audioOptions = useMemo<Array<[string, string]>>(
    () => [
      ["auto", t("Same as the player")],
      // An added local file (a synced dub) can go to the TV too; added links cannot.
      ...props.audioTracks
        .filter(
          (track) =>
            !track.external ||
            (!!track.externalFilename && !/^[a-z]+:\/\//i.test(track.externalFilename)),
        )
        .map((track, i): [string, string] => [
          track.id,
          trackName(track, t("Track {number}", { number: i + 1 })),
        ]),
    ],
    [props.audioTracks, t],
  );
  const subtitleOptions = useMemo<Array<[string, string]>>(() => {
    const rows: Array<[string, string]> = [
      ["auto", t("Same as the player")],
      ["off", t("Off")],
    ];
    props.subtitleTracks.forEach((track, i) => {
      rows.push([track.id, trackName(track, t("Track {number}", { number: i + 1 }))]);
    });
    if (props.subtitleFileName) rows.push(["file", props.subtitleFileName]);
    rows.push(["add-file", t("Add subtitle file…")]);
    return rows;
  }, [props.subtitleTracks, props.subtitleFileName, t]);

  const plan = describePlan(props.preview, t);
  const hardware =
    props.preview?.hardware ??
    (props.caps?.nvenc
      ? "NVIDIA NVENC"
      : props.caps?.qsv
        ? "Intel Quick Sync"
        : props.caps?.amf
          ? "AMD AMF"
          : null);
  const live = props.casting && props.stats?.running ? props.stats : null;

  useEffect(() => {
    if (!props.casting && view === "troubleshoot") setView("settings");
  }, [props.casting, view]);

  if (view !== "settings") {
    return (
      <div className="flex flex-col gap-2 text-[12px] text-ink">
        <button
          type="button"
          onClick={() => setView("settings")}
          className="self-start rounded-md px-2 py-1 text-[11.5px] font-semibold text-ink-muted hover:bg-raised hover:text-ink"
        >
          ← {t("Back")}
        </button>
        {view === "about" ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-muted">{t("Device")}</dt>
            <dd>{props.device?.name ?? "—"}</dd>
            <dt className="text-ink-muted">{t("Connection")}</dt>
            <dd>
              {props.device
                ? `${props.device.kind.toUpperCase()} · ${props.device.host}${props.device.port ? `:${props.device.port}` : ""}`
                : "—"}
            </dd>
            <dt className="text-ink-muted">{t("Device model")}</dt>
            <dd>{props.device?.model ?? "—"}</dd>
            <dt className="text-ink-muted">{t("Source")}</dt>
            <dd>{plan?.from || "—"}</dd>
            <dt className="text-ink-muted">{t("Sent to the TV")}</dt>
            <dd>{plan ? `${plan.video} · ${plan.audio}` : "—"}</dd>
            <dt className="text-ink-muted">{t("Hardware")}</dt>
            <dd>{hardware ?? t("Processor only")}</dd>
          </dl>
        ) : (
          <div className="flex flex-col gap-1.5 leading-relaxed text-ink-muted">
            <p>{t("If the TV shows nothing or stops:")}</p>
            <ul className="list-disc ps-5">
              <li>{t("Keep the TV and this computer on the same Wi-Fi or router.")}</li>
              <li>{t("Allow Harbor through the Windows firewall on private networks.")}</li>
              <li>{t("Set Streaming to MPEG-TS for older TVs, or HLS for TV boxes.")}</li>
              <li>{t("Turn on Force conversion if the picture or sound is missing.")}</li>
              <li>{t("Lower the quality to 720p on a slow Wi-Fi.")}</li>
            </ul>
            {props.stats?.error && (
              <p role="alert" className="rounded-md bg-rose-400/10 px-2 py-1.5 text-rose-200">
                {props.stats.error}
              </p>
            )}
            <p>
              {props.caps?.available
                ? t("Converter ready. Hardware: {hardware}", {
                    hardware: hardware ?? t("Processor only"),
                  })
                : t("ffmpeg was not found, so videos that need converting cannot be cast.")}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="status"
        className="flex min-h-[30px] flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-accent-soft px-2.5 py-1.5 text-[11.5px] text-ink"
      >
        <Sparkles size={13} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          {target
            ? customised
              ? t("Settings for {device}, with your changes", { device: target.name })
              : t("Set automatically for {device}", { device: target.name })
            : t("These settings set themselves for the device you pick.")}
        </span>
        {target && customised ? (
          <button
            type="button"
            onClick={() => resetDeviceCastOptions(target)}
            className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-semibold text-accent hover:bg-raised"
          >
            {t("Back to automatic")}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-x-5 gap-y-1 md:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <Row label={t("Audio")} strong>
            <Select
              label={t("Audio")}
              value={props.audioChoice}
              options={audioOptions}
              onChange={props.onAudioChoice}
            />
          </Row>
          <Row
            label={t("Surround")}
            help={t(
              "Stereo works on every TV. Dolby Digital 5.1 needs a TV or receiver that decodes it.",
            )}
          >
            <Select
              label={t("Surround")}
              value={o.audioMode}
              disabled={noDevice}
              options={withAuto(
                [
                  ["stereo", t("Stereo downmix")],
                  ["surround", t("Dolby Digital 5.1")],
                  ["original", t("Original (passthrough)")],
                ],
                auto?.audioMode,
                autoLabel,
              )}
              onChange={(audioMode) => setOption({ audioMode })}
            />
          </Row>
          <Row label={t("Volume")} help={t("Raises quiet films on the TV without clipping.")}>
            <Select
              label={t("Volume")}
              value={o.volumeBoost}
              options={[
                [0, t("Normal")],
                [25, "+25%"],
                [50, "+50%"],
                [100, "+100%"],
              ]}
              onChange={(volumeBoost) => setOption({ volumeBoost })}
            />
          </Row>
          <Row label="">
            <Check
              checked={o.nightMode}
              onChange={(nightMode) => setOption({ nightMode })}
              label={t("Night mode")}
            />
            <Check
              checked={o.dialogueBoost}
              onChange={(dialogueBoost) => setOption({ dialogueBoost })}
              label={t("Clear dialogue")}
            />
          </Row>
          <Row label={t("Delay")}>
            <Stepper
              valueMs={o.audioDelayMs}
              onChange={(audioDelayMs) => setOption({ audioDelayMs })}
              label={t("Audio delay")}
            />
          </Row>
          <Divider />
          <Row label={t("Subtitles")} strong>
            <Select
              label={t("Subtitles")}
              value={props.subtitleChoice}
              options={subtitleOptions}
              onChange={(choice) =>
                choice === "add-file" ? props.onAddSubtitleFile() : props.onSubtitleChoice(choice)
              }
            />
          </Row>
          <Row
            label={t("Character set")}
            help={t(
              "For subtitle files that show strange symbols. Arabic files are usually Windows-1256.",
            )}
          >
            <Select
              label={t("Character set")}
              value={o.subEncoding}
              options={[
                ["auto", t("Auto")],
                ["utf-8", "UTF-8"],
                ["windows-1256", t("Arabic (Windows-1256)")],
                ["windows-1252", t("Western (Windows-1252)")],
                ["windows-1251", t("Cyrillic (Windows-1251)")],
                ["windows-1253", t("Greek (Windows-1253)")],
                ["windows-1254", t("Turkish (Windows-1254)")],
                ["windows-1255", t("Hebrew (Windows-1255)")],
              ]}
              onChange={(subEncoding) => setOption({ subEncoding })}
            />
          </Row>
          <Row label={t("Rendering")} help={t("Burned-in subtitles always show, on any TV.")}>
            <Select
              label={t("Rendering")}
              value={props.burnSubs ? "burn" : "off"}
              options={[
                ["burn", t("Burn in video")],
                ["off", t("Off")],
              ]}
              onChange={(v) => props.onBurnSubs(v === "burn")}
            />
          </Row>
          <Row label={t("Size")}>
            <Select
              label={t("Size")}
              value={look.sizePercent}
              options={SIZE_STEPS.map((v): [number, string] => [v, `${v}%`])}
              onChange={(sizePercent) => setLook({ sizePercent })}
            />
          </Row>
          <Row label={t("Color")}>
            <Select
              label={t("Color")}
              value={look.color}
              options={[
                ["#FFFFFF", t("White")],
                ["#FFE14D", t("Yellow")],
                ["#7CFC8A", t("Green")],
                ["#7FE7FF", t("Cyan")],
                ["#FFB3D9", t("Pink")],
              ]}
              onChange={(color) => setLook({ color })}
            />
          </Row>
          <Row label={t("Position")}>
            <Select
              label={t("Position")}
              value={look.lift}
              options={[
                [0, t("Bottom edge")],
                [40, t("Slightly higher")],
                [90, t("Higher up")],
              ]}
              onChange={(lift) => setLook({ lift })}
            />
            <Check
              checked={look.background}
              onChange={(background) => setLook({ background })}
              label={t("Background")}
            />
          </Row>
          <Row label={t("Delay")}>
            <Stepper
              valueMs={o.subDelayMs}
              onChange={(subDelayMs) => setOption({ subDelayMs })}
              label={t("Subtitle delay")}
            />
          </Row>
        </div>

        <div className="flex flex-col gap-0.5 md:border-s md:border-edge-soft md:ps-5">
          <Row label={t("Deinterlace")}>
            <Select
              label={t("Deinterlace")}
              value={o.deinterlace}
              options={[
                ["auto", t("Auto")],
                ["none", t("None")],
                ["always", t("Always")],
              ]}
              onChange={(deinterlace) => setOption({ deinterlace })}
            />
          </Row>
          <Row label={t("Aspect")}>
            <Select
              label={t("Aspect")}
              value={o.aspect}
              disabled={noDevice}
              options={withAuto(
                [
                  ["default", t("Default")],
                  ["16:9", "16:9"],
                  ["4:3", "4:3"],
                  ["21:9", "21:9"],
                  ["fill", t("Fill screen")],
                ],
                auto?.aspect,
                autoLabel,
              )}
              onChange={(aspect) => setOption({ aspect })}
            />
          </Row>
          <Divider />
          <Row
            label={t("Quality")}
            help={t("Higher quality needs a faster Wi-Fi. 4K needs a 4K TV.")}
          >
            <Select
              label={t("Quality")}
              value={o.quality}
              disabled={noDevice}
              options={withAuto(
                [
                  ["720p", "720p"],
                  ["1080p", "1080p"],
                  ["1080p-hq", t("1080p HQ")],
                  ["4k", "4K"],
                  ["original", t("Original")],
                ],
                auto?.quality,
                autoLabel,
              )}
              onChange={(quality) => setOption({ quality })}
            />
          </Row>
          <Row label="">
            <Check
              checked={o.forceConversion}
              disabled={noDevice}
              onChange={(forceConversion) => setOption({ forceConversion })}
              label={t("Force conversion")}
            />
          </Row>
          <Divider />
          <Row
            label={t("Accelerate")}
            help={
              hardware
                ? t("Uses {hardware} so the computer stays cool and the TV starts sooner.", {
                    hardware,
                  })
                : t("No supported graphics card was found; the processor converts instead.")
            }
          >
            <div className="flex flex-col">
              <Check
                checked={o.hardwareDecoding}
                onChange={(hardwareDecoding) => setOption({ hardwareDecoding })}
                label={t("Decoding")}
              />
              <Check
                checked={o.hardwareEncoding}
                onChange={(hardwareEncoding) => setOption({ hardwareEncoding })}
                label={t("Encoding")}
              />
              <Check
                checked={o.fastSeek}
                onChange={(fastSeek) => setOption({ fastSeek })}
                label={t("Scrubbing")}
              />
            </div>
          </Row>
          <Divider />
          <Row
            label="H.265 (HEVC)"
            help={t(
              "Only if your TV plays H.265 itself: the film is sent untouched, HDR included.",
            )}
          >
            <Check
              checked={o.hevcNative}
              disabled={noDevice}
              onChange={(hevcNative) => setOption({ hevcNative })}
              label={t("Native playback")}
            />
          </Row>
          <Row
            label="HDR"
            help={t(
              "Converts HDR and Dolby Vision colours for TVs that would show them washed out.",
            )}
          >
            <Select
              label="HDR"
              value={o.tonemap}
              disabled={noDevice}
              options={withAuto(
                [
                  ["auto", t("Tone-map to SDR")],
                  ["off", t("Off")],
                ],
                auto?.tonemap,
                autoLabel,
              )}
              onChange={(tonemap) => setOption({ tonemap })}
            />
          </Row>
          <Row
            label={t("Streaming")}
            help={t("Auto picks MPEG-TS for DLNA TVs and HLS for everything else.")}
          >
            <Select
              label={t("Streaming")}
              value={o.streamFormat}
              disabled={noDevice}
              options={[
                ["auto", `${autoLabel} (${autoStream})`],
                ["ts", "MPEG-TS"],
                ["hls", "HLS"],
              ]}
              onChange={(streamFormat) => setOption({ streamFormat })}
            />
          </Row>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setView("about")}
              className="rounded-md border border-edge-soft px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted hover:border-edge hover:text-ink"
            >
              {t("About this cast")}
            </button>
            <button
              type="button"
              onClick={() => setView("troubleshoot")}
              className="rounded-md border border-edge-soft px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted hover:border-edge hover:text-ink"
            >
              {t("Troubleshooting")}
            </button>
            <button
              type="button"
              onClick={() => resetCastPreferences(target)}
              className="rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-ink-subtle hover:bg-raised hover:text-ink"
            >
              {t("Reset")}
            </button>
          </div>
        </div>
      </div>
      <div className="flex min-h-[20px] items-center gap-2 rounded-md bg-canvas/50 px-2.5 py-1.5 text-[11px] leading-snug text-ink-muted">
        {props.applying || props.previewBusy ? (
          <Loader2 size={12} className="shrink-0 animate-spin" />
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          {props.applying
            ? t("Applying to the TV…")
            : plan
              ? `${plan.from ? `${plan.from} → ` : ""}${plan.video} · ${plan.audio}${props.preview?.summary.tonemap ? ` · ${t("HDR tone-mapped")}` : ""}${props.preview?.summary.hardware ? ` · ${props.preview.summary.hardware}` : ""}`
              : props.casting
                ? t("Changes apply to the TV right away.")
                : t("These settings apply when you pick a device.")}
        </span>
        {live && live.speed > 0 ? (
          <span className="shrink-0 font-mono tabular-nums text-ink-subtle">
            {live.speed.toFixed(1)}×
          </span>
        ) : null}
      </div>
    </div>
  );
}
