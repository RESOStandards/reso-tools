/**
 * RCF input ingestion — stream parsed RCF payloads from a zip, directory, or file.
 *
 * One streaming async generator over all three input shapes, so memory stays bounded
 * regardless of input size. (The legacy path materialized the entire input — every
 * zip entry's decompressed string AND the parsed objects — in two maps before any
 * validation ran.) Here yauzl reads zip entries lazily and we yield one payload at a
 * time; directories are walked recursively; a single file is one payload. The
 * consumer decides strict-fail vs. accumulate as it drains the stream.
 *
 * A "payload" is one file's worth of records + the resource/version resolved from its
 * context. The `@reso.context` urn form is the RESO Common Format context and is
 * REQUIRED on an RCF payload (#298: its absence is a schema error); the `@odata.context`
 * `$metadata#` form is read for the resource so such a file is still ingested and
 * reported, not dropped. Entries that carry NO context of either form, or no records,
 * are skipped as non-RCF. An entry that
 * carries an `@reso.context` the resolver cannot read is NOT skipped: it is yielded
 * with `invalidContext` so schema validation reports the malformed context and the
 * run does not certify on the clean files alone (#298).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

const requireCjs = createRequire(import.meta.url);

// yauzl ships no type declarations; a minimal surface for what we use.
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

export interface RcfPayload {
  /** Source identifier (file path or zip entry name), for reporting. */
  readonly source: string;
  /** Records to validate + infer from — a payload's `value[]`, or a single record file. */
  readonly records: ReadonlyArray<unknown>;
  /** Resource name resolved from the payload context. */
  readonly resource: string;
  /** DD version from the context; absent for the `@odata.context` form (caller supplies a default). */
  readonly version?: string;
  /** The raw `@reso.context` value, when the payload carried one — forwarded to schema validation so the
   *  context itself is validated (#298: required on an RCF payload; shape / version / resource checked). */
  readonly context?: string;
  /** Set when the payload carries an `@reso.context` the resolver could not read (wrong shape, or not a
   *  string): `resource` is then the placeholder `_INVALID_`, the records are counted but never used for
   *  inference, and validation reports the context as malformed. */
  readonly invalidContext?: true;
}

/** Placeholder resource for a payload whose context could not be resolved. */
export const INVALID_CONTEXT_RESOURCE = '_INVALID_';

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Resolve resource (+ version, when present) from an RCF/OData context string. */
const parseContext = (ctx: unknown): { readonly version?: string; readonly resource: string } | null => {
  const s = typeof ctx === 'string' ? ctx : '';
  const urn = /urn:reso:metadata:([\d.]+):resource:(\w+)/i.exec(s);
  if (urn) return { version: urn[1], resource: capitalize(urn[2]) };
  const odata = /\$metadata#(\w+)/.exec(s);
  if (odata) return { resource: capitalize(odata[1]) };
  return null;
};

/** An RcfPayload from a parsed JSON file, or null when it is not an RCF payload. */
const toPayload = (parsed: unknown, source: string): RcfPayload | null => {
  if (!isPlainObject(parsed)) return null;
  const records = Array.isArray(parsed.value) ? parsed.value : [parsed];
  if (records.length === 0) return null;
  const rawContext = parsed['@reso.context'];
  const ctx = parseContext(rawContext ?? parsed['@odata.context']);
  if (!ctx) {
    // No context of either form → not an RCF payload. A present @reso.context the resolver cannot read is a
    // payload whose context is wrong, which is a finding, not a reason to drop the file.
    if (rawContext === undefined) return null;
    const context = typeof rawContext === 'string' ? rawContext : JSON.stringify(rawContext);
    return { source, records, resource: INVALID_CONTEXT_RESOURCE, context, invalidContext: true };
  }
  const context = typeof rawContext === 'string' ? rawContext : undefined;
  return { source, records, resource: ctx.resource, ...(ctx.version ? { version: ctx.version } : {}), ...(context ? { context } : {}) };
};

const readEntryContent = (zip: ZipFile, entry: ZipEntry): Promise<string> =>
  new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  });

/** Bridge yauzl's lazy `entry`/`end`/`error` events to an async generator, one entry at a time. */
async function* zipEntries(zip: ZipFile): AsyncGenerator<ZipEntry> {
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

async function* readZip(zipPath: string): AsyncGenerator<RcfPayload> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true }, (err, z) => (err ? reject(err) : resolve(z)))
  );
  try {
    for await (const entry of zipEntries(zip)) {
      if (entry.fileName.includes('__MACOSX') || entry.fileName.endsWith('/')) continue; // macOS cruft / dir entries
      if (extname(entry.fileName) !== '.json') continue;
      const payload = toPayload(JSON.parse(await readEntryContent(zip, entry)), entry.fileName);
      if (payload) yield payload;
    }
  } finally {
    // Release the fd even if the consumer abandons the stream early (peekVersion, strict fail-fast,
    // a malformed entry) — yauzl's autoClose only fires on the natural `end`.
    zip.close();
  }
}

async function* readJsonFile(path: string): AsyncGenerator<RcfPayload> {
  const payload = toPayload(JSON.parse(await readFile(path, 'utf-8')), path);
  if (payload) yield payload;
}

async function* readDirectory(dir: string): AsyncGenerator<RcfPayload> {
  for (const name of (await readdir(dir)).sort()) {
    if (name.startsWith('.')) continue; // .DS_Store et al.
    const full = join(dir, name);
    const entryStat = await stat(full);
    if (entryStat.isDirectory()) yield* readDirectory(full);
    else if (extname(name) === '.json') yield* readJsonFile(full);
    else if (extname(name) === '.zip') yield* readZip(full);
  }
}

/**
 * Stream RCF payloads from a zip, a directory (recursed), or a single `.json`/`.zip` file.
 * Yields one {@link RcfPayload} at a time; non-RCF entries are skipped.
 */
export async function* readRcfPayloads(inputPath: string): AsyncGenerator<RcfPayload> {
  const inputStat = await stat(inputPath);
  if (inputStat.isDirectory()) yield* readDirectory(inputPath);
  else if (extname(inputPath) === '.zip') yield* readZip(inputPath);
  else if (extname(inputPath) === '.json') yield* readJsonFile(inputPath);
  else throw new Error(`Unsupported RCF input (expected a .json file, .zip, or a directory): ${inputPath}`);
}
