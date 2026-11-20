import type { CSSProperties } from "react";
import { Clock3, Film, Star, UsersRound } from "lucide-react";
import { useT } from "@/lib/i18n";
import { profileThemeScope, profileThemeBackground, type ProfileTheme } from "@/lib/profile-theme";
import { profileBackgroundUrl } from "@/lib/social/profile-card-appearance";
import { Avatar, VerifiedCheck } from "./profile-bits";
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
  const ratings = summary.ratings;
  const recent = ratings?.recent.slice(0, 4) ?? [];
  const bio =
    summary.slogan?.trim() ||
    summary.description
      ?.replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return (
    <section
      aria-label={t("Profile appearance")}
      className="mt-4 overflow-hidden rounded-2xl border border-edge-soft text-ink"
      style={
        {
          ...scope.vars,
          ...profileThemeBackground(scope),
          colorScheme: scope.colorScheme,
        } as CSSProperties
      }
      data-profile-ui={scope.ui}
    >
      <div
        className="relative h-28 overflow-hidden sm:h-32"
        style={
          !banner
            ? {
                background:
                  "linear-gradient(125deg, var(--color-elevated), var(--color-surface) 60%, var(--color-canvas))",
              }
            : undefined
        }
      >
        {banner && (
          <img src={banner} alt="" draggable={false} className="h-full w-full object-cover" />
        )}
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(to bottom, transparent 25%, var(--color-canvas))" }}
        />
      </div>
      <div className="relative -mt-10 px-5 pb-5">
        <div className="flex min-w-0 items-end gap-3">
          <div className="shrink-0 rounded-full bg-canvas p-1">
            <Avatar
              alias={summary.alias}
              src={summary.avatarUrl}
              size={64}
              online={summary.online}
            />
          </div>
          <div className="min-w-0 pb-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate font-display text-xl font-semibold text-ink">
                {summary.alias}
              </h3>
              {summary.verified && <VerifiedCheck size={15} />}
            </div>
            <p className="mt-0.5 truncate text-xs text-ink-muted">@{summary.handle}</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            { icon: Clock3, label: t("Hours watched"), value: summary.counts?.hoursWatched ?? 0 },
            { icon: Film, label: t("Watched"), value: summary.counts?.watched ?? 0 },
            { icon: UsersRound, label: t("Friends"), value: summary.counts?.friends ?? 0 },
          ].map(({ icon: Icon, label, value }) => (
            <div
              key={label}
              className="rounded-lg bg-surface px-2 py-2.5 text-center ring-1 ring-edge-soft"
            >
              <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-ink">
                <Icon size={12} className="text-accent" />
                {value.toLocaleString()}
              </div>
              <p className="mt-1 truncate text-[10px] text-ink-subtle">{label}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="min-w-0 rounded-xl bg-surface p-3.5 ring-1 ring-edge-soft">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium text-ink-muted">
                <Star size={13} className="text-accent" />
                {t("Ratings")}
              </span>
              <span className="tabular-nums text-ink-subtle">{ratings?.count ?? 0}</span>
            </div>
            {recent.length ? (
              <div className="mt-3 grid grid-cols-4 gap-2">
                {recent.map((rating) => (
                  <div key={rating.mediaType + rating.itemKey} className="min-w-0">
                    <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-elevated">
                      {rating.posterUrl ? (
                        <img
                          src={rating.posterUrl}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Film
                          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-ink-subtle"
                          size={18}
                        />
                      )}
                      <span className="absolute end-1 top-1 rounded bg-canvas/85 px-1 text-[9px] font-semibold text-ink">
                        {rating.score}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[9px] text-ink-muted">{rating.title}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex min-h-20 items-center justify-center gap-2 rounded-lg border border-dashed border-edge-soft text-xs text-ink-subtle">
                <Star size={16} />
                {t("No ratings yet")}
              </div>
            )}
          </div>
          <div className="min-w-0 rounded-xl bg-surface p-3.5 ring-1 ring-edge-soft">
            <h4 className="text-xs font-medium text-ink-muted">{t("About")}</h4>
            {bio && <p className="mt-3 line-clamp-5 text-xs leading-relaxed text-ink">{bio}</p>}
            <div className="mt-4 flex items-center gap-2">
              <span className="h-1 w-6 rounded-full bg-accent" />
              <span className="h-1 w-3 rounded-full bg-accent/30" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
