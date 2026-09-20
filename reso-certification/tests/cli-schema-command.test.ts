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

  // Review round 2 (2026-09-19): a payload the command never evaluated must never read as a pass. Before, a
  // resource the schema does not define crashed the command (exit 2); the round-1 fix made every validate()
  // exit return its caches, which turned that crash into "0 errors" / exit 0.
  it('a resource the schema does not define → an error naming the resource, never 0 errors for a payload that was not validated', async () => {
    // no context on the payload: on this command's (legacy) path a present @reso.context selects the resource
    // over -r, so the unknown-resource exit is reached through -r only when the payload carries none
    const { '@reso.context': _ctx, ...contextless } = valuePayload as Record<string, unknown>;
    const { totalErrors, report } = await validateSchemaPayload({
      metadataReportJson: metadata,
      jsonPayload: contextless,
      resourceName: 'NotAResource',
      version: '2.0',
    });
    expect(totalErrors).toBeGreaterThan(0);
    expect(JSON.stringify(report)).toMatch(/NotAResource.*not defined|not defined.*NotAResource/);
  });

  it('a @reso.context naming a resource the schema does not define, no -r → one counted error naming it, never a silent pass', async () => {
    const { totalErrors, report } = await validateSchemaPayload({
      metadataReportJson: metadata,
      jsonPayload: { '@reso.context': 'urn:reso:metadata:2.0:resource:NotAResource', value: [{ ListingKey: 'x' }] },
      version: '2.0',
    });
    expect(totalErrors).toBe(1);
    expect(JSON.stringify(report)).toMatch(/NotAResource.*not defined/);
  });

  it('a @reso.context the resolver cannot read at all, no -r → one counted error saying so, keyed under a named resource, never ""', async () => {
    for (const context of ['urn:reso:metadata:2.0', 'URN:RESO:METADATA:2.0:RESOURCE:PROPERTY']) {
      const { totalErrors, report } = await validateSchemaPayload({
        metadataReportJson: metadata,
        jsonPayload: { '@reso.context': context, value: [{ ListingKey: 'x' }] },
        version: '2.0',
      });
      expect(totalErrors).toBe(1);
      expect(JSON.stringify(report)).toMatch(/could not be resolved to a resource/);
      const resourceKeys = Object.values((report as { errors: Record<string, { resources: Record<string, unknown> }> }).errors).flatMap(e => Object.keys(e.resources));
      expect(resourceKeys).not.toContain('');
    }
  });

  it('a Core-form version (2.1.0) finds the 2.1-keyed exemptions: an ignoreEnumerations field is a warning, not an error', async () => {
    // the settings file is keyed by the Data Dictionary form; an unnormalized 2.1.0 missed every exemption
    const meta21 = getReferenceMetadata('2.1');
    const settings = await loadSettings(resolveSettingsPath());
    const payload = { '@reso.context': 'urn:reso:metadata:2.1:resource:property', value: [{ ListingKey: 'x', MLSAreaMajor: 'NotAnAdvertisedValue' }] };
    const asDd = await validateSchemaPayload({ metadataReportJson: meta21, jsonPayload: payload, version: '2.1', validationConfig: settings });
    const asCore = await validateSchemaPayload({ metadataReportJson: meta21, jsonPayload: payload, version: '2.1.0', validationConfig: settings });
    expect(asDd.totalErrors).toBe(0);
    expect(asCore.totalErrors).toBe(0); // before: 1 (the exemption keyed "2.1" was not found under "2.1.0")
    expect((asCore.report as { totalWarnings: number }).totalWarnings).toBe((asDd.report as { totalWarnings: number }).totalWarnings);
  });

  it('a top-level payload that is neither an object nor a collection (a bare array, a string, a number) is refused, never PASS', async () => {
    for (const jsonPayload of [[{ ListingKey: 'x' }], 'not a payload', 42, null]) {
      await expect(validateSchemaPayload({ metadataReportJson: metadata, jsonPayload, resourceName: 'Property', version: '2.0' })).rejects.toThrow(/payload must be a JSON object/);
    }
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
