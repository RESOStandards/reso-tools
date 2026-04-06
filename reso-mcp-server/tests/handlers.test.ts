import { describe, it, expect } from 'vitest';
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
      resource: 'Property',
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.fieldsProvided).toBe(3);
    expect(data.resource).toBe('Property');
  });
});

describe('auth resolution', () => {
  it('query throws without any auth', async () => {
    await expect(handlers.query({
      url: 'http://localhost:9999',
      resource: 'Property',
    })).rejects.toThrow('Authentication required');
  });

  it('metadata throws without any auth', async () => {
    await expect(handlers.metadata({
      url: 'http://localhost:9999',
    })).rejects.toThrow('Authentication required');
  });

  it('run-compliance throws for unknown endorsement', async () => {
    await expect(handlers['run-compliance']({
      endorsement: 'nonexistent',
      url: 'http://localhost:9999',
      authToken: 'token',
    })).rejects.toThrow('Unknown endorsement');
  });
});
