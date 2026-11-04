/**
 * Reading a zip one entry at a time, for everything that reads RESO Common Format input: the `rcf` reader, the
 * fingerprint of what it reads and the pack a cloud run uploads. yauzl reads entries lazily, so a zip of any size is
 * never held whole.
 */

import { createRequire } from 'node:module';
import { extname } from 'node:path';

const requireCjs = createRequire(import.meta.url);

// yauzl ships no type declarations; a minimal surface for what we use.
export interface ZipEntry {
  readonly fileName: string;
}
export interface ZipFile {
  readEntry(): void;
  openReadStream(entry: ZipEntry, cb: (err: Error | null, stream: NodeJS.ReadableStream & AsyncIterable<Uint8Array>) => void): void;
  close(): void;
  on(event: 'entry', cb: (entry: ZipEntry) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
interface Yauzl {
  open(path: string, opts: { lazyEntries: boolean }, cb: (err: Error | null, zip: ZipFile) => void): void;
}
const yauzl = requireCjs('yauzl') as Yauzl;

/** Open a zip for reading one entry at a time. Close it when done, even when stopping early. */
export const openZip = (zipPath: string): Promise<ZipFile> =>
  new Promise((resolve, reject) => yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => (err ? reject(err) : resolve(zip))));

/** An entry's bytes, as a stream. */
export const openZipEntry = (zip: ZipFile, entry: ZipEntry): Promise<NodeJS.ReadableStream & AsyncIterable<Uint8Array>> =>
  new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });

/** The entries `rcf` reads: `.json` files, leaving out directory entries and macOS's `__MACOSX` copies. */
export const isReadZipEntry = (name: string): boolean => !name.includes('__MACOSX') && !name.endsWith('/') && extname(name) === '.json';

/** Bridge yauzl's lazy `entry`/`end`/`error` events to an async generator, one entry at a time. */
export async function* zipEntries(zip: ZipFile): AsyncGenerator<ZipEntry> {
  const queue: ZipEntry[] = [];
  let ended = false;
  let failed: Error | null = null;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    wake?.();
    wake = null;
  };

  zip.on('entry', entry => {
    queue.push(entry);
    signal();
  });
  zip.on('end', () => {
    ended = true;
    signal();
  });
  zip.on('error', err => {
    failed = err;
    signal();
  });

  zip.readEntry();
  while (true) {
    if (failed) throw failed;
    const next = queue.shift();
    if (next) {
      yield next;
      zip.readEntry(); // request the next entry only after this one is consumed
      continue;
    }
    if (ended) return;
    await new Promise<void>(resolve => {
      wake = resolve;
    });
  }
}
