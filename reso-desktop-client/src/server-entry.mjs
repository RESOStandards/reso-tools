/**
 * Server entry point — runs in a plain Node.js child process (ESM).
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

const start = async () => {
  const { createApp, loadConfig } = await import('@reso-standards/reference-server');

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

  // Graceful shutdown on parent disconnect or signal
  const shutdown = () => {
    console.log('Server child process shutting down...');
    server.close();
    instance.cleanup?.();
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
