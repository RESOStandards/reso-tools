import { useEffect, useState } from 'react';

interface UpdateInfo {
  readonly tagName: string;
  readonly url: string;
  readonly name: string;
}

interface ElectronUpdatesApi {
  readonly onUpdateAvailable: (callback: (release: UpdateInfo) => void) => void;
}

/** Listens for update notifications from the Electron main process. */
export const useUpdateCheck = (): UpdateInfo | null => {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    const api = (window as unknown as { electronUpdates?: ElectronUpdatesApi }).electronUpdates;
    if (api) {
      api.onUpdateAvailable(setUpdate);
    }
  }, []);

  return update;
};
