/**
 * Server entry point — runs in a plain Node.js child process (ESM).
 *
 * Tries to load the full reference server (OData + proxy + UI). If the
 * reference server package is not available, falls back to the lightweight
 * web-api-proxy (CORS proxy + health + UI only).
 *
 * Receives configuration via argv:
 *   [0] sqliteDbPath
 *   [1] metadataPath
 *   [2] serverRoot
 *   [3] uiDistPath
 *
 * Sends IPC messages back to the Electron main process:
 *   { type: 'ready', port: number }
 *   { type: 'error', message: string }
 */

const [sqliteDbPath, metadataPath, serverRoot, uiDistPath] = process.argv.slice(2);

/** Start the full reference server (OData routes + proxy + UI). */
const startReferenceServer = async () => {
  const { createApp, loadConfig } = await import('@reso-standards/reso-reference-server');

  const config = loadConfig({
    port: 0,
    dbBackend: 'sqlite',
    sqliteDbPath,
    metadataPath,
    serverRoot,
    baseUrl: 'http://localhost'
  });

  console.log('Starting RESO Reference Server (child process)...');
  console.log(`  SQLite DB: ${sqliteDbPath}`);
  console.log(`  Metadata:  ${metadataPath}`);
  console.log(`  UI:        ${uiDistPath}`);

  const instance = await createApp({ config, uiDistPath });

  const server = instance.app.listen(0, () => {
    const addr = server.address();
    console.log(`RESO Reference Server running at http://localhost:${addr.port}`);
    process.send?.({ type: 'ready', port: addr.port });
  });

  return () => {
    server.close();
    instance.cleanup?.();
  };
};

/** Start the lightweight proxy server (proxy + health + UI only, no OData). */
const startProxyOnly = async () => {
  const { createProxyServer } = await import('@reso-standards/reso-web-api-proxy');

  console.log('Starting RESO Web API Proxy (child process)...');
  console.log(`  UI: ${uiDistPath}`);

  const instance = await createProxyServer({ port: 0, uiDistPath });

  console.log(`RESO Web API Proxy running at ${instance.url}`);
  process.send?.({ type: 'ready', port: instance.port });

  return () => instance.close();
};

const start = async () => {
  let cleanup;
  try {
    cleanup = await startReferenceServer();
  } catch (err) {
    console.log(`Reference server not available (${err instanceof Error ? err.message : String(err)}), falling back to proxy-only mode`);
    cleanup = await startProxyOnly();
  }

  // Graceful shutdown on parent disconnect or signal
  const shutdown = () => {
    console.log('Server child process shutting down...');
    cleanup();
    process.exit(0);
  };

  process.on('disconnect', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Server failed to start:', message);
  process.send?.({ type: 'error', message });
  process.exit(1);
});
