import { useSyncExternalStore } from "react";
import { currentAuthor, subscribeAuthor } from "@/lib/theme-auth";
import {
  listDmConversations,
  type DmConversation,
  type DmLastMessage,
} from "./dm";

export type DmState = {
  authed: boolean;
  conversations: DmConversation[];
  unread: number;
  loading: boolean;
  error: string | null;
};

export type DmIncoming = {
  conversation: DmConversation;
  message: DmLastMessage;
};

const POLL_MS = 15_000;

let state: DmState = {
  authed: !!currentAuthor(),
  conversations: [],
  unread: 0,
  loading: false,
  error: null,
};
const listeners = new Set<() => void>();
const incomingListeners = new Set<(event: DmIncoming) => void>();

let inFlight: Promise<void> | null = null;
let initialLoaded = false;
const lastSeenMessage = new Map<string, string>();
let stopPolling: (() => void) | null = null;

function emit(): void {
  for (const fn of listeners) fn();
}

function setState(next: Partial<DmState>): void {
  state = { ...state, ...next };
  emit();
}

export function getDmState(): DmState {
  return state;
}

export function subscribeDm(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDmState(): DmState {
  return useSyncExternalStore(subscribeDm, getDmState, getDmState);
}

export function subscribeDmIncoming(fn: (event: DmIncoming) => void): () => void {
  incomingListeners.add(fn);
  return () => {
    incomingListeners.delete(fn);
  };
}

export function dmConversationById(id: string | null): DmConversation | null {
  if (!id) return null;
  return state.conversations.find((c) => c.id === id) ?? null;
}

function notifyIncoming(event: DmIncoming): void {
  for (const fn of incomingListeners) fn(event);
}

function detectIncoming(rows: DmConversation[]): void {
  const seen = new Set<string>();
  for (const conv of rows) {
    seen.add(conv.id);
    const last = conv.lastMessage;
    const prev = lastSeenMessage.get(conv.id);
    if (last) lastSeenMessage.set(conv.id, last.id);
    if (!initialLoaded || !last || last.mine) continue;
    // A new message id is enough; a conversation that first appears already unread
    // is a genuinely new thread, not a replay of old history.
    if (prev ? prev !== last.id : conv.unread > 0) notifyIncoming({ conversation: conv, message: last });
  }
  for (const id of [...lastSeenMessage.keys()]) {
    if (!seen.has(id)) lastSeenMessage.delete(id);
  }
}

export async function refreshDm(opts: { silent?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  if (!currentAuthor()) {
    initialLoaded = false;
    lastSeenMessage.clear();
    setState({ authed: false, conversations: [], unread: 0, loading: false, error: null });
    return;
  }
  if (inFlight) return inFlight;
  if (!opts.silent) setState({ loading: true, error: null });
  inFlight = listDmConversations(opts.signal)
    .then((res) => {
      if (!currentAuthor()) {
        initialLoaded = false;
        lastSeenMessage.clear();
        setState({ authed: false, conversations: [], unread: 0, loading: false, error: null });
        return;
      }
      const conversations = Array.isArray(res.conversations) ? res.conversations : [];
      const unread = Number(res.unread) || 0;
      detectIncoming(conversations);
      initialLoaded = true;
      setState({ authed: true, conversations, unread, loading: false, error: null });
    })
    .catch((err: unknown) => {
      if ((err as { name?: string }).name === "AbortError") return;
      setState({
        loading: false,
        error: err instanceof Error ? err.message : "Messages could not be loaded.",
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Idempotent process-wide polling. The launcher owns the mount for the app's lifetime. */
export function startDmPolling(): () => void {
  if (stopPolling) return stopPolling;

  void refreshDm();
  const tick = () => {
    if (document.hidden) return;
    void refreshDm({ silent: true });
  };
  const timer = window.setInterval(tick, POLL_MS);
  const onVisible = () => {
    if (!document.hidden) void refreshDm({ silent: true });
  };
  const unsubAuthor = subscribeAuthor(() => {
    initialLoaded = false;
    lastSeenMessage.clear();
    void refreshDm();
  });
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", tick);

  stopPolling = () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", tick);
    unsubAuthor();
    stopPolling = null;
  };
  return stopPolling;
}

/** A navigation or share surface can ask the launcher to open without prop drilling. */
const openRequests = new Set<(conversationId?: string) => void>();

export function requestOpenDm(conversationId?: string): void {
  for (const fn of openRequests) fn(conversationId);
}

export function subscribeOpenDm(fn: (conversationId?: string) => void): () => void {
  openRequests.add(fn);
  return () => {
    openRequests.delete(fn);
  };
}
