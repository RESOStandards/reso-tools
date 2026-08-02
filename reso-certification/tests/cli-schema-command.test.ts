import { describe, it, expect } from 'vitest';
import { basename, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { validateSchemaPayload, resolveSettingsPath, loadSettings } from '../src/cli/schema-command.js';

const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../src/etl/index.cjs'));
const { valuePayload, enumMismatchPayload } = require(resolve(import.meta.dirname, './legacy/fixtures/payload-samples.cjs'));

// A conforming provider advertises the Open-lookup values it serves; the valid sample payloads carry a City
// value, so advertise it (same setup as the ported schema-validation suite) — otherwise City is an incidental
// unadvertised error and the "valid" case would report > 0.
const CITY = 'org.reso.metadata.enums.City';
const advertise = (meta: { lookups: unknown[] }, entries: ReadonlyArray<readonly [string, string]>) => ({
  ...meta,
  lookups: [...meta.lookups, ...entries.map(([lookupName, lookupValue]) => ({ lookupName, lookupValue, type: 'Edm.String' }))],
});
const metadata = advertise(getReferenceMetadata('2.0'), [[CITY, 'SampleCityEnumValue']]);

describe('validateSchemaPayload — the schema command verdict core', () => {
  it('a conforming payload → 0 errors (exit 0)', async () => {
    const { totalErrors } = await validateSchemaPayload({
      metadataReportJson: metadata,
      jsonPayload: valuePayload,
      resourceName: 'Property',
      version: '2.0',
    });
    expect(totalErrors).toBe(0);
  });

  it('an unadvertised enum value → > 0 errors (exit 1 — the verdict the CLI reflects)', async () => {
    const { totalErrors, report } = await validateSchemaPayload({
      metadataReportJson: metadata,
      jsonPayload: enumMismatchPayload,
      resourceName: 'Property',
      version: '2.0',
    });
    expect(totalErrors).toBeGreaterThan(0);
    expect(report).toBeDefined();
  });
});

describe('resolveSettingsPath — explicit → CWD → pre-baked precedence', () => {
  it('honors an explicit path', () => {
    expect(resolveSettingsPath('/tmp/my-settings.json')).toBe(resolve('/tmp/my-settings.json'));
  });

  it('falls back to the pre-baked package settings when nothing else is given', () => {
    const p = resolveSettingsPath();
    expect(p).toBeDefined();
    expect(basename(p as string)).toBe('schema-validation-settings.json');
  });
});

describe('loadSettings — the exemptions config', () => {
  it('loads the pre-baked settings (carries the 2.0 and 2.1 stanzas)', async () => {
    const cfg = await loadSettings();
    expect(Object.keys(cfg)).toEqual(expect.arrayContaining(['2.0', '2.1']));
  });
});
