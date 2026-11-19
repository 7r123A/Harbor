import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Palette, Star, UserCheck, UserPlus } from "lucide-react";
import { useT } from "@/lib/i18n";
import { sendFriendRequest } from "@/lib/social/friends";
import { captureSessionScope } from "@/lib/theme-auth";
import { publishFriendStatus, subscribeFriendStatus } from "@/views/profile/context-targets";
import { ProfileCardPanel } from "@/views/profile/profile-card-panel";
import { useProfileCardSummary } from "@/lib/social/profile-card-summary";
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
  const cardRef = useRef<HTMLElement>(null);
  const { summary, failed } = useProfileCardSummary(user.handle, cardRef);
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
    <article ref={cardRef} className="min-w-0">
      <ProfileCardPanel
        profile={
          summary ?? {
            handle: user.handle,
            alias: user.displayName,
            avatarUrl: user.avatarUrl,
            verified: user.verified,
            memberSince: user.memberSince,
          }
        }
        onOpen={onOpen}
        loading={!summary && !failed}
        failed={failed && !summary}
        className="h-full shadow-sm"
        footer={
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                <Star size={13} />
                {t("{count} ratings", { count: user.ratingCount })}
              </span>
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
            {user.hasCanvas && (
              <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-subtle">
                <Palette size={13} />
                {t("Custom profile")}
              </span>
            )}
            {error && (
              <p role="alert" className="mt-3 text-xs text-danger">
                {error}
              </p>
            )}
          </>
        }
      />
    </article>
  );
}
