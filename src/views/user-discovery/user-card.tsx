import { useEffect, useState } from "react";
import { Check, Loader2, Palette, Star, UserCheck, UserPlus } from "lucide-react";
import { useT } from "@/lib/i18n";
import { sendFriendRequest } from "@/lib/social/friends";
import { captureSessionScope } from "@/lib/theme-auth";
import { publishFriendStatus, subscribeFriendStatus } from "@/views/profile/context-targets";
import { Avatar, VerifiedCheck } from "@/views/profile/profile-bits";
import { UserHoverCard } from "@/views/profile/user-hover-card";
import type { DiscoveredUser } from "@/lib/social/user-discovery";

export function DiscoveryUserCard({
  user,
  friend,
  signedIn,
  onOpen,
}: {
  user: DiscoveredUser;
  friend: boolean;
  signedIn: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<"idle" | "sending" | "requested" | "friends">(
    friend ? "friends" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (friend) setState("friends");
  }, [friend]);
  useEffect(
    () =>
      subscribeFriendStatus((handle, status) => {
        if (handle.toLowerCase() === user.handle.toLowerCase())
          setState(status === "friends" ? "friends" : status === "outgoing" ? "requested" : "idle");
      }),
    [user.handle],
  );
  const add = async () => {
    if (state !== "idle" || !signedIn) return;
    const isCurrent = captureSessionScope();
    setState("sending");
    setError(null);
    try {
      const { edge } = await sendFriendRequest(user.handle);
      if (!isCurrent()) return;
      const accepted = edge.status === "accepted" || edge.status === "friends";
      setState(accepted ? "friends" : "requested");
      publishFriendStatus(user.handle, accepted ? "friends" : "outgoing");
    } catch (reason) {
      if (!isCurrent()) return;
      setState("idle");
      setError(reason instanceof Error ? reason.message : t("Could not send request."));
    }
  };
  return (
    <article className="flex min-w-0 flex-col rounded-2xl bg-surface p-5 ring-1 ring-edge-soft transition-colors hover:ring-edge">
      <div className="flex items-start justify-between gap-3">
        <UserHoverCard handle={user.handle}>
          <button
            type="button"
            onClick={onOpen}
            aria-label={t("Open {alias} profile", { alias: user.displayName })}
            className="shrink-0 rounded-full"
          >
            <Avatar src={user.avatarUrl} size={56} alias={user.displayName} />
          </button>
        </UserHoverCard>
        <button
          type="button"
          onClick={() => void add()}
          disabled={!signedIn || state !== "idle"}
          title={!signedIn ? t("Sign in to add friends") : undefined}
          className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors disabled:cursor-default ${state === "friends" ? "bg-success/10 text-success" : state === "requested" ? "bg-elevated text-ink-muted" : "bg-elevated text-ink hover:bg-raised"}`}
        >
          {state === "sending" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : state === "friends" ? (
            <UserCheck size={14} />
          ) : state === "requested" ? (
            <Check size={14} />
          ) : (
            <UserPlus size={14} />
          )}
          {state === "friends"
            ? t("Friends")
            : state === "requested"
              ? t("Requested")
              : state === "sending"
                ? t("Sending...")
                : t("Add")}
        </button>
      </div>
      <UserHoverCard handle={user.handle}>
        <button type="button" onClick={onOpen} className="mt-4 min-w-0 text-start">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-base font-semibold text-ink">{user.displayName}</span>
            {user.verified && <VerifiedCheck size={15} />}
          </span>
          <span className="block truncate text-xs text-ink-subtle">@{user.handle}</span>
        </button>
      </UserHoverCard>
      <div className="mt-5 flex flex-wrap gap-3 border-t border-edge-soft pt-3 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <Star size={13} />
          {t("{count} ratings", { count: user.ratingCount })}
        </span>
        {user.hasCanvas && (
          <span className="inline-flex items-center gap-1.5">
            <Palette size={13} />
            {t("Custom profile")}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </article>
  );
}
