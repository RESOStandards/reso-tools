import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, shell } from 'electron';
import { resolve } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/** Write diagnostic messages to a log file in the user data directory. */
const logFile = (): string => resolve(app.getPath('userData'), 'reso-desktop.log');
const log = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(logFile(), line); } catch { /* ignore */ }
  console.log(msg);
};

// Override default "Electron" name shown in macOS menu bar and dock
app.setName('RESO Desktop Client');

// ── Persistent storage (encrypted when safeStorage is available, plain JSON otherwise) ──

/** Path to the storage file in the user data directory. */
const storageFilePath = (): string => resolve(app.getPath('userData'), 'secure-storage.json');

/** Whether OS-level encryption (Keychain/DPAPI/libsecret) is available. */
const canEncrypt = (): boolean => safeStorage.isEncryptionAvailable();

/** Read the entire store as a Record<string, string>. */
const readStore = (): Record<string, string> => {
  try {
    const raw = readFileSync(storageFilePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const encrypted = canEncrypt();
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        result[key] = encrypted
          ? safeStorage.decryptString(Buffer.from(value, 'base64'))
          : value;
      }
    }
    return result;
  } catch {
    return {};
  }
};

/** Write the store, encrypting values when safeStorage is available. */
const writeStore = (store: Record<string, string>): void => {
  const encrypted = canEncrypt();
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(store)) {
    output[key] = encrypted
      ? safeStorage.encryptString(value).toString('base64')
      : value;
  }
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(storageFilePath(), JSON.stringify(output, null, 2), 'utf-8');
};

/** Register IPC handlers for secure storage operations. */
const registerStorageHandlers = (): void => {
  ipcMain.handle('storage:get', (_event, key: string): string | null => {
    const store = readStore();
    return store[key] ?? null;
  });

  ipcMain.handle('storage:set', (_event, key: string, value: string): void => {
    const store = readStore();
    store[key] = value;
    writeStore(store);
  });

  ipcMain.handle('storage:remove', (_event, key: string): void => {
    const store = readStore();
    delete store[key];
    writeStore(store);
  });
};

/** State for the running server instance. */
interface AppState {
  serverProcess: ChildProcess | null;
  mainWindow: BrowserWindow | null;
  serverUrl: string | null;
}

const state: AppState = {
  serverProcess: null,
  mainWindow: null,
  serverUrl: null
};

/** Resolve paths for dev vs packaged. */
const resolvePaths = (): {
  readonly serverEntry: string;
  readonly sqliteDbPath: string;
  readonly metadataPath: string;
  readonly serverRoot: string;
  readonly uiDistPath: string;
  readonly iconPath: string;
} => {
  const sqliteDbPath = resolve(app.getPath('userData'), 'reso_reference.db');

  if (app.isPackaged) {
    return {
      serverEntry: resolve(process.resourcesPath, 'server-bundle', 'server-entry.mjs'),
      sqliteDbPath,
      metadataPath: resolve(process.resourcesPath, 'server-metadata.json'),
      serverRoot: process.resourcesPath,
      uiDistPath: resolve(process.resourcesPath, 'ui'),
      iconPath: resolve(process.resourcesPath, '..', 'Resources', 'icon.icns')
    };
  }

  return {
    serverEntry: resolve(__dirname, 'server-entry.mjs'),
    sqliteDbPath,
    metadataPath: resolve(__dirname, '..', '..', 'server', 'server-metadata.json'),
    serverRoot: resolve(__dirname, '..', '..', 'server', 'src'),
    uiDistPath: resolve(__dirname, '..', '..', 'ui', 'dist'),
    iconPath: resolve(__dirname, '..', 'build', 'icon.png')
  };
};

