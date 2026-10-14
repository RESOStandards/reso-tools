/**
 * `--output json` must not print a credential.
 *
 * This is the shape of the defect it guards: the CLI serialized the pipeline result with a bare
 * JSON.stringify, the result carries the accumulated context, and the context carries the bearer
 * token the steps use to make requests. The guide recommends archiving that output in a results
 * store, so the tool was telling people to file their own credentials.
 *
 * Two layers are asserted separately, because each is sufficient on its own and a test that only
 * checked the final string could not tell which one was doing the work.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { formatResultJson } from '../../src/cli/result-json.js';
import { __clearSecretsForTest, registerSecret } from '../../src/cli/secrets.js';
import type { PipelineResult } from '../../src/sdk/types.js';

const TOKEN = 'SENTINEL-token-abcdef';

const resultWithToken = (): PipelineResult =>
  ({
    status: 'passed',
    endorsement: 'core',
    duration: 1,
    certification: { valid: true },
    steps: [
      {
        name: 'Service check',
        endorsement: 'core',
        status: 'passed',
        duration: 1,
        // A credential reaches output by paths nobody enumerated. This is one of them: a request
        // URL that happens to carry the token as a query parameter.
        requestDetails: [{ method: 'GET', url: `https://example.org/Property?access_token=${TOKEN}` }]
      }
    ],
    context: { serverUrl: 'https://example.org', authToken: TOKEN, outputPath: '/tmp/x' }
  }) as unknown as PipelineResult;

describe('formatResultJson', () => {
  beforeEach(() => __clearSecretsForTest());

  it('drops authToken from the serialized context', () => {
    const json = formatResultJson([resultWithToken()]);
    expect(json).not.toContain('"authToken"');
  });

  /**
   * The layer that matters for the unknown paths. Dropping one field cannot help a token echoed in
   * a request URL; only value-based masking can.
   */
  it('masks a registered secret that appears somewhere other than the dropped field', () => {
    registerSecret(TOKEN);
    const json = formatResultJson([resultWithToken()]);

    expect(json).not.toContain(TOKEN);
    expect(json).toContain('****cdef');
    // and the URL is still there, so the report is still useful for debugging
    expect(json).toContain('https://example.org/Property?access_token=****cdef');
  });

  it('still produces valid JSON with the result shape intact', () => {
    registerSecret(TOKEN);
    const parsed = JSON.parse(formatResultJson([resultWithToken()]));
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(['status', 'endorsement', 'steps', 'context', 'duration', 'certification']));
    expect(parsed.context.serverUrl).toBe('https://example.org');
  });

  /**
   * An unregistered secret is NOT masked, which is the honest limit of value-based masking and the
   * reason the registration points matter more than the masker does. Asserted so the limit is
   * visible rather than discovered.
   */
  it('cannot mask a value it was never given', () => {
    const json = formatResultJson([resultWithToken()]);
    expect(json).toContain(TOKEN); // in the request URL — authToken is dropped regardless
  });
});
