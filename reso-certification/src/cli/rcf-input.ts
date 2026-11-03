/**
 * RCF input ingestion — stream parsed RCF payloads from a zip, directory, or file.
 *
 * One streaming async generator over all three input shapes, so memory stays bounded
 * regardless of input size. Zip entries are read lazily with yauzl, directories are walked
 * recursively and a single file is one payload. Within a file nothing is held whole either:
 * each file is parsed as a stream and a payload's records arrive one at a time, so a file
 * past V8's largest string (about 512 MB decoded) is read like any other (#263). The
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

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { JSONParser } from '@streamparser/json';

const requireCjs = createRequire(import.meta.url);

// yauzl ships no type declarations; a minimal surface for what we use.
interface ZipEntry {
  readonly fileName: string;
}
interface ZipFile {
  readEntry(): void;
  openReadStream(entry: ZipEntry, cb: (err: Error | null, stream: AsyncIterable<Uint8Array>) => void): void;
  close(): void;
  on(event: 'entry', cb: (entry: ZipEntry) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
interface Yauzl {
  open(path: string, opts: { lazyEntries: boolean }, cb: (err: Error | null, zip: ZipFile) => void): void;
}
const yauzl = requireCjs('yauzl') as Yauzl;

/** A payload's records: an array, or records still being read from the file. */
export type RcfRecords = AsyncIterable<unknown> | Iterable<unknown>;

