import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { socialGet } from "@/lib/social/client";
import { reviewPresence, sharedTerms, uniqueTerms } from "@/lib/social/review-compare";
import { mutualScoreTone } from "@/lib/social/mutual-score";

type Side = { review?: string | null; reviewId?: string | null };

type MutualRow = Side & {
  itemKey: string;
  mediaType?: string;
  title: string;
  posterUrl?: string;
  myScore: number;
  theirScore: number;
  diff: number;
  myReview: string | null;
  theirReview: string | null;
  myLikes: number;
  theirLikes: number;
  myComments: number;
  theirComments: number;
};

type MutualResponse = {
  score: number | null;
  count: number;
  reviewedCount: number;
  page: MutualRow[];
  nextCursor?: string;
  total: number;
};

function Comparison({ row }: { row: MutualRow }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const presence = reviewPresence(row.myReview, row.theirReview);
  const shared = sharedTerms(row.myReview, row.theirReview);
  const mineOnly = uniqueTerms(row.myReview, row.theirReview);
  const theirsOnly = uniqueTerms(row.theirReview, row.myReview);
  return (
    <li className="rounded-lg bg-canvas/40 ring-1 ring-edge-soft">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-2.5 text-start"
        aria-expanded={open}
      >
        <span className="h-[54px] w-[38px] shrink-0 overflow-hidden rounded bg-elevated">
          {row.posterUrl ? (
            <img src={row.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{row.title}</span>
          <span className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-subtle">
            <span className="tabular-nums">
              {t("You {mine}/{max}", { mine: row.myScore, max: 10 })}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {t("Them {theirs}/{max}", { theirs: row.theirScore, max: 10 })}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{t("{n} apart", { n: row.diff })}</span>
          </span>
        </span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-ink-subtle transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="grid gap-2 border-t border-edge-soft p-2.5 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              {t("My rating")} · {row.myScore}/10
            </p>
            {row.myReview ? (
              <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-muted">
                {row.myReview}
              </p>
            ) : (
              <p className="mt-1 text-[12.5px] italic text-ink-subtle">{t("No written review")}</p>
            )}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              {t("Their rating")} · {row.theirScore}/10
            </p>
            {row.theirReview ? (
              <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-muted">
                {row.theirReview}
              </p>
            ) : (
              <p className="mt-1 text-[12.5px] italic text-ink-subtle">{t("No written review")}</p>
            )}
          </div>
          {presence === "both" && (
            <div className="space-y-1 text-[11.5px] text-ink-subtle sm:col-span-2">
              <p>
                {shared.length > 0
                  ? `${t("Words both reviews use")}: ${shared.join(", ")}`
                  : t("Both reviews use no word in common.")}
              </p>
              {mineOnly.length > 0 && (
                <p>
                  {t("Words only your review uses")}: {mineOnly.join(", ")}
                </p>
              )}
              {theirsOnly.length > 0 && (
                <p>
                  {t("Words only their review uses")}: {theirsOnly.join(", ")}
                </p>
              )}
              <p>{t("These are word overlaps and differences, not interpreted opinions.")}</p>
            </div>
          )}
          {presence === "mine-only" && (
            <p className="text-[11.5px] text-ink-subtle sm:col-span-2">
              {t("Only you wrote a review for this title.")}
            </p>
          )}
          {presence === "theirs-only" && (
            <p className="text-[11.5px] text-ink-subtle sm:col-span-2">
              {t("Only they wrote a review for this title.")}
            </p>
          )}
          {presence !== "neither" && (
            <p className="text-[11.5px] text-ink-subtle sm:col-span-2">
              {t(
                "The match score uses the numbers only; the shared wording above is quoted, not interpreted.",
              )}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function MutualRatingsCard({ handle, isOwner }: { handle: string; isOwner: boolean }) {
  const t = useT();
  const [data, setData] = useState<MutualResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [sort, setSort] = useState<"recent" | "highest" | "difference">("recent");
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (isOwner) return;
    let alive = true;
    setState("loading");
    socialGet<MutualResponse>(
      `/social/u/${encodeURIComponent(handle)}/mutual?sort=${sort}&limit=12`,
    )
      .then((body) => {
        if (!alive) return;
        setData(body);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [handle, isOwner, sort]);

  // Comparing you with yourself is not a thing.
  if (isOwner) return null;

  const tone = data && data.score != null ? mutualScoreTone(data.score) : null;
  const loadMore = async () => {
    if (!data?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await socialGet<MutualResponse>(
        `/social/u/${encodeURIComponent(handle)}/mutual?sort=${sort}&limit=12&cursor=${encodeURIComponent(data.nextCursor)}`,
      );
      setData((current) => (current ? { ...next, page: [...current.page, ...next.page] } : next));
    } catch {
      setState("error");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section
      aria-label={t("Mutual ratings")}
      className="mt-3 rounded-lg bg-surface p-5 ring-1 ring-edge-soft"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">
          {t("Mutual ratings")}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          aria-label={t("Sort mutual ratings")}
          className="h-8 rounded-full bg-elevated/60 px-2.5 text-[12px] text-ink-muted outline-none"
        >
          <option value="recent">{t("Most recent")}</option>
          <option value="highest">{t("Highest mutual")}</option>
          <option value="difference">{t("Biggest differences")}</option>
        </select>
      </div>

      {state === "loading" && (
        <div className="flex justify-center py-6 text-ink-subtle">
          <Loader2 size={16} className="animate-spin" />
        </div>
      )}

      {state === "error" && (
        <p className="py-4 text-[12.5px] text-ink-muted">
          {t("Mutual ratings could not be loaded.")}
        </p>
      )}

      {state === "ready" && data && (
        <>
          {data.score == null ? (
            <div className="rounded-lg bg-canvas/40 p-4 ring-1 ring-edge-soft">
              <p className="text-[14px] font-semibold text-ink">
                {t("Not enough shared ratings yet")}
              </p>
              <p className="mt-1 text-[12.5px] text-ink-muted">{t("0 mutual ratings")}</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <div
                className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full ring-2 ${tone?.ring ?? ""}`}
              >
                <span className={`text-[19px] font-bold tabular-nums ${tone?.text ?? "text-ink"}`}>
                  {data.score}%
                </span>
              </div>
              <div className="min-w-0">
                <p
                  className={`text-[13px] font-bold uppercase tracking-wide ${tone?.text ?? "text-ink"}`}
                >
                  {t("Match")}
                </p>
                <p className="text-[12.5px] text-ink-muted">
                  {t("Based on {n} mutual ratings", { n: data.count })}
                </p>
                <p className="text-[11.5px] text-ink-subtle">
                  {tone?.label ? t(tone.label) : ""}
                  {data.count < 5 ? ` · ${t("small sample")}` : ""}
                </p>
              </div>
            </div>
          )}

          {data.page.length > 0 && (
            <ul className="mt-4 grid gap-2">
              {data.page.map((row) => (
                <Comparison key={`${row.mediaType}:${row.itemKey}`} row={row} />
              ))}
            </ul>
          )}
          {data.page.length > 0 && data.total > data.page.length && (
            <>
              <p className="mt-2 text-[11.5px] text-ink-subtle">
                {t("Showing {shown} of {total}", { shown: data.page.length, total: data.total })}
              </p>
              {data.nextCursor && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-elevated/50 text-[12.5px] font-medium text-ink-muted transition-colors enabled:hover:text-ink disabled:opacity-60"
                >
                  {loadingMore && <Loader2 size={13} className="animate-spin" />}
                  {t("Load more")}
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
