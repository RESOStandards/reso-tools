/**
 * A fingerprint of the RESO Common Format files a run reads.
 *
 * A cloud run must score the same data the local run passed. The fingerprint is how it knows: the
 * local run records it, and the cloud run recomputes it from the uploaded copy and refuses on a
 * mismatch. It is computed over exactly the files `rcf` reads (see `rcf-input.ts`):
 *
 *   - a `.json` file, by its own name
 *   - a directory, recursively, skipping names that start with a dot: its `.json` files by their path
 *     below the directory, and the `.json` entries of each `.zip` in it by the zip's path, a slash and
 *     the entry's name
 *   - a `.zip`, its `.json` entries by name, skipping `__MACOSX` and directory entries
 *
 * Each file is hashed as the bytes it holds, and the fingerprint is the SHA-256 of a manifest with
 * one `<sha256>  <path>` line per file, sorted by path. So the same files give the same fingerprint
 * whether they arrive as a `.json`, a folder or a zip, and however a zip happened to be packed. A
 * changed byte, a renamed file or a file added or removed changes it.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, extname, join } from 'node:path';

const requireCjs = createRequire(import.meta.url);

// yauzl ships no type declarations; the surface used here, as in rcf-input.ts.
interface ZipEntry {
  readonly fileName: string;
}
interface ZipFile {
  readEntry(): void;
  openReadStream(entry: ZipEntry, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void): void;
  close(): void;
  on(event: 'entry', cb: (entry: ZipEntry) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
interface Yauzl {
  open(path: string, opts: { lazyEntries: boolean }, cb: (err: Error | null, zip: ZipFile) => void): void;
}
const yauzl = requireCjs('yauzl') as Yauzl;

/** One file the run reads. */
export interface RcfInputFile {
  /** Its path in the input, as the manifest names it. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RcfInputFingerprint {
  /** SHA-256 of the manifest: one `<sha256>  <path>` line per file, sorted by path. */
  readonly sha256: string;
  readonly files: ReadonlyArray<RcfInputFile>;
  readonly bytes: number;
}

const hashStream = (stream: NodeJS.ReadableStream): Promise<{ readonly sha256: string; readonly bytes: number }> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
    stream.on('error', reject);
  });

const hashFile = async (fullPath: string, path: string): Promise<RcfInputFile> => ({
  path,
  ...(await hashStream(createReadStream(fullPath)))
});

const isReadZipEntry = (name: string): boolean => !name.includes('__MACOSX') && !name.endsWith('/') && extname(name) === '.json';

const hashZipEntries = async (zipPath: string, prefix: string): Promise<ReadonlyArray<RcfInputFile>> => {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true }, (err, opened) => (err ? reject(err) : resolve(opened)))
  );
  try {
    return await new Promise<ReadonlyArray<RcfInputFile>>((resolve, reject) => {
      const files: RcfInputFile[] = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', entry => {
        if (!isReadZipEntry(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          hashStream(stream)
            .then(hashed => {
              files.push({ path: `${prefix}${entry.fileName}`, ...hashed });
              zip.readEntry();
            })
            .catch(reject);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
};

const hashDirectoryEntry = async (dir: string, prefix: string, name: string): Promise<ReadonlyArray<RcfInputFile>> => {
  const full = join(dir, name);
  const path = `${prefix}${name}`;
  if ((await stat(full)).isDirectory()) return hashDirectory(full, `${path}/`);
  if (extname(name) === '.json') return [await hashFile(full, path)];
  if (extname(name) === '.zip') return hashZipEntries(full, `${path}/`);
  return [];
};

/** One file at a time, as `rcf` reads them, so a large delivery cannot exhaust the open-file limit. */
const hashDirectory = async (dir: string, prefix: string): Promise<ReadonlyArray<RcfInputFile>> => {
  const names = (await readdir(dir)).filter(name => !name.startsWith('.')).sort();
  const files: RcfInputFile[] = [];
  for (const name of names) files.push(...(await hashDirectoryEntry(dir, prefix, name)));
  return files;
};

/** The fingerprint of the RCF files at `inputPath`: a `.json` file, a `.zip` or a directory. */
export const fingerprintRcfInput = async (inputPath: string): Promise<RcfInputFingerprint> => {
  const inputStat = await stat(inputPath);
  const files = inputStat.isDirectory()
    ? await hashDirectory(inputPath, '')
    : extname(inputPath) === '.zip'
      ? await hashZipEntries(inputPath, '')
      : extname(inputPath) === '.json'
        ? [await hashFile(inputPath, basename(inputPath))]
        : undefined;
  if (files === undefined) throw new Error(`Unsupported RCF input (expected a .json file, .zip or a directory): ${inputPath}`);
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = sorted.map(file => `${file.sha256}  ${file.path}\n`).join('');
  return {
    sha256: createHash('sha256').update(manifest).digest('hex'),
    files: sorted,
    bytes: sorted.reduce((total, file) => total + file.bytes, 0)
  };
};
