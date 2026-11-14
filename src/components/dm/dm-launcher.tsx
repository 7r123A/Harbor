import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, SquarePen, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { subscribeAuthor } from "@/lib/theme-auth";
import { openDmConversation } from "@/lib/social/dm";
import {
  refreshDm,
  startDmPolling,
  subscribeDmIncoming,
  subscribeOpenDm,
  useDmState,
  type DmIncoming,
} from "@/lib/social/dm-store";
import {
  currentDmNotifyMode,
  hydrateDmPrefsFromServer,
} from "@/lib/social/dm-preferences";
import { currentStatus } from "@/lib/social/presence";
import { playDmChime } from "@/lib/social/dm-chime";
import { dmPreview } from "@/lib/social/dm-format";
import { DmAvatar } from "./dm-avatar";
import { DmInbox } from "./dm-inbox";
import { DmNewMessage } from "./dm-new-message";
import { DmThread } from "./dm-thread";

const GLASS_CSS = `
.harbor-dm-glass {
  position: fixed;
  z-index: 200;
  right: 16px;
  height: 52px;
  padding: 0 16px;
  border-radius: 999px;
  background: rgba(20, 18, 16, 0.62);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.22);
  opacity: 0.86;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  animation: harbor-dm-bob 3.6s ease-in-out infinite;
  transition: opacity 0.22s, transform 0.22s, background 0.22s;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #f5f2ee;
  cursor: pointer;
}
.harbor-dm-glass .harbor-dm-label {
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  white-space: nowrap;
  transition: max-width 0.28s ease, opacity 0.2s ease;
  font: 600 13px/1 system-ui, sans-serif;
}
.harbor-dm-glass:hover .harbor-dm-label,
.harbor-dm-glass:focus-visible .harbor-dm-label {
  max-width: 140px;
  opacity: 1;
}
.harbor-dm-glass:hover,
.harbor-dm-glass:focus-visible {
  opacity: 1;
  transform: translateY(-3px);
  background: rgba(20, 18, 16, 0.92);
  animation-play-state: paused;
}
.harbor-dm-glass:active { transform: translateY(-1px) scale(0.97); }
.harbor-dm-glass:focus-visible { outline: 3px solid var(--amber, #f59e0b); outline-offset: 2px; }
.harbor-dm-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border-radius: 999px;
  background: #e94f37;
  border: 2px solid #12100e;
  color: #fff;
  font: 800 11px/1 system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
@keyframes harbor-dm-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}
@media (hover: none) {
  .harbor-dm-glass { opacity: 0.85; }
  .harbor-dm-glass:hover { transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .harbor-dm-glass { animation: none !important; transition: none !important; }
}
`;

const TOAST_MS = 6_500;

/**
 * Detect actual media playback so the launcher can get out of the player's way.
 * Listening in the capture phase catches every <video> the app mounts, including
 * ones created after this component. The poll is a fallback for players that
 * swap sources without firing play/pause on the document.
 */
function usePlaybackActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const sync = () => {
      const videos = Array.from(document.querySelectorAll("video"));
      setActive(
        videos.some((video) => !video.paused && !video.ended && video.readyState >= 2),
      );
    };
    sync();
    document.addEventListener("play", sync, true);
    document.addEventListener("pause", sync, true);
    document.addEventListener("ended", sync, true);
    document.addEventListener("loadedmetadata", sync, true);
    document.addEventListener("fullscreenchange", sync);
    const timer = window.setInterval(sync, 4_000);
    return () => {
      document.removeEventListener("play", sync, true);
      document.removeEventListener("pause", sync, true);
      document.removeEventListener("ended", sync, true);
      document.removeEventListener("loadedmetadata", sync, true);
      document.removeEventListener("fullscreenchange", sync);
      window.clearInterval(timer);
    };
  }, []);
  return active;
}

type ToastState = { event: DmIncoming; key: number };

