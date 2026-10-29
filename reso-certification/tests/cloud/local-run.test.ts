import { describe, expect, it } from 'vitest';
import { cloudEntryOf, isSuccessfulRun, localRunRecordOf } from '../../src/cloud/local-run.js';
import { SOFTWARE_VERSION } from '../../src/sdk/reports.js';
import type { CoreConfig, PipelineResult } from '../../src/sdk/types.js';

/**
 * What a cloud run is started from: a local run that passed and can be certified, and the configuration as it
 * ran, flags included.
 *
 * Identities and credentials here are synthetic.
 */

const config = (over: Partial<CoreConfig> = {}): CoreConfig => ({
  endorsement: 'core',
  server: { url: 'https://api.example.com/odata', auth: { mode: 'token', authToken: 'server-token-for-tests' } },
  version: '2.1.0',
  providerUoi: 'T00000000',
  providerUsi: '99999',
  recipientUoi: 'M00000000',
  ...over
});

const passed: PipelineResult = {
  status: 'passed',
  endorsement: 'core',
  steps: [],
  context: {},
  duration: 1,
  certification: { valid: true }
};

const NOW = new Date('2026-10-29T20:00:00.000Z');

describe('isSuccessfulRun', () => {
  it('is a run that passed and can be certified, and nothing else', () => {
    expect(isSuccessfulRun(passed)).toBe(true);
    expect(isSuccessfulRun({ ...passed, status: 'failed' })).toBe(false);
    expect(isSuccessfulRun({ ...passed, status: 'incomplete' })).toBe(false);
    expect(isSuccessfulRun({ ...passed, certification: { valid: false, reasons: ['a required step did not run'] } })).toBe(false);
  });
});

describe('localRunRecordOf', () => {
  it('records the target, the versions, the time and the verdict', () => {
    expect(localRunRecordOf(passed, config(), NOW)).toEqual({
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      serviceRootUri: 'https://api.example.com/odata',
      endorsementName: 'web-api-core',
      endorsementVersion: '2.1.0',
      softwareVersion: SOFTWARE_VERSION,
      generatedOn: NOW.toISOString(),
      outcome: 'passed',
      certification: { valid: true },
      remarks: expect.any(String)
    });
  });

  it('records the version as the run normalized it', () => {
    expect(localRunRecordOf(passed, config({ version: '2.0.0' }), NOW)?.endorsementVersion).toBe('2.0.0');
    expect(localRunRecordOf(passed, config({ version: undefined }), NOW)?.endorsementVersion).toBe('2.1.0');
  });

  it('has nothing for a run that does not name its provider, system and recipient', () => {
    expect(localRunRecordOf(passed, config({ providerUsi: undefined }), NOW)).toBeUndefined();
    expect(localRunRecordOf(passed, config({ recipientUoi: ' ' }), NOW)).toBeUndefined();
  });
});

describe('cloudEntryOf', () => {
  it('carries the server, the bearer token and the options the run used', () => {
    expect(
      cloudEntryOf(
        config({
          enumMode: 'collections',
          resources: ['Property', 'Member'],
          fieldOverrides: ['Office.FeedTypes'],
          fullCoverage: true,
          originatingSystemName: 'Example'
        }),
        'Feed one'
      )
    ).toEqual({
      description: 'Feed one',
      serviceRootUri: 'https://api.example.com/odata',
      recipientUoi: 'M00000000',
      providerUsi: '99999',
      token: 'server-token-for-tests',
      originatingSystemName: 'Example',
      coreOptions: {
        version: '2.1.0',
        enumMode: 'collections',
        resources: ['Property', 'Member'],
        fieldOverrides: ['Office.FeedTypes'],
        fullCoverage: true
      }
    });
  });

  it('carries client credentials in the shape a config file uses', () => {
    const entry = cloudEntryOf(
      config({
        server: {
          url: 'https://api.example.com/odata',
          auth: {
            mode: 'client_credentials',
            clientId: 'client',
            clientSecret: 'secret-for-tests',
            tokenUrl: 'https://auth.example.com/token',
            scope: 'api'
          }
        }
      })
    );
    expect(entry?.clientCredentials).toEqual({
      clientId: 'client',
      clientSecret: 'secret-for-tests',
      tokenUri: 'https://auth.example.com/token',
      scope: 'api'
    });
    expect(entry?.token).toBeUndefined();
  });

  it('has nothing for a run that does not name its provider, system and recipient', () => {
    expect(cloudEntryOf(config({ providerUoi: undefined }))).toBeUndefined();
  });
});
