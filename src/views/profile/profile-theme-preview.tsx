import type { CSSProperties } from "react";
import { useT } from "@/lib/i18n";
import { profileThemeScope, profileThemeBackground, type ProfileTheme } from "@/lib/profile-theme";
import { profileBackgroundUrl } from "@/lib/social/profile-card-appearance";
import { Avatar } from "./profile-bits";
import type { ProfileSummary } from "./profile-types";

export function ProfileThemePreview({
  summary,
  theme,
}: {
  summary: ProfileSummary;
  theme: ProfileTheme;
}) {
  const t = useT();
  const scope = profileThemeScope(theme);
  const banner = profileBackgroundUrl(summary);
  return (
    <section aria-label={t("Profile theme live preview")} className="mt-4">
      <p className="mb-2 text-xs text-ink-muted">{t("Live preview")}</p>
      <div
        data-profile-ui={scope.ui}
        className="overflow-hidden rounded-xl border border-edge-soft text-ink"
        style={
          {
            ...scope.vars,
            ...profileThemeBackground(scope),
            colorScheme: scope.colorScheme,
          } as CSSProperties
        }
      >
        <div className="relative h-20 bg-elevated">
          {banner && <img src={banner} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="relative px-4 pb-4">
          <div className="-mt-6 mb-3 inline-flex rounded-full bg-canvas p-1">
            <Avatar alias={summary.alias} src={summary.avatarUrl} size={48} />
          </div>
          <p className="truncate font-display text-lg font-semibold text-ink">{summary.alias}</p>
          <p className="truncate text-xs text-ink-muted">@{summary.handle}</p>
          <div className="mt-3 flex gap-4 border-b border-edge-soft pb-2 text-xs">
            <span className="font-medium text-accent">{t("About")}</span>
            <span className="text-ink-muted">{t("Ratings")}</span>
            <span className="text-ink-muted">{t("Friends")}</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="rounded-lg bg-surface p-3 ring-1 ring-edge-soft">
              <p className="text-xs font-medium text-ink">{t("About")}</p>
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                {summary.slogan?.trim() || t("Your profile text appears here.")}
              </p>
            </div>
            <div className="flex gap-5 rounded-lg bg-elevated p-3 ring-1 ring-edge-soft">
              <div>
                <p className="text-base font-semibold text-ink">{summary.counts?.watched ?? 0}</p>
                <p className="text-xs text-ink-subtle">{t("Watched")}</p>
              </div>
              <div>
                <p className="text-base font-semibold text-ink">{summary.counts?.friends ?? 0}</p>
                <p className="text-xs text-ink-subtle">{t("Friends")}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-ink-subtle">
        {t("Text colors adjust automatically when needed to stay readable.")}
      </p>
    </section>
  );
}