/** A speech bubble with three live dots: reads as messaging even at rest. */
function DmGlyph({ size = 21 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="shrink-0 transition-transform duration-300 group-hover:scale-105"
    >
      <path
        d="M7.5 3.5h9A3.5 3.5 0 0 1 20 7v6a3.5 3.5 0 0 1-3.5 3.5h-5.4l-3.1 2.55a.6.6 0 0 1-.95-.47V16.5H7.5A3.5 3.5 0 0 1 4 13V7a3.5 3.5 0 0 1 3.5-3.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle className="harbor-dm-dot" cx="8.6" cy="10.2" r="1.1" fill="currentColor" />
      <circle className="harbor-dm-dot harbor-dm-dot-2" cx="12" cy="10.2" r="1.1" fill="currentColor" />
      <circle className="harbor-dm-dot harbor-dm-dot-3" cx="15.4" cy="10.2" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function DmLauncher({ playing: playerPlaying = false }: { playing?: boolean } = {}) {
  const t = useT();
  const dm = useDmState();
  const mediaPlaying = usePlaybackActive();
  const playing = playerPlaying || mediaPlaying;

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const openRef = useRef(open);
  const selectedRef = useRef(selected);
  openRef.current = open;
  selectedRef.current = selected;

  // One poller for the whole app, owned by the launcher because it lives for the
  // entire session. It also reacts to account switches internally.
  useEffect(() => startDmPolling(), []);

  useEffect(() => {
    void hydrateDmPrefsFromServer();
    return subscribeAuthor(() => {
      setOpen(false);
      setSelected(null);
      setComposing(false);
      setToast(null);
      void hydrateDmPrefsFromServer();
    });
  }, []);

  useEffect(
    () =>
      subscribeOpenDm((conversationId) => {
        setOpen(true);
        if (conversationId) {
          setComposing(false);
          setSelected(conversationId);
          void refreshDm({ silent: true });
        }
      }),
    [],
  );

  // Incoming messages follow the owner's notification mode, conversation mute,
  // and Do Not Disturb. Silent/DND still update the unread badge: the alert is
  // what is suppressed, never the message.
  useEffect(
    () =>
      subscribeDmIncoming((event) => {
        if (event.conversation.muted) return;
        if (currentStatus() === "dnd") return;
        if (
          openRef.current &&
          selectedRef.current === event.conversation.id &&
          document.visibilityState === "visible"
        ) {
          return;
        }
        const mode = currentDmNotifyMode();
        if (mode === "silent") return;
        if (mode === "preview") setToast({ event, key: Date.now() });
        playDmChime();
      }),
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // If playback starts while the panel is open, minimize it so the player's own
  // controls stay reachable. Nothing is paused; the panel can be reopened from
  // the pill at any time.
  const wasPlaying = useRef(playing);
  useEffect(() => {
    if (playing && !wasPlaying.current) setOpen(false);
    wasPlaying.current = playing;
  }, [playing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const openConversation = useCallback((conversationId: string) => {
    setComposing(false);
    setSelected(conversationId);
    setOpen(true);
    void refreshDm({ silent: true });
  }, []);

  const handlePick = useCallback(async (userId: string) => {
    const conversation = await openDmConversation(userId);
    setComposing(false);
    setSelected(conversation.id);
    setOpen(true);
    await refreshDm({ silent: true });
  }, []);

  if (!dm.authed) return null;

  const unread = dm.unread;
  const unreadLabel = unread > 99 ? "99+" : String(unread);

  const bottomBase = "var(--harbor-music-dock, 0px) + var(--harbor-viewport-bottom, 0px)";
  const launcherBottom = playing
    ? `calc(5.25rem + var(--harbor-viewport-bottom, 0px))`
    : `calc(1.25rem + ${bottomBase})`;
  const panelBottom = playing
    ? `calc(5.25rem + var(--harbor-viewport-bottom, 0px))`
    : `calc(1.25rem + ${bottomBase})`;

  return (
    <>
      <style>{GLASS_CSS}</style>
      {!open &&
        createPortal(
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={unread > 0 ? t("Messages ({count} unread)", { count: unread }) : t("Messages")}
            aria-haspopup="dialog"
            className="harbor-dm-glass"
            style={{ bottom: launcherBottom }}
          >
            <DmGlyph size={20} />
            <span className="harbor-dm-label">{t("Messages")}</span>
            {unread > 0 && <span className="harbor-dm-badge">{unreadLabel}</span>}
          </button>,
          document.body,
        )}

      {open &&
        createPortal(
          <div
            role="dialog"
            aria-label={t("Messages")}
            className="animate-panel-in fixed end-3 z-[220] flex w-[min(380px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-md bg-surface shadow-[0_18px_50px_-14px_rgba(0,0,0,0.65)] ring-1 ring-edge-soft"
            style={{
              bottom: panelBottom,
              height: playing
                ? "min(440px, calc(100dvh - 7rem - var(--harbor-viewport-bottom, 0px)))"
                : `min(560px, calc(100dvh - 2rem - ${bottomBase}))`,
            }}
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-edge-soft px-3 py-2.5">
              <span className="text-[14px] font-semibold tracking-tight text-ink">
                {t("Messages")}
              </span>
              {unread > 0 && (
                <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold tabular-nums text-canvas">
                  {unreadLabel}
                </span>
              )}
              <div className="ms-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setComposing(true);
                    setSelected(null);
                  }}
                  aria-label={t("New message")}
                  className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
                >
                  <SquarePen size={15} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={t("Minimize messages")}
                  className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
                >
                  <Minus size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setSelected(null);
                    setComposing(false);
                  }}
                  aria-label={t("Close messages")}
                  className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
                >
                  <X size={16} aria-hidden />
                </button>
              </div>
            </div>

            {selected ? (
              <DmThread
                conversationId={selected}
                onBack={() => setSelected(null)}
                onClose={() => setOpen(false)}
              />
            ) : composing ? (
              <DmNewMessage
                onPick={handlePick}
                onCancel={() => {
                  setComposing(false);
                  setSelected(null);
                }}
              />
            ) : (
              <DmInbox
                conversations={dm.conversations}
                loading={dm.loading}
                error={dm.error}
                onOpen={openConversation}
                onCompose={() => setComposing(true)}
                onRetry={() => void refreshDm()}
              />
            )}
          </div>,
          document.body,
        )}

      {toast &&
        createPortal(
          <div
            key={toast.key}
            role="status"
            className="animate-panel-in fixed end-4 z-[230] w-[min(340px,calc(100vw-2rem))] rounded-xl bg-surface shadow-[0_12px_36px_-12px_rgba(0,0,0,0.6)] ring-1 ring-edge-soft"
            style={{ top: "calc(5rem + var(--harbor-viewport-bottom, 0px))" }}
          >
            <button
              type="button"
              onClick={() => {
                openConversation(toast.event.conversation.id);
                setToast(null);
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 pe-9 text-start transition-colors hover:bg-elevated"
            >
              <DmAvatar user={toast.event.conversation.other} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-ink">
                  {toast.event.conversation.other?.displayName ?? t("New message")}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-ink-subtle">
                  {dmPreview(toast.event.message.body, t("New message"))}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label={t("Dismiss")}
              className="absolute end-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-ink-subtle transition-colors hover:bg-elevated hover:text-ink"
            >
              <X size={14} aria-hidden />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
