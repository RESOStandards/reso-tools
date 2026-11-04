import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRcfPayloads } from '../../src/cli/rcf-input.js';
import { packRcfInput } from '../../src/cloud/rcf-pack.js';
import { fingerprintRcfInput } from '../../src/rcf/fingerprint.js';

/**
 * A cloud run uploads one zip of exactly what `rcf` read, and the cloud checks the upload against the fingerprint the
 * local run recorded. So the pack must hold the same files at the same manifest paths as the input, whatever shape
 * the input came in.
 */

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rcf');

const scratch = (): Promise<string> => mkdtemp(join(tmpdir(), 'rcf-pack-'));

const packed = async (input: string, options: Parameters<typeof packRcfInput>[2] = {}) => {
  const result = await packRcfInput(input, join(await scratch(), 'upload.zip'), options);
  if ('refused' in result) throw new Error(result.refused);
  return result.packed;
};

const payloadsIn = async (input: string): Promise<ReadonlyArray<readonly [string, number]>> => {
  const out: Array<readonly [string, number]> = [];
  for await (const payload of readRcfPayloads(input)) {
    let records = 0;
    for await (const _record of payload.records) records += 1;
    out.push([payload.resource, records]);
  }
  return out;
};

describe('packing what rcf read for a cloud run', () => {
  it.each([
    ['a single .json', resolve(fixtures, 'single-payload.json')],
    ['a folder', resolve(fixtures, 'records')],
    ['a zip', resolve(fixtures, 'bundle.zip')],
    ['a zip with entries rcf skips', resolve(fixtures, 'mixed.zip')]
  ])('packs %s into a zip with the same fingerprint', async (_label, input) => {
    const expected = await fingerprintRcfInput(input);
    const result = await packed(input);
    expect(result.fingerprint).toBe(expected.sha256);
    expect(result.files).toBe(expected.files.length);
    const repacked = await fingerprintRcfInput(result.path);
    expect(repacked.files.map(file => file.path)).toEqual(expected.files.map(file => file.path));
    expect(repacked.sha256).toBe(expected.sha256);
  });

  it('writes a zip inside a folder as a folder named for the zip, never a zip inside the zip', async () => {
    const folder = await scratch();
    await mkdir(join(folder, 'deliveries'), { recursive: true });
    await copyFile(resolve(fixtures, 'bundle.zip'), join(folder, 'deliveries', 'bundle.zip'));
    await copyFile(resolve(fixtures, 'single-payload.json'), join(folder, 'single-payload.json'));
    const result = await packed(folder);
    const inside = (await fingerprintRcfInput(result.path)).files.map(file => file.path);
    expect(inside).toEqual([
      'deliveries/bundle.zip/notrcf.json',
      'deliveries/bundle.zip/p1.json',
      'deliveries/bundle.zip/p2.json',
      'single-payload.json'
    ]);
    expect(result.fingerprint).toBe((await fingerprintRcfInput(folder)).sha256);
  });

  it('reads back as the same payloads', async () => {
    const input = resolve(fixtures, 'bundle.zip');
    expect(await payloadsIn((await packed(input)).path)).toEqual(await payloadsIn(input));
  });

  it('takes the fingerprint the local run recorded, and refuses a pack that does not match it', async () => {
    const input = resolve(fixtures, 'single-payload.json');
    const { sha256 } = await fingerprintRcfInput(input);
    expect((await packed(input, { fingerprint: sha256 })).fingerprint).toBe(sha256);
    // The input changed after the local run: the pack holds other bytes than the run read.
    const zipPath = join(await scratch(), 'upload.zip');
    await expect(packRcfInput(input, zipPath, { fingerprint: '0'.repeat(64) })).rejects.toThrow(/does not hold what rcf read/);
    expect(existsSync(zipPath)).toBe(false);
  });

  it('refuses a pack over the limit, saying its size and the limit, and leaves no zip behind', async () => {
    const folder = await scratch();
    const record = { ListingKey: '1', PublicRemarks: 'x'.repeat(2000) };
    await writeFile(
      join(folder, 'p.json'),
      JSON.stringify({ '@reso.context': 'urn:reso:metadata:2.1:resource:property', value: [record] })
    );
    const zipPath = join(await scratch(), 'upload.zip');
    const result = await packRcfInput(folder, zipPath, { maxBytes: 10 });
    expect(result).toEqual({
      refused: expect.stringMatching(/^The data packs to 0\.0 GB, over the 0\.0 GB a cloud run takes\. Nothing was uploaded\.$/)
    });
    expect(existsSync(zipPath)).toBe(false);
  });

  it('compresses, even a single .json', async () => {
    const folder = await scratch();
    const records = Array.from({ length: 500 }, (_, i) => ({ ListingKey: String(i), City: 'Fairfax', StandardStatus: 'Active' }));
    const input = join(folder, 'p.json');
    await writeFile(input, JSON.stringify({ '@reso.context': 'urn:reso:metadata:2.1:resource:property', value: records }));
    const result = await packed(input);
    expect(result.bytes).toBeLessThan((await readFile(input)).length / 4);
  });
});
