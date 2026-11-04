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
 * changed byte, a renamed file or a file added or removed changes it. A path holding a control
 * character is refused (`input-files.ts`), so each line names one file and no two deliveries can
 * share a manifest.
 */

import { createHash } from 'node:crypto';
import { rcfInputFiles } from './input-files.js';

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

/** The fingerprint of the RCF files at `inputPath`: a `.json` file, a `.zip` or a directory. */
export const fingerprintRcfInput = async (inputPath: string): Promise<RcfInputFingerprint> => {
  const files: RcfInputFile[] = [];
  // One file at a time, as `rcf` reads them, so a large delivery cannot exhaust the open-file limit.
  for await (const source of rcfInputFiles(inputPath)) files.push({ path: source.path, ...(await hashStream(await source.open())) });
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = sorted.map(file => `${file.sha256}  ${file.path}\n`).join('');
  return {
    sha256: createHash('sha256').update(manifest).digest('hex'),
    files: sorted,
    bytes: sorted.reduce((total, file) => total + file.bytes, 0)
  };
};
