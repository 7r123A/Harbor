import { useEffect, useState, useSyncExternalStore } from "react";
import { Loader2, Search, SlidersHorizontal, UsersRound, X } from "lucide-react";
import { ModalShell, useModalExit } from "@/components/modal-shell";
import { useT } from "@/lib/i18n";
import { useView } from "@/lib/view";
import { currentAuthor, subscribeAuthor } from "@/lib/theme-auth";
import { fetchFriends } from "@/lib/social/friends";
import type { DiscoverySort } from "@/lib/social/user-discovery";
import { useUserDiscovery } from "./user-discovery/use-user-discovery";
import { DiscoveryUserCard } from "./user-discovery/user-card";

export function UserDiscoveryView({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { openProfile } = useView();
  const { closing, close } = useModalExit(onClose);
  const viewer = useSyncExternalStore(subscribeAuthor, currentAuthor, currentAuthor);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DiscoverySort>("newest");
  const [rated, setRated] = useState(false);
  const [canvas, setCanvas] = useState(false);
  const [friends, setFriends] = useState<Set<string>>(new Set());
  const d = useUserDiscovery({ query, sort, rated, canvas }, viewer?.id);
  useEffect(() => {
    const controller = new AbortController();
    setFriends(new Set());
    if (viewer)
      void fetchFriends(controller.signal)
        .then((rows) => {
          if (!controller.signal.aborted)
            setFriends(new Set(rows.map((row) => row.handle.toLowerCase())));
        })
        .catch(() => {});
    return () => controller.abort();
  }, [viewer?.id]);
  const clear = () => {
    setQuery("");
    setSort("newest");
    setRated(false);
    setCanvas(false);
  };
  return (
    <ModalShell closing={closing} onDismiss={close} width={960} labelledBy="user-discovery-title">
      <div className="min-h-0 overflow-x-hidden overflow-y-auto bg-canvas">
        <main className="relative px-6 pb-6 pt-6">
          <button
            type="button"
            onClick={close}
            title={t("Close")}
            aria-label={t("Close")}
            className="absolute end-4 top-4 grid h-8 w-8 place-items-center rounded-full text-ink-muted hover:bg-elevated hover:text-ink"
          >
            <X size={17} />
          </button>
          <header className="mb-5 pe-8">
            <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-subtle">
              <UsersRound size={14} />
              {t("Community")}
            </span>
            <h1
              id="user-discovery-title"
              className="mt-2 font-display text-2xl font-medium text-ink sm:text-3xl"
            >
              {t("Discover people")}
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-muted">
              {t("Explore Harbor profiles, find new friends, and discover what they rate.")}
            </p>
          </header>
          <section
            aria-label={t("Discover people filters")}
            className="mb-7 rounded-2xl bg-surface p-4 ring-1 ring-edge-soft"
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="flex min-w-0 flex-1 items-center gap-3 rounded-xl bg-canvas px-4 ring-1 ring-edge-soft focus-within:ring-edge">
                <Search size={17} className="text-ink-subtle" />
                <input
                  aria-label={t("Search people")}
                  placeholder={t("Search by name or @handle")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
                />
              </label>
              <label className="flex items-center gap-3 rounded-xl bg-canvas px-4 text-xs text-ink-muted ring-1 ring-edge-soft">
                <SlidersHorizontal size={15} />
                {t("Sort by")}
                <select
                  aria-label={t("Sort people")}
                  value={sort}
                  onChange={(event) => setSort(event.target.value as DiscoverySort)}
                  className="h-12 bg-canvas text-sm text-ink outline-none"
                >
                  <option value="newest">{t("Newest members")}</option>
                  <option value="oldest">{t("Oldest members")}</option>
                  <option value="username">{t("Username A–Z")}</option>
                  <option
                    value="relevance"
                    disabled={[...query.trim().replace(/^@+/, "")].length < 2}
                  >
                    {t("Search relevance")}
                  </option>
                </select>
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {[
                { label: t("Has ratings"), active: rated, toggle: () => setRated(!rated) },
                { label: t("Custom profile"), active: canvas, toggle: () => setCanvas(!canvas) },
              ].map((filter) => (
                <button
                  key={filter.label}
                  type="button"
                  aria-pressed={filter.active}
                  onClick={filter.toggle}
                  className={`min-h-9 rounded-full px-4 text-xs font-medium ring-1 transition-colors ${filter.active ? "bg-accent/15 text-accent ring-accent/50" : "bg-canvas text-ink-muted ring-edge-soft hover:bg-elevated"}`}
                >
                  {filter.label}
                </button>
              ))}
              {(query || rated || canvas || sort !== "newest") && (
                <button
                  type="button"
                  onClick={clear}
                  className="min-h-9 px-2 text-xs text-ink-subtle hover:text-ink"
                >
                  {t("Clear filters")}
                </button>
              )}
            </div>
          </section>
          {d.shortQuery ? (
            <p className="py-14 text-center text-sm text-ink-muted">
              {t("Enter at least 2 characters to search.")}
            </p>
          ) : d.loading ? (
            <div role="status" className="grid place-items-center py-16 text-ink-subtle">
              <Loader2 size={24} className="animate-spin" />
              <span className="mt-3 text-sm">{t("Finding people...")}</span>
            </div>
          ) : (
            <>
              {d.error && (
                <div
                  role="alert"
                  className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-danger/10 p-4 text-sm text-danger"
                >
                  <span>{t("Could not load people. Please try again.")}</span>
                  <button
                    type="button"
                    onClick={() => (d.users.length ? void d.loadMore() : d.reload())}
                    className="rounded-full bg-elevated px-4 py-2 text-ink"
                  >
                    {t("Try again")}
                  </button>
                </div>
              )}
              {!d.error && (
                <p className="mb-4 text-xs text-ink-subtle">
                  {t("{count} people", { count: d.total })}
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {d.users.map((user) => (
                  <DiscoveryUserCard
                    key={`${viewer?.id ?? "anon"}:${user.id}`}
                    user={user}
                    friend={friends.has(user.handle.toLowerCase())}
                    signedIn={!!viewer}
                    onOpen={() => {
                      onClose();
                      openProfile(user.handle);
                    }}
                  />
                ))}
              </div>
              {!d.error && d.users.length === 0 && (
                <div className="rounded-2xl border border-dashed border-edge py-16 text-center">
                  <UsersRound className="mx-auto mb-3 text-ink-subtle" size={30} />
                  <p className="text-sm text-ink-muted">{t("No people match these filters.")}</p>
                  <button type="button" onClick={clear} className="mt-3 text-sm text-accent">
                    {t("Clear filters")}
                  </button>
                </div>
              )}
              {d.hasMore && (
                <div className="mt-8 flex justify-center">
                  <button
                    type="button"
                    disabled={d.loadingMore}
                    onClick={() => void d.loadMore()}
                    className="inline-flex min-h-11 items-center gap-2 rounded-full bg-elevated px-6 text-sm font-semibold text-ink ring-1 ring-edge-soft hover:bg-raised disabled:opacity-60"
                  >
                    {d.loadingMore && <Loader2 size={15} className="animate-spin" />}
                    {d.loadingMore ? t("Loading...") : t("Load more")}
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </ModalShell>
  );
}
