import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRcfPayloads } from '../../src/cli/rcf-input.js';
import { fingerprintRcfInput } from '../../src/rcf/fingerprint.js';

/**
 * The fingerprint a cloud run checks the uploaded data against: the same files give the same fingerprint as a
 * `.json`, a folder or a zip, and any change to what `rcf` reads changes it.
 */

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rcf');
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

interface ZipEntry {
  readonly fileName: string;
}
interface ZipFile {
  readEntry(): void;
  openReadStream(entry: ZipEntry, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void): void;
  on(event: 'entry', cb: (entry: ZipEntry) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
const yauzl = createRequire(import.meta.url)('yauzl') as {
  open(path: string, opts: { lazyEntries: boolean; autoClose: boolean }, cb: (err: Error | null, zip: ZipFile) => void): void;
};

/** Every entry of a zip, by name, as bytes. */
const zipEntries = (path: string): Promise<ReadonlyArray<readonly [string, Buffer]>> =>
  new Promise((resolvePromise, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      const entries: Array<readonly [string, Buffer]> = [];
      zip.on('error', reject);
      zip.on('end', () => resolvePromise(entries));
      zip.on('entry', entry =>
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            entries.push([entry.fileName, Buffer.concat(chunks)]);
            zip.readEntry();
          });
          stream.on('error', reject);
        })
      );
      zip.readEntry();
    })
  );

const folderOf = async (files: ReadonlyArray<readonly [string, Buffer | string]>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'rcf-fingerprint-'));
  for (const [name, body] of files) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
};

describe('the fingerprint of the files rcf reads', () => {
  it('is the SHA-256 of a sorted manifest of each file and its own SHA-256', async () => {
    const body = await readFile(resolve(fixtures, 'single-payload.json'));
    const fingerprint = await fingerprintRcfInput(resolve(fixtures, 'single-payload.json'));

    expect(fingerprint.files).toEqual([{ path: 'single-payload.json', sha256: sha256(body), bytes: body.length }]);
    expect(fingerprint.sha256).toBe(sha256(`${sha256(body)}  single-payload.json\n`));
    expect(fingerprint.bytes).toBe(body.length);
  });

  it('is the same for a zip and for the same files in a folder', async () => {
    const entries = await zipEntries(resolve(fixtures, 'bundle.zip'));
    const folder = await folderOf(entries);

    const fromZip = await fingerprintRcfInput(resolve(fixtures, 'bundle.zip'));
    const fromFolder = await fingerprintRcfInput(folder);
    expect(fromZip.files.map(file => file.path)).toEqual(['notrcf.json', 'p1.json', 'p2.json']);
    expect(fromFolder).toEqual(fromZip);
  });

  it('takes from a zip the entries rcf reads, and no others', async () => {
    // mixed.zip also holds readme.txt, a __MACOSX entry and the sub/ directory entry.
    const zip = resolve(fixtures, 'mixed.zip');
    const fingerprint = await fingerprintRcfInput(zip);
    expect(fingerprint.files.map(file => file.path)).toEqual(['a.json', 'sub/b.json']);
    const read: string[] = [];
    for await (const payload of readRcfPayloads(zip)) read.push(payload.source);
    expect(read.sort()).toEqual(['a.json', 'sub/b.json']);
  });

  it('reads a zip inside a folder as a folder named for the zip', async () => {
    const zipBody = await readFile(resolve(fixtures, 'bundle.zip'));
    const folder = await folderOf([['deliveries/bundle.zip', zipBody]]);
    const fingerprint = await fingerprintRcfInput(folder);
    expect(fingerprint.files.map(file => file.path)).toEqual([
      'deliveries/bundle.zip/notrcf.json',
      'deliveries/bundle.zip/p1.json',
      'deliveries/bundle.zip/p2.json'
    ]);
  });

  it('covers only what rcf reads: no dotfiles and nothing but .json and .zip', async () => {
    const folder = await folderOf([
      ['a.json', '{"value":[]}'],
      ['notes.txt', 'not read'],
      ['.DS_Store', 'not read'],
      ['.hidden/b.json', '{"value":[]}'],
      ['sub/c.json', '{"value":[]}']
    ]);
    expect((await fingerprintRcfInput(folder)).files.map(file => file.path)).toEqual(['a.json', 'sub/c.json']);
  });

  it('changes with one changed byte, a renamed file, or a file added', async () => {
    const original = await fingerprintRcfInput(await folderOf([['a.json', '{"value":[1]}']]));
    const changed = await fingerprintRcfInput(await folderOf([['a.json', '{"value":[2]}']]));
    const renamed = await fingerprintRcfInput(await folderOf([['b.json', '{"value":[1]}']]));
    const added = await fingerprintRcfInput(
      await folderOf([
        ['a.json', '{"value":[1]}'],
        ['z.json', '{"value":[1]}']
      ])
    );
    expect(new Set([original.sha256, changed.sha256, renamed.sha256, added.sha256]).size).toBe(4);
  });

  it('does not depend on the order files are found in', async () => {
    const first = await fingerprintRcfInput(
      await folderOf([
        ['b.json', '{"value":[2]}'],
        ['a.json', '{"value":[1]}']
      ])
    );
    const second = await fingerprintRcfInput(
      await folderOf([
        ['a.json', '{"value":[1]}'],
        ['b.json', '{"value":[2]}']
      ])
    );
    expect(second.sha256).toBe(first.sha256);
  });

  it('refuses an input rcf cannot read', async () => {
    await expect(fingerprintRcfInput(resolve(fixtures, 'notes.txt'))).rejects.toThrow('Unsupported RCF input');
  });
});