/** Build the native application menu. */
const buildMenu = (): void => {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    // File
    {
      label: 'File',
      submenu: isMac ? [{ role: 'close' }] : [{ role: 'quit' }]
    },
    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    // View
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Navigate
    {
      label: 'Navigate',
      submenu: [
        {
          label: 'Back',
          accelerator: isMac ? 'Cmd+Left' : 'Alt+Left',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win?.webContents.canGoBack()) win.webContents.goBack();
          }
        },
        {
          label: 'Forward',
          accelerator: isMac ? 'Cmd+Right' : 'Alt+Right',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win?.webContents.canGoForward()) win.webContents.goForward();
          }
        },
        { type: 'separator' },
        {
          label: 'Home',
          accelerator: isMac ? 'Cmd+Shift+H' : 'Ctrl+Shift+H',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win && state.serverUrl) win.loadURL(state.serverUrl);
          }
        }
      ]
    },
    // Window
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    // Help
    {
      label: 'Help',
      submenu: [
        {
          label: 'RESO Website',
          click: () => shell.openExternal('https://www.reso.org')
        },
        {
          label: 'RESO Data Dictionary',
          click: () => shell.openExternal('https://ddwiki.reso.org')
        },
        { type: 'separator' },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal('https://github.com/RESOStandards/reso-tools/issues')
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

/** Start the server in a child process and return the URL. */
const startReferenceServer = (): Promise<string> => {
  const paths = resolvePaths();

  log('Launching server child process...');
  log(`  Entry:  ${paths.serverEntry}`);
  log(`  SQLite: ${paths.sqliteDbPath}`);
  log(`  isPackaged: ${app.isPackaged}`);
  log(`  resourcesPath: ${process.resourcesPath}`);

  return new Promise((resolvePromise, reject) => {
    // Fork Electron as a plain Node.js process via ELECTRON_RUN_AS_NODE.
    // This uses Electron's bundled Node (same ABI as the compiled native
    // addons), so it works in packaged apps without requiring system Node.
    const child = fork(
      paths.serverEntry,
      [paths.sqliteDbPath, paths.metadataPath, paths.serverRoot, paths.uiDistPath],
      {
        stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    );

    state.serverProcess = child;

    child.on('message', (msg: unknown) => {
      const message = msg as { type: string; port?: number; message?: string };
      if (message.type === 'ready' && message.port) {
        const url = `http://localhost:${message.port}`;
        state.serverUrl = url;
        resolvePromise(url);
      } else if (message.type === 'error') {
        reject(new Error(message.message ?? 'Server failed to start'));
      }
    });

    child.on('error', (err) => {
      log(`Fork error: ${err.message}`);
      reject(new Error(`Failed to spawn server process: ${err.message}`));
    });

    child.on('exit', (code) => {
      log(`Server child exited with code ${code}`);
      if (!state.serverUrl) {
        reject(new Error(`Server process exited with code ${code} before becoming ready`));
      }
    });
  });
};

/** Create the main application window. */
const createWindow = (url: string): BrowserWindow => {
  const paths = resolvePaths();
  const icon = nativeImage.createFromPath(paths.iconPath);

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'RESO Desktop Client',
    icon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: resolve(__dirname, 'preload.js')
    }
  });

  // Set dock icon on macOS
  if (process.platform === 'darwin' && !icon.isEmpty() && app.dock) {
    app.dock.setIcon(icon);
  }

  // Open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    if (linkUrl.startsWith('http')) {
      shell.openExternal(linkUrl);
    }
    return { action: 'deny' };
  });

  // Navigation: keyboard shortcuts (Cmd/Ctrl+[/] and Cmd/Ctrl+Arrow)
  // Uses window.history for SPA (React Router) compatibility.
  win.webContents.on('before-input-event', (_event, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || input.type !== 'keyDown') return;

    if (input.key === '[' || input.key === 'ArrowLeft') {
      win.webContents.executeJavaScript('window.history.back()').catch(() => {});
    } else if (input.key === ']' || input.key === 'ArrowRight') {
      win.webContents.executeJavaScript('window.history.forward()').catch(() => {});
    }
  });

  // Navigation: macOS swipe gestures (three-finger if configured)
  win.on('swipe', (_event, direction) => {
    if (direction === 'left') {
      win.webContents.executeJavaScript('window.history.back()').catch(() => {});
    } else if (direction === 'right') {
      win.webContents.executeJavaScript('window.history.forward()').catch(() => {});
    }
  });

  // Navigation: two-finger trackpad swipe (scroll-based)
  // For SPAs using React Router, we call window.history directly since
  // Electron's webContents.canGoBack() doesn't track pushState navigation.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (() => {
        let deltaX = 0;
        let tracking = false;
        let resetTimer;
        document.addEventListener('wheel', (e) => {
          if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
          if (!tracking) {
            deltaX = 0;
            tracking = true;
          }
          deltaX += e.deltaX;
          if (deltaX > 150) {
            tracking = false;
            deltaX = 0;
            window.history.back();
          } else if (deltaX < -150) {
            tracking = false;
            deltaX = 0;
            window.history.forward();
          }
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => { tracking = false; deltaX = 0; }, 200);
        });
      })();
    `).catch(() => {});
  });

  win.loadURL(url);

  state.mainWindow = win;

  win.on('closed', () => {
    state.mainWindow = null;
  });

  return win;
};

/** Graceful shutdown — kill server child process. */
const shutdown = (): void => {
  console.log('Shutting down...');
  if (state.serverProcess) {
    state.serverProcess.kill('SIGTERM');
    state.serverProcess = null;
  }
};

// App lifecycle
app.whenReady().then(async () => {
  registerStorageHandlers();
  buildMenu();

  try {
    const url = await startReferenceServer();
    createWindow(url);
  } catch (err) {
    log(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  shutdown();
  app.quit();
});

app.on('before-quit', shutdown);

// macOS: re-create window when dock icon is clicked
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && state.serverUrl) {
    createWindow(state.serverUrl);
  }
});