export interface RcfPayload {
  /** Source identifier (file path or zip entry name), for reporting. */
  readonly source: string;
  /** Records to validate and infer from: a payload's `value[]`, or a single record file. Read them once, in order,
   *  before asking for the next payload: they are read from the file as they are asked for. */
  readonly records: RcfRecords;
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

type RcfHeader = Omit<RcfPayload, 'records'>;

/** What a payload's context says it is, or null when it carries no context of either form (not an RCF payload). */
const headerOf = (root: Readonly<Record<string, unknown>>, source: string): RcfHeader | null => {
  const rawContext = root['@reso.context'];
  const ctx = parseContext(rawContext ?? root['@odata.context']);
  if (!ctx) {
    // No context of either form → not an RCF payload. A present @reso.context the resolver cannot read is a
    // payload whose context is wrong, which is a finding, not a reason to drop the file.
    if (rawContext === undefined) return null;
    const context = typeof rawContext === 'string' ? rawContext : JSON.stringify(rawContext);
    return { source, resource: INVALID_CONTEXT_RESOURCE, context, invalidContext: true };
  }
  const context = typeof rawContext === 'string' ? rawContext : undefined;
  return { source, resource: ctx.resource, ...(ctx.version ? { version: ctx.version } : {}), ...(context ? { context } : {}) };
};

/** An RcfPayload from a parsed JSON file, or null when it is not an RCF payload. */
const toPayload = (parsed: unknown, source: string): RcfPayload | null => {
  if (!isPlainObject(parsed)) return null;
  const records = Array.isArray(parsed.value) ? parsed.value : [parsed];
  if (records.length === 0) return null;
  const header = headerOf(parsed, source);
  return header ? { ...header, records } : null;
};

type OpenBytes = () => Promise<AsyncIterable<Uint8Array>>;

/** What a streamed file is made of: each property of its top-level object, and each element of its `value` array. */
type JsonEvent =
  | { readonly kind: 'member'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'record'; readonly value: unknown };

const BYTE_ORDER_MARK_FIRST_BYTE = 0xef;

/**
 * Parse a file as a stream (`@streamparser/json`; never hand-rolled), yielding each element of the top-level `value`
 * array as it completes and each other top-level property whole. An element is let go of once it is yielded, so a
 * `value` array of any length is never held. The parse is as strict as `JSON.parse`: trailing content, a truncated
 * file and a byte order mark are refused, as `JSON.parse` refuses them.
 */
async function* jsonEvents(bytes: AsyncIterable<Uint8Array>, source: string): AsyncGenerator<JsonEvent> {
  const parser = new JSONParser({ paths: ['$.*', '$.value.*'], keepStack: false });
  const ready: JsonEvent[] = [];
  parser.onValue = ({ value, key, parent, stack }) => {
    if (stack.length === 1) {
      // A property of the top-level object. A top-level array's items (numeric keys) are no payload: the parser
      // drops them as they complete and they are ignored here, so such a file reads as no payload, as before.
      if (typeof key === 'string') ready.push({ kind: 'member', key, value });
      return;
    }
    // An element of `value`. Selecting the `value` member as a whole keeps the parser from dropping its elements, so
    // each is dropped here once it is taken, as the parser itself drops one when nothing above it is selected. A
    // `value` that is an object, not an array, is not records: it arrives whole as the `value` member.
    if (Array.isArray(parent)) {
      ready.push({ kind: 'record', value });
      parent.length = 0;
    }
  };
  const fail = (err: unknown): Error => new Error(`${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  let started = false;
  for await (const chunk of bytes) {
    if (chunk.length === 0) continue;
    // The parser skips a UTF-8 byte order mark. JSON.parse, which read these files before, refuses one, and so does this.
    if (!started && chunk[0] === BYTE_ORDER_MARK_FIRST_BYTE) throw fail(new Error('it begins with a byte order mark'));
    started = true;
    try {
      parser.write(chunk);
    } catch (err) {
      throw fail(err);
    }
    yield* ready.splice(0);
  }
  try {
    if (!parser.isEnded) parser.end();
  } catch (err) {
    throw fail(err);
  }
  yield* ready.splice(0);
}

/** The top-level keys that decide what a payload is. JSON.parse keeps the last of a repeated key, which a stream
 *  cannot know until the end, so a file that repeats one is refused rather than read either way. */
const PAYLOAD_KEYS: ReadonlySet<string> = new Set(['value', '@reso.context', '@odata.context']);

/** Records once, in order, and only while their payload is current; reading them again or later is an error. */
const readOnce = (records: AsyncIterator<unknown>, source: string, isCurrent: () => boolean): AsyncIterable<unknown> => {
  let taken = false;
  return {
    [Symbol.asyncIterator]: () => {
      if (taken || !isCurrent()) throw new Error(`The records of ${source} can be read once, before the next payload is asked for.`);
      taken = true;
      return records;
    }
  };
};

/** Yield a payload whose records are still being read, and stop reading them once the consumer moves on. */
async function* withRecords(header: RcfHeader, records: AsyncGenerator<unknown>): AsyncGenerator<RcfPayload> {
  let current = true;
  try {
    yield { ...header, records: readOnce(records, header.source, () => current) };
  } finally {
    current = false;
    await records.return(undefined);
  }
}

/** The first record, then the rest as the same read reaches them, checking each later top-level key on the way. */
async function* recordsFrom(
  first: unknown,
  events: AsyncGenerator<JsonEvent>,
  take: (event: JsonEvent & { readonly kind: 'member' }) => void
): AsyncGenerator<unknown> {
  yield first;
  for await (const event of events) {
    if (event.kind === 'record') yield event.value;
    else take(event);
  }
}

/** The records of a file read again from its start. */
async function* recordsOf(open: OpenBytes, source: string): AsyncGenerator<unknown> {
  for await (const event of jsonEvents(await open(), source)) if (event.kind === 'record') yield event.value;
}

/**
 * The payload in one streamed file, if it is one. When the context comes before the records, as it usually does, the
 * file is read once and the records are read as they are asked for. When it does not, the file is read twice: once
 * to find the context, dropping the records, and again for the records, so nothing is ever held to wait for it.
 */
async function* streamedPayload(open: OpenBytes, source: string): AsyncGenerator<RcfPayload> {
  const members: Array<readonly [string, unknown]> = [];
  const seen = new Set<string>();
  const take = (event: JsonEvent & { readonly kind: 'member' }): void => {
    if (PAYLOAD_KEYS.has(event.key) && seen.has(event.key)) throw new Error(`${source} gives "${event.key}" more than once.`);
    seen.add(event.key);
    members.push([event.key, event.value]);
  };

  const events = jsonEvents(await open(), source);
  try {
    // Everything up to the first record, or the whole file when it has none.
    const firstRecord = await (async (): Promise<{ readonly value: unknown } | undefined> => {
      for (let next = await events.next(); !next.done; next = await events.next()) {
        if (next.value.kind === 'record') return { value: next.value.value };
        take(next.value);
      }
      return undefined;
    })();

    // No `value` records: a single-record file, an empty `value` or not a payload at all, read as JSON.parse read it.
    if (!firstRecord) {
      const payload = toPayload(Object.fromEntries(members), source);
      if (payload) yield payload;
      return;
    }

    if (seen.has('@reso.context')) {
      const header = headerOf(Object.fromEntries(members), source);
      if (header) yield* withRecords(header, recordsFrom(firstRecord.value, events, take));
      return;
    }

    // The context, if any, is after the records: read on to it, then read the records again.
    for await (const event of events) if (event.kind === 'member') take(event);
    const header = headerOf(Object.fromEntries(members), source);
    if (header) yield* withRecords(header, recordsOf(open, source));
  } finally {
    await events.return(undefined);
  }
}

const openEntry = (zip: ZipFile, entry: ZipEntry): Promise<AsyncIterable<Uint8Array>> =>
  new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
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
      yield* streamedPayload(() => openEntry(zip, entry), entry.fileName);
    }
  } finally {
    // Release the fd even if the consumer abandons the stream early (peekVersion, strict fail-fast,
    // a malformed entry) — yauzl's autoClose only fires on the natural `end`.
    zip.close();
  }
}

async function* readJsonFile(path: string): AsyncGenerator<RcfPayload> {
  yield* streamedPayload(async () => createReadStream(path), path);
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
  else throw new Error(`Unsupported RCF input (expected a .json file, .zip or a directory): ${inputPath}`);
}
