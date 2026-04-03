#!/usr/bin/env node

/**
 * CLI entry point for the standalone proxy server.
 *
 * Usage:
 *   npx @reso-standards/web-api-proxy [--port 8080] [--ui ../reso-web-client/dist]
 */

import { createProxyServer } from './index.js';

const parseArgs = (args: ReadonlyArray<string>): { port: number; uiDistPath?: string } => {
  const result: { port: number; uiDistPath?: string } = { port: 8888 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      result.port = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--ui' && args[i + 1]) {
      result.uiDistPath = args[i + 1];
      i++;
    }
  }

  return result;
};

const main = async (): Promise<void> => {
  const { port, uiDistPath } = parseArgs(process.argv.slice(2));

  const instance = await createProxyServer({ port, uiDistPath });
  console.log(`RESO Web API Proxy running at ${instance.url}`);
  if (uiDistPath) {
    console.log(`  Serving UI from: ${uiDistPath}`);
  }
  console.log(`  Proxy: ${instance.url}/api/proxy?url=<encoded>`);
  console.log(`  Health: ${instance.url}/health`);
};

main().catch((err) => {
  console.error('Failed to start proxy server:', err);
  process.exit(1);
});
