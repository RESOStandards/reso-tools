/**
 * The files `rcf` reads, one at a time, each by the path its fingerprint's manifest names it:
 *
 *   - a `.json` file, by its own name
 *   - a directory, recursively, skipping names that start with a dot: its `.json` files by their path below the
 *     directory, and the `.json` entries of each `.zip` in it by the zip's path, a slash and the entry's name
 *   - a `.zip`, its `.json` entries by name, skipping `__MACOSX` and directory entries
 *
 * A file whose path holds a control character is refused. The fingerprint's manifest gives each file one line, so a
 * newline in a name could make one file read as two, and two different deliveries share a fingerprint.
 *
 * The fingerprint hashes these and a cloud run's upload packs them, so the two cannot disagree about what was read.
 * Read each file's bytes before asking for the next: a zip's next entry, and a directory's next file, are opened only
 * then, so a delivery of any size never holds more than one file open.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { isReadZipEntry, openZip, openZipEntry, zipEntries } from './zip.js';

/** One file `rcf` reads: its path in the manifest, and its bytes when asked for. */
export interface RcfInputSource {
  readonly path: string;
  readonly open: () => Promise<NodeJS.ReadableStream>;
}

const isControl = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/** The path, when no character in it could break the line the manifest gives it. */
const manifestPath = (path: string): string => {
  if ([...path].some(isControl)) {
    throw new Error(`An RCF input file's name holds a control character, which its fingerprint cannot name: ${JSON.stringify(path)}`);
  }
  return path;
};

async function* zipSources(zipPath: string, prefix: string): AsyncGenerator<RcfInputSource> {
  const zip = await openZip(zipPath);
  try {
    for await (const entry of zipEntries(zip)) {
      if (isReadZipEntry(entry.fileName)) yield { path: manifestPath(`${prefix}${entry.fileName}`), open: () => openZipEntry(zip, entry) };
    }
  } finally {
    zip.close();
  }
}

async function* directorySources(dir: string, prefix: string): AsyncGenerator<RcfInputSource> {
  for (const name of (await readdir(dir)).filter(entry => !entry.startsWith('.')).sort()) {
    const full = join(dir, name);
    const path = `${prefix}${name}`;
    if ((await stat(full)).isDirectory()) yield* directorySources(full, `${path}/`);
    else if (extname(name) === '.json') yield { path: manifestPath(path), open: async () => createReadStream(full) };
    else if (extname(name) === '.zip') yield* zipSources(full, `${path}/`);
  }
}

/** The files `rcf` reads at `inputPath`: a `.json` file, a `.zip` or a directory. */
export async function* rcfInputFiles(inputPath: string): AsyncGenerator<RcfInputSource> {
  const inputStat = await stat(inputPath);
  if (inputStat.isDirectory()) yield* directorySources(inputPath, '');
  else if (extname(inputPath) === '.zip') yield* zipSources(inputPath, '');
  else if (extname(inputPath) === '.json') yield { path: manifestPath(basename(inputPath)), open: async () => createReadStream(inputPath) };
  else throw new Error(`Unsupported RCF input (expected a .json file, .zip or a directory): ${inputPath}`);
}
