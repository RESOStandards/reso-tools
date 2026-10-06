import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_AUTH_TOKEN, ENV_CLIENT_ID, ENV_CLIENT_SECRET, ENV_SCOPE, ENV_TOKEN_URI } from '../src/auth-env.js';
import { handlers } from '../src/handlers.js';

describe('handler registry', () => {
  it('has a handler for every tool', () => {
    const expected = ['authenticate', 'query', 'metadata', 'validate', 'parse-filter', 'run-compliance', 'metadata-report'];
    for (const name of expected) {
      expect(handlers[name]).toBeDefined();
      expect(typeof handlers[name]).toBe('function');
    }
  });
});

describe('handleParseFilter', () => {
  it('parses a simple filter expression', async () => {
    const result = await handlers['parse-filter']({ filter: 'ListPrice gt 200000' });
    expect(result.isError).toBeFalsy();
    const ast = JSON.parse(result.content[0].text);
    expect(ast.type).toBe('comparison');
    expect(ast.operator).toBe('gt');
  });

  it('parses a compound filter', async () => {
    const result = await handlers['parse-filter']({ filter: "ListPrice gt 200000 and City eq 'Austin'" });
    expect(result.isError).toBeFalsy();
    const ast = JSON.parse(result.content[0].text);
    expect(ast.type).toBe('logical');
    expect(ast.operator).toBe('and');
  });

  it('returns error for invalid filter', async () => {
    const result = await handlers['parse-filter']({ filter: '(((' });
    expect(result.isError).toBe(true);
  });
});

describe('handleValidate', () => {
  it('returns field count for a record', async () => {
    const result = await handlers.validate({
      record: { ListPrice: 350000, City: 'Austin', BedroomsTotal: 3 },
      resource: 'Property'
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.fieldsProvided).toBe(3);
    expect(data.resource).toBe('Property');
  });
});

describe('auth resolution', () => {
  // The environment is a credential channel now, so these refusal tests have to state their own
  // environment. Without this the suite would pass or fail depending on the developer's shell, and
  // a shell exporting RESO_AUTH_TOKEN would turn a refusal into a live request.
  beforeEach(() => {
    for (const name of [ENV_AUTH_TOKEN, ENV_CLIENT_ID, ENV_CLIENT_SECRET, ENV_TOKEN_URI, ENV_SCOPE]) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('query throws without any auth', async () => {
    await expect(
      handlers.query({
        url: 'http://localhost:9999',
        resource: 'Property'
      })
    ).rejects.toThrow('Authentication required');
  });

  it('metadata throws without any auth', async () => {
    await expect(
      handlers.metadata({
        url: 'http://localhost:9999'
      })
    ).rejects.toThrow('Authentication required');
  });

  it('run-compliance throws for unknown endorsement', async () => {
    await expect(
      handlers['run-compliance']({
        endorsement: 'nonexistent',
        url: 'http://localhost:9999',
        authToken: 'token'
      })
    ).rejects.toThrow('Unknown endorsement');
  });
});
