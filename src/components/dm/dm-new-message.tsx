import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Search } from "lucide-react";
import { useT } from "@/lib/i18n";
import { fetchFriends, type Friend } from "@/lib/social/friends";
import { searchDmUsers, type DmDirectoryUser, type DmPresence } from "@/lib/social/dm";
import { DmAvatar } from "./dm-avatar";

type Candidate = {
  id?: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  verified?: boolean;
  presence?: DmPresence;
};

function fromFriend(f: Friend): Candidate {
  return {
    id: f.id,
    handle: f.handle,
    displayName: f.alias || f.handle,
    avatarUrl: f.avatarUrl,
    presence: f.presence,
  };
}

function fromDirectory(u: DmDirectoryUser): Candidate {
  return {
    id: u.id,
    handle: u.handle,
    displayName: u.displayName || u.handle,
    avatarUrl: u.avatarUrl,
    verified: u.verified,
  };
}

export function DmNewMessage({
  onPick,
  onCancel,
}: {
  onPick: (userId: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DmDirectoryUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fetchFriends(ac.signal)
      .then((rows) => {
        if (!ac.signal.aborted) setFriends(rows);
      })
      .catch(() => {
        if (!ac.signal.aborted) setFriends([]);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const ac = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchDmUsers(q, ac.signal)
        .then((rows) => {
          if (!ac.signal.aborted) setResults(rows);
        })
        .catch(() => {
          if (!ac.signal.aborted) setResults([]);
        })
        .finally(() => {
          if (!ac.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query]);

  const rows = useMemo<Candidate[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length >= 2) return results.map(fromDirectory);
    const source = friends.map(fromFriend);
    if (!q) return source;
    return source.filter((f) =>
      `${f.displayName} ${f.handle}`.toLowerCase().includes(q),
    );
  }, [friends, results, query]);

  const pick = async (candidate: Candidate) => {
    if (picking) return;
    setError(null);
    setPicking(candidate.handle);
    try {
      let id = candidate.id;
      if (!id) {
        const found = await searchDmUsers(candidate.handle);
        id = found.find((u) => u.handle.toLowerCase() === candidate.handle.toLowerCase())?.id;
      }
      if (!id) throw new Error("This person could not be found.");
      await onPick(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The conversation could not be opened.");
    } finally {
      setPicking(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-2 pb-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("Back")}
          className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
        >
          <ArrowLeft size={17} aria-hidden />
        </button>
        <h3 className="text-[14px] font-semibold text-ink">{t("New message")}</h3>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-full bg-elevated px-3 text-ink-subtle ring-1 ring-edge-soft focus-within:ring-edge">
          <Search size={15} aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search people")}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
          />
          {searching && <Loader2 size={14} className="animate-spin" aria-hidden />}
        </label>
      </div>

      {error && (
        <p className="mx-3 mb-2 rounded-md bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && rows.length === 0 ? (
          <div className="grid place-items-center py-10 text-ink-subtle">
            <Loader2 size={18} className="animate-spin" aria-hidden />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12.5px] text-ink-subtle">
            {query.trim().length >= 2
              ? t("No one matches that search.")
              : t("Add a friend, or search for someone by name or handle.")}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {rows.map((c) => (
              <li key={c.handle}>
                <button
                  type="button"
                  disabled={!!picking}
                  onClick={() => void pick(c)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-start transition-colors hover:bg-elevated disabled:opacity-60"
                >
                  <DmAvatar user={{ displayName: c.displayName, avatarUrl: c.avatarUrl, presence: c.presence }} showPresence />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">
                      {c.displayName}
                    </span>
                    <span className="block truncate text-[11.5px] text-ink-subtle">@{c.handle}</span>
                  </span>
                  {picking === c.handle && <Loader2 size={15} className="animate-spin text-ink-subtle" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
