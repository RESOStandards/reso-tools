import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMetadataStep } from '../src/cli/metadata-command.js';

const readFixture = (p: string): Promise<string> => readFile(resolve(import.meta.dirname, p), 'utf-8');

describe('runMetadataStep — the metadata cert step (validate + serialize)', () => {
  it('a valid CSDL passes the verdict and serializes a RESO Format report', async () => {
    const xml = await readFixture('fixtures/commander/good-edmx.xml');
    const result = await runMetadataStep({ metadataXml: xml, ddVersion: '2.0' });
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.report?.resources.length).toBeGreaterThan(0);
    expect(result.report?.fields.length).toBeGreaterThan(0);
  });

  it('fails the verdict on structurally broken CSDL (XSD catches the stray character)', async () => {
    const xml = await readFixture('fixtures/commander/bad-edmx-unparsable-xml.xml');
    const result = await runMetadataStep({ metadataXml: xml, ddVersion: '2.0' });
    expect(result.passed).toBe(false);
    expect(result.validation.xsdValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('fails the verdict on a semantically invalid CSDL (missing entity key)', async () => {
    const xml = await readFixture('fixtures/commander/bad-edmx-no-keyfield.xml');
    const result = await runMetadataStep({ metadataXml: xml, ddVersion: '2.0' });
    expect(result.passed).toBe(false);
    expect(result.validation.semanticValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('--no-report (emitReport: false) validates without serializing', async () => {
    const xml = await readFixture('fixtures/commander/good-edmx.xml');
    const result = await runMetadataStep({ metadataXml: xml, ddVersion: '2.0', emitReport: false });
    expect(result.passed).toBe(true);
    expect(result.report).toBeUndefined();
  });

  // A metadata document with no EntityContainer is caught at the semantic layer (the new validator check) and
  // also can't serialize — the step fails with both signals, each pointing at the missing container.
  it('fails when the metadata declares no EntityContainer, surfacing a report error too', async () => {
    const xml = await readFixture('../sample-metadata.xml');
    const result = await runMetadataStep({ metadataXml: xml, ddVersion: '2.0' });
    expect(result.passed).toBe(false);
    expect(result.validation.semanticValid).toBe(false);
    expect(result.errors.some(e => e.includes('EntityContainer'))).toBe(true);
    expect(result.reportError).toContain('EntityContainer');
  });
});
