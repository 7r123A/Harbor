import { useSyncExternalStore } from "react";
import { currentAuthor } from "@/lib/theme-auth";
import { socialGet, socialPatch } from "./client";

export type DmPolicy = "everyone" | "friends";
export type DmNotifyMode = "sound" | "preview" | "silent";

const POLICY_KEY = "harbor.dm.policy";
const MODE_KEY = "harbor.dm.notify-mode";

function readPolicy(): DmPolicy {
  try {
    return localStorage.getItem(POLICY_KEY) === "everyone" ? "everyone" : "friends";
  } catch {
    return "friends";
  }
}

function readMode(): DmNotifyMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "sound" || v === "preview" || v === "silent") return v;
  } catch {
    /* ignore */
  }
  return "preview";
}

let prefs = { policy: readPolicy(), mode: readMode() };
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function currentDmPolicy(): DmPolicy {
  return prefs.policy;
}

export function currentDmNotifyMode(): DmNotifyMode {
  return prefs.mode;
}

export function subscribeDmPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDmPrefs(): { policy: DmPolicy; mode: DmNotifyMode } {
  return useSyncExternalStore(subscribeDmPrefs, () => prefs, () => prefs);
}

function store(policy: DmPolicy, mode: DmNotifyMode): void {
  prefs = { policy, mode };
  try {
    localStorage.setItem(POLICY_KEY, policy);
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
  emit();
}

export function applyDmPrefsFromSummary(summary: {
  dmPolicy?: DmPolicy;
  dmNotifyMode?: DmNotifyMode;
} | null | undefined): void {
  if (!summary) return;
  const policy =
    summary.dmPolicy === "everyone" || summary.dmPolicy === "friends"
      ? summary.dmPolicy
      : prefs.policy;
  const mode =
    summary.dmNotifyMode === "sound" || summary.dmNotifyMode === "silent"
      ? summary.dmNotifyMode
      : summary.dmNotifyMode === "preview"
        ? "preview"
        : prefs.mode;
  if (policy === prefs.policy && mode === prefs.mode) return;
  store(policy, mode);
}

/** Pull the owner's settings once per launch, so a change made elsewhere follows. */
export async function hydrateDmPrefsFromServer(): Promise<void> {
  const me = currentAuthor();
  if (!me?.handle) return;
  try {
    const summary = await socialGet<{ dmPolicy?: DmPolicy; dmNotifyMode?: DmNotifyMode }>(
      `/social/u/${encodeURIComponent(me.handle)}`,
    );
    applyDmPrefsFromSummary(summary);
  } catch {
    /* defaults are safe; the settings panel can retry on save */
  }
}

async function patch(body: Record<string, unknown>): Promise<void> {
  await socialPatch("/social/me/profile", body);
}

export async function saveDmPolicy(next: DmPolicy): Promise<void> {
  const prev = prefs.policy;
  if (next === prev) return;
  store(next, prefs.mode);
  try {
    await patch({ dmPolicy: next });
  } catch (err) {
    store(prev, prefs.mode);
    throw err;
  }
}

export async function saveDmNotifyMode(next: DmNotifyMode): Promise<void> {
  const prev = prefs.mode;
  if (next === prev) return;
  store(prefs.policy, next);
  try {
    await patch({ dmNotifyMode: next });
  } catch (err) {
    store(prefs.policy, prev);
    throw err;
  }
}
