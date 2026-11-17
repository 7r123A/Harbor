// Cards, addon requests and meta lookups read these flags many times per render
// pass, and each read used to JSON.parse the whole settings blob. The parse is
// kept per raw string, so any change to the stored settings is still seen at once.
const parsedMirrors = new Map<string, { raw: string; value: Record<string, unknown> }>();

/** Read a settings mirror from localStorage without importing the React settings provider. */
export function readSettingsMirror(key = "harbor.settings"): Record<string, unknown> | null {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  if (raw == null) return null;
  const cached = parsedMirrors.get(key);
  if (cached?.raw === raw) return cached.value;
  const parsed: unknown = JSON.parse(raw);
  const value =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  parsedMirrors.set(key, { raw, value });
  return value;
}

/** Read the active profile's settings mirror without importing the React settings provider. */
export function addonOnlyMetadata(): boolean {
  try {
    return readSettingsMirror()?.addonOnlyMetadata === true;
  } catch {
    return false;
  }
}

export function useTmdbTopMatch(): boolean {
  try {
    return readSettingsMirror()?.searchTmdbTopMatch !== false;
  } catch {
    return true;
  }
}
