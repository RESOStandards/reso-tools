import type { FieldGroups, UiConfig } from '../types';

let cachedUiConfig: UiConfig | null = null;
let cachedFieldGroups: FieldGroups | null = null;

/** Default UI config for external servers (show all fields). */
const DEFAULT_UI_CONFIG: UiConfig = { resources: {} };


/** Clear config caches. Called when switching servers. */
export const clearConfigCache = (): void => {
  cachedUiConfig = null;
  cachedFieldGroups = null;
};

/** Fetches the UI config from the server. Returns defaults for external servers. */
export const fetchUiConfig = async (isLocal = true): Promise<UiConfig> => {
  if (!isLocal) return DEFAULT_UI_CONFIG;
  if (cachedUiConfig) return cachedUiConfig;
  const res = await fetch('/ui-config');
  if (!res.ok) throw new Error(`Failed to fetch UI config: ${res.statusText}`);
  cachedUiConfig = await res.json();
  return cachedUiConfig!;
};

/**
 * Fetches the DD field groups mapping from the bundled static asset.
 * These are standard RESO Data Dictionary groupings that apply to any RESO server.
 */
export const fetchFieldGroups = async (): Promise<FieldGroups> => {
  if (cachedFieldGroups) return cachedFieldGroups;
  const res = await fetch('/field-groups.json');
  if (!res.ok) throw new Error(`Failed to fetch field groups: ${res.statusText}`);
  cachedFieldGroups = await res.json();
  return cachedFieldGroups!;
};
