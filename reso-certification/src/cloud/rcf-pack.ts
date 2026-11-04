/**
 * Pack what `rcf` read into the one zip a cloud run uploads.
 *
 * Each file the run read is written at its manifest path, from its own bytes: a zip inside a folder becomes a folder
 * named for the zip, never a zip inside the zip. The packed zip is then fingerprinted and must carry the input's
 * fingerprint, so a packing fault stops here and not in the cloud. Always one zip, even from a single `.json`, at a
 * low compression level: it is fast, and RESO Common Format compresses well even so (Josh, 2026-11-03).
 */

import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { fingerprintRcfInput } from '../rcf/fingerprint.js';
import { rcfInputFiles } from '../rcf/input-files.js';

const requireCjs = createRequire(import.meta.url);

// yazl ships no type declarations; a minimal surface for what we use.
interface ZipWriter {
  readonly outputStream: NodeJS.ReadableStream;
  addReadStreamLazy(
    path: string,
    options: { readonly compressionLevel: number },
    getReadStream: (cb: (err: Error | null, stream?: NodeJS.ReadableStream) => void) => void
  ): void;
  end(): void;
}
const yazl = requireCjs('yazl') as { readonly ZipFile: new () => ZipWriter };

/** The most a cloud run takes: one object up to S3's single-upload limit, 5 GiB, compressed. */
export const RCF_UPLOAD_MAX_BYTES = 5 * 1024 ** 3;

/** Low, because it is fast. */
const PACK_COMPRESSION_LEVEL = 1;

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export interface PackedRcfInput {
  /** The zip, ready to upload. */
  readonly path: string;
  readonly bytes: number;
  /** The fingerprint of what `rcf` read, which the packed zip carries too. */
  readonly fingerprint: string;
  readonly files: number;
}

export type PackRcfResult = { readonly packed: PackedRcfInput } | { readonly refused: string };

/**
 * Pack the RCF input at `inputPath` into the zip at `zipPath`, which must end in `.zip`. Give the fingerprint the local
 * run recorded to save reading the input an extra time. Over `maxBytes` the zip is removed and the result says why.
 */
export const packRcfInput = async (
  inputPath: string,
  zipPath: string,
  options: { readonly fingerprint?: string; readonly maxBytes?: number } = {}
): Promise<PackRcfResult> => {
  const expected = options.fingerprint ?? (await fingerprintRcfInput(inputPath)).sha256;
  const zip = new yazl.ZipFile();
  const written = pipeline(zip.outputStream, createWriteStream(zipPath));
  let files = 0;
  for await (const source of rcfInputFiles(inputPath)) {
    // One file at a time: the next is opened only once this one has been read into the zip.
    await new Promise<void>((resolve, reject) => {
      zip.addReadStreamLazy(source.path, { compressionLevel: PACK_COMPRESSION_LEVEL }, cb => {
        source.open().then(
          stream => {
            stream.once('end', () => resolve());
            stream.once('error', reject);
            cb(null, stream);
          },
          (error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            reject(failure);
            cb(failure);
          }
        );
      });
    });
    files += 1;
  }
  zip.end();
  await written;

  const packed = (await fingerprintRcfInput(zipPath)).sha256;
  if (packed !== expected) {
    await rm(zipPath, { force: true });
    throw new Error(`The packed upload does not hold what rcf read (fingerprint ${packed}, expected ${expected}). Nothing was uploaded.`);
  }
  const { size } = await stat(zipPath);
  const maxBytes = options.maxBytes ?? RCF_UPLOAD_MAX_BYTES;
  if (size > maxBytes) {
    await rm(zipPath, { force: true });
    return { refused: `The data packs to ${gib(size)}, over the ${gib(maxBytes)} a cloud run takes. Nothing was uploaded.` };
  }
  return { packed: { path: zipPath, bytes: size, fingerprint: expected, files } };
};
