import type { FieldGroups, UiConfig } from '../types';

let cachedUiConfig: UiConfig | null = null;
let cachedFieldGroups: FieldGroups | null = null;

/** Default UI config for external servers (show all fields). */
const DEFAULT_UI_CONFIG: UiConfig = { resources: {} };

/** Default field groups for external servers (no grouping). */
const DEFAULT_FIELD_GROUPS: FieldGroups = {};

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

/** Fetches the field groups mapping from the server. Returns defaults for external servers. */
export const fetchFieldGroups = async (isLocal = true): Promise<FieldGroups> => {
  if (!isLocal) return DEFAULT_FIELD_GROUPS;
  if (cachedFieldGroups) return cachedFieldGroups;
  const res = await fetch('/field-groups');
  if (!res.ok) throw new Error(`Failed to fetch field groups: ${res.statusText}`);
  cachedFieldGroups = await res.json();
  return cachedFieldGroups!;
};
