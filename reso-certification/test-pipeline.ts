/**
 * Quick test script for the SDK pipelines against a running reference server.
 * Usage: npx tsx test-pipeline.ts
 */

import { runComplianceTests } from './src/sdk/index.js';
import type { StepProgress } from './src/sdk/types.js';

const onProgress = (progress: StepProgress): void => {
  const icon = progress.status === 'passed' ? '✓'
    : progress.status === 'failed' ? '✗'
    : progress.status === 'skipped' ? '○'
    : progress.status === 'running' ? '⟳'
    : '·';
  const duration = progress.duration ? ` (${progress.duration}ms)` : '';
  const message = progress.message ? ` — ${progress.message}` : '';
  console.log(`  ${icon} ${progress.step}${duration}${message}`);
};

const run = async () => {
  console.log('\n=== Add/Edit Pipeline ===\n');

  const addEditResult = await runComplianceTests({
    endorsement: 'add-edit',
    server: {
      url: 'http://localhost:8080',
      auth: { mode: 'token', authToken: 'admin-token' },
    },
    resource: 'Property',
    specVersion: '2.0.0',
    options: { outputDir: '/tmp/reso-cert-test/add-edit' },
  }, onProgress);

  console.log(`\n  Result: ${addEditResult.status} (${addEditResult.duration}ms)`);
  console.log(`  Steps: ${addEditResult.steps.map(s => `${s.name}: ${s.status}`).join(', ')}`);

  console.log('\n=== EntityEvent Pipeline ===\n');

  const entityEventResult = await runComplianceTests({
    endorsement: 'entity-event',
    server: {
      url: 'http://localhost:8080',
      auth: { mode: 'token', authToken: 'admin-token' },
    },
    mode: 'full',
    writableResource: 'Property',
    maxEvents: 100,
    batchSize: 50,
    pollInterval: 2000,
    pollTimeout: 10000,
    options: { outputDir: '/tmp/reso-cert-test/entity-event' },
  }, onProgress);

  console.log(`\n  Result: ${entityEventResult.status} (${entityEventResult.duration}ms)`);
  console.log(`  Steps: ${entityEventResult.steps.map(s => `${s.name}: ${s.status}`).join(', ')}`);

  // Show report files
  console.log('\n=== Reports ===\n');
  const { execSync } = await import('node:child_process');
  console.log(execSync('find /tmp/reso-cert-test -name "*.json" -type f').toString());
};

run().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
