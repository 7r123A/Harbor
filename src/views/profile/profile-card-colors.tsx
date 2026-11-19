import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { normalizeHexColor } from "@/lib/profile-theme";
import type { ProfileCardAppearance } from "@/lib/social/profile-card-appearance-types";
import type { CardAppearancePatch } from "@/lib/social/profile-card-appearance";

export function ProfileCardColors({
  appearance,
  busy,
  onApply,
}: {
  appearance?: ProfileCardAppearance;
  busy: boolean;
  onApply: (patch: CardAppearancePatch) => Promise<void>;
}) {
  const t = useT();
  const [from, setFrom] = useState(appearance?.from ?? "#17171f");
  const [to, setTo] = useState(appearance?.to ?? "#30283f");
  const [accent, setAccent] = useState(appearance?.accent ?? "#7b5cff");
  const [gradient, setGradient] = useState(appearance?.from !== appearance?.to);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFrom(appearance?.from ?? "#17171f");
    setTo(appearance?.to ?? "#30283f");
    setAccent(appearance?.accent ?? "#7b5cff");
    setGradient(appearance?.from !== appearance?.to);
  }, [appearance?.from, appearance?.to, appearance?.accent]);
  const apply = async () => {
    const start = normalizeHexColor(from),
      end = normalizeHexColor(gradient ? to : from),
      tint = normalizeHexColor(accent);
    if (!start || !end || !tint) {
      setError(t("Enter a valid hex color, such as #1a2b3c."));
      return;
    }
    setError(null);
    await onApply({ cardTheme: "custom", cardFrom: start, cardTo: end, cardAccent: tint });
  };
  return (
    <div className="mt-4 rounded-xl bg-canvas/40 p-3 ring-1 ring-edge-soft">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-ink">{t("Custom colors")}</h3>
        <button
          type="button"
          aria-pressed={gradient}
          disabled={busy}
          onClick={() => setGradient(!gradient)}
          className={`rounded-full px-3 py-1 text-xs ring-1 ${gradient ? "bg-accent/15 text-accent ring-accent/40" : "text-ink-muted ring-edge-soft"}`}
        >
          {t("Gradient")}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {[
          {
            label: gradient ? t("Start color") : t("Background color"),
            value: from,
            change: setFrom,
          },
          ...(gradient ? [{ label: t("End color"), value: to, change: setTo }] : []),
          { label: t("Accent"), value: accent, change: setAccent },
        ].map((field) => (
          <label key={field.label} className="flex items-center gap-2 text-xs text-ink-muted">
            <span>{field.label}</span>
            <input
              type="color"
              aria-label={field.label}
              disabled={busy}
              value={normalizeHexColor(field.value) ?? "#17171f"}
              onChange={(event) => field.change(event.target.value)}
              className="h-7 w-8 rounded border-0 bg-transparent p-0"
            />
            <input
              type="text"
              aria-label={t("{label} hex", { label: field.label })}
              value={field.value}
              disabled={busy}
              maxLength={7}
              onChange={(event) => field.change(event.target.value)}
              className="w-24 rounded bg-surface px-2 py-1.5 font-mono text-xs text-ink outline-none ring-1 ring-edge-soft focus:ring-edge"
            />
          </label>
        ))}
      </div>
      <div
        className="mt-3 h-8 rounded-lg ring-1 ring-edge-soft"
        style={{
          background: `linear-gradient(135deg, ${normalizeHexColor(from) ?? "#17171f"}, ${normalizeHexColor(gradient ? to : from) ?? "#17171f"})`,
        }}
      />
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void apply()}
        className="mt-3 min-h-9 rounded-full bg-elevated px-4 text-xs font-semibold text-ink ring-1 ring-edge-soft hover:bg-raised disabled:opacity-60"
      >
        {t("Apply colors")}
      </button>
    </div>
  );
}
