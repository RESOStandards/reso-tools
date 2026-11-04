import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_ITEM_BYTES, type RcfPayload, jsonEvents, readRcfPayloads } from '../../src/cli/rcf-input.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/rcf');

/** A payload with its records read, as the payload stream requires, before the next is asked for. */
interface ReadPayload extends Omit<RcfPayload, 'records'> {
  readonly records: ReadonlyArray<unknown>;
}

const collect = async (input: string): Promise<ReadPayload[]> => {
  const out: ReadPayload[] = [];
  for await (const p of readRcfPayloads(input)) {
    const records: unknown[] = [];
    for await (const record of p.records) records.push(record);
    out.push({ ...p, records });
  }
  return out;
};

const tmp = mkdtempSync(join(tmpdir(), 'rcf-input-'));
/** A file of exactly this text. */
const fileOf = (name: string, text: string | Buffer): string => {
  const path = join(tmp, name);
  writeFileSync(path, text);
  return path;
};

const PROPERTY_CONTEXT = '"@reso.context":"urn:reso:metadata:2.0:resource:property"';

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

// #263: a file is read as a stream, so a payload past V8's largest string is read like any other. These pin that the
// stream reads every file as JSON.parse read it, and refuses what JSON.parse refused.
describe('readRcfPayloads reads each file as JSON.parse did', () => {
  it('reads the records in order, with the context before them or after', async () => {
    const records = '[{"ListingKey":"1"},{"ListingKey":"2"},{"ListingKey":"3"}]';
    const before = await collect(fileOf('before.json', `{${PROPERTY_CONTEXT},"value":${records}}`));
    const after = await collect(fileOf('after.json', `{"value":${records},${PROPERTY_CONTEXT}}`));
    expect(after).toEqual([{ ...before[0], source: join(tmp, 'after.json') }]);
    expect(after[0].records).toEqual(JSON.parse(records));
  });

  it('reads a zip entry whose context follows its records', async () => {
    const payloads = await collect(resolve(fixtures, 'context-last.zip'));
    expect(payloads.map(p => [p.source, p.resource, p.records.length])).toEqual([
      ['early.json', 'Member', 1],
      ['late.json', 'Property', 3]
    ]);
  });

  it('reads the resource from an @odata.context, and a later @reso.context over it', async () => {
    const odata = '"@odata.context":"https://example.com/$metadata#Property"';
    const [odataOnly] = await collect(fileOf('odata.json', `{${odata},"value":[{"ListingKey":"1"}]}`));
    expect(odataOnly).toMatchObject({ resource: 'Property', records: [{ ListingKey: '1' }] });
    expect(odataOnly.version).toBeUndefined();
    const [both] = await collect(
      fileOf('both.json', `{${odata},"value":[{"ListingKey":"1"}],"@reso.context":"urn:reso:metadata:2.1:resource:member"}`)
    );
    expect(both).toMatchObject({ resource: 'Member', version: '2.1' });
  });

  it('reads a file with no value array as one record, and skips one with an empty value', async () => {
    const single = `{${PROPERTY_CONTEXT},"ListingKey":"1","Media":[{"MediaKey":"m"}]}`;
    expect((await collect(fileOf('single.json', single)))[0].records).toEqual([JSON.parse(single)]);
    const valueObject = `{${PROPERTY_CONTEXT},"value":{"ListingKey":"1"}}`;
    expect((await collect(fileOf('value-object.json', valueObject)))[0].records).toEqual([JSON.parse(valueObject)]);
    expect(await collect(fileOf('empty.json', `{${PROPERTY_CONTEXT},"value":[]}`))).toEqual([]);
  });

  it('skips a file that is no payload: no context, an array or a scalar', async () => {
    expect(await collect(fileOf('no-context.json', '{"value":[{"ListingKey":"1"}]}'))).toEqual([]);
    expect(await collect(fileOf('array.json', `[{${PROPERTY_CONTEXT},"value":[{"ListingKey":"1"}]}]`))).toEqual([]);
    expect(await collect(fileOf('scalar.json', '"text"'))).toEqual([]);
  });

  it('keeps an unreadable @reso.context, with its records, for validation to report', async () => {
    const [payload] = await collect(fileOf('bad-context.json', '{"@reso.context":{"no":1},"value":[{"ListingKey":"1"}]}'));
    expect(payload).toMatchObject({ resource: '_INVALID_', invalidContext: true, context: '{"no":1}', records: [{ ListingKey: '1' }] });
  });

  it('keeps every value as JSON.parse gives it', async () => {
    const record =
      '{"__proto__":{"x":1},"N":[0,-0,1.0,1e400,9007199254740993,5e-324],"S":"é😀\\u00e9\\ud83d\\ude00\\ud800","B":[true,false,null]}';
    const [payload] = await collect(fileOf('values.json', `{${PROPERTY_CONTEXT},"value":[${record}]}`));
    expect(payload.records).toEqual([JSON.parse(record)]);
    expect(Object.getPrototypeOf(payload.records[0])).toBe(Object.prototype);
  });

  it('refuses what JSON.parse refused, naming the file', async () => {
    const valid = `{${PROPERTY_CONTEXT},"value":[{"ListingKey":"1"}]}`;
    await expect(collect(fileOf('trailing.json', `${valid} x`))).rejects.toThrow(/trailing\.json is not valid JSON/);
    await expect(collect(fileOf('two.json', `${valid}${valid}`))).rejects.toThrow(/two\.json is not valid JSON/);
    await expect(collect(fileOf('truncated.json', valid.slice(0, -3)))).rejects.toThrow(/truncated\.json is not valid JSON/);
    await expect(collect(fileOf('bom.json', `﻿${valid}`))).rejects.toThrow(/bom\.json is not valid JSON: it begins with a byte order mark/);
    await expect(collect(fileOf('nan.json', `{${PROPERTY_CONTEXT},"value":[{"A":NaN}]}`))).rejects.toThrow(/nan\.json is not valid JSON/);
  });

  it('refuses a file that gives value or a context twice, which JSON.parse read as the last', async () => {
    await expect(collect(fileOf('two-values.json', `{${PROPERTY_CONTEXT},"value":[{"A":1}],"value":[]}`))).rejects.toThrow(
      /two-values\.json gives "value" more than once/
    );
    await expect(collect(fileOf('two-contexts.json', `{${PROPERTY_CONTEXT},"value":[{"A":1}],${PROPERTY_CONTEXT}}`))).rejects.toThrow(
      /gives "@reso\.context" more than once/
    );
  });

  it('gives each payload’s records once, before the next payload is asked for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcf-input-order-'));
    writeFileSync(join(dir, 'a.json'), `{${PROPERTY_CONTEXT},"value":[{"ListingKey":"1"}]}`);
    writeFileSync(join(dir, 'b.json'), `{${PROPERTY_CONTEXT},"value":[{"ListingKey":"2"}]}`);
    const payloads: RcfPayload[] = [];
    for await (const p of readRcfPayloads(dir)) payloads.push(p);
    const read = async (p: RcfPayload): Promise<unknown[]> => {
      const records: unknown[] = [];
      for await (const record of p.records) records.push(record);
      return records;
    };
    await expect(read(payloads[0])).rejects.toThrow(/records of .*a\.json can be read once, before the next payload is asked for/);
  });
});

