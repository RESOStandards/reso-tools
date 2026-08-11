import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readRcfPayloads, type RcfPayload } from '../../src/cli/rcf-input.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rcf');

const collect = async (input: string): Promise<RcfPayload[]> => {
  const out: RcfPayload[] = [];
  for await (const p of readRcfPayloads(input)) out.push(p);
  return out;
};

describe('readRcfPayloads', () => {
  it('streams a single payload file (value[]) with resource + version from the urn context', async () => {
    const payloads = await collect(resolve(fixtures, 'single-payload.json'));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].resource).toBe('Property');
    expect(payloads[0].version).toBe('2.0');
    expect(payloads[0].records).toHaveLength(2);
  });

  it('streams a directory of single-record files (one payload per file)', async () => {
    const payloads = await collect(resolve(fixtures, 'records'));
    expect(payloads).toHaveLength(2); // a.json + b.json
    expect(payloads.flatMap(p => p.records)).toHaveLength(2);
    expect(payloads.every(p => p.resource === 'Property')).toBe(true);
  });

  it('streams a zip, skipping non-RCF entries', async () => {
    const payloads = await collect(resolve(fixtures, 'bundle.zip'));
    expect(payloads).toHaveLength(2); // p1 + p2; the config file (no context) is skipped
    expect(payloads.flatMap(p => p.records)).toHaveLength(3); // 1 + 2 records
  });

  it('rejects an unsupported input type', async () => {
    await expect(collect(resolve(fixtures, 'notes.txt'))).rejects.toThrow(/unsupported/i);
  });
});