/** A file's bytes in chunks of `size`, as a stream delivers them. */
async function* chunked(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

const eventsOf = async (text: string, cap: number) => {
  const events: Array<{ readonly kind: string }> = [];
  for await (const event of jsonEvents(chunked(text, 16), 'f.json', cap)) events.push(event);
  return events;
};

// One record, or one other top-level member, is held whole while it is read. A file made to hold a very large one
// would cost that much memory, so each is bounded. The number of records is not.
describe('one record or member is bounded, and the number of records is not', () => {
  const CONTEXT = 'urn:reso:metadata:2.0:resource:property';

  it('refuses a record larger than the bound, naming the file', async () => {
    const text = JSON.stringify({ '@reso.context': CONTEXT, value: [{ ListingKey: 'x'.repeat(500) }] });
    await expect(eventsOf(text, 200)).rejects.toThrow('f.json holds a record or top-level member larger than 200 bytes');
  });

  it('refuses a top-level member larger than the bound', async () => {
    const text = JSON.stringify({ '@reso.context': CONTEXT, note: 'y'.repeat(500), value: [] });
    await expect(eventsOf(text, 200)).rejects.toThrow('larger than 200 bytes');
  });

  it('reads any number of records under the bound, though together they pass it many times over', async () => {
    const records = Array.from({ length: 200 }, (_, index) => ({ ListingKey: `L${index}` }));
    const text = JSON.stringify({ '@reso.context': CONTEXT, value: records });
    expect(text.length).toBeGreaterThan(20 * 200);
    expect((await eventsOf(text, 200)).filter(event => event.kind === 'record')).toHaveLength(200);
  });

  it('is 64 MiB unless a test says otherwise', () => {
    expect(MAX_ITEM_BYTES).toBe(64 * 1024 * 1024);
  });
});
