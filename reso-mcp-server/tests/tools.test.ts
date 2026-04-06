import { describe, it, expect } from 'vitest';
import { allTools, toolsForScope } from '../src/tools.js';

describe('tool definitions', () => {
  it('has 7 tools total', () => {
    expect(allTools).toHaveLength(7);
  });

  it('all tools have unique names', () => {
    const names = allTools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools have descriptions', () => {
    for (const tool of allTools) {
      expect(tool.description).toBeTruthy();
    }
  });

  it('all tools have input schemas', () => {
    for (const tool of allTools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('cert scope returns only cert tools', () => {
    const certTools = toolsForScope('cert');
    expect(certTools.every(t => t.scope === 'cert')).toBe(true);
    expect(certTools.length).toBeGreaterThan(0);
    expect(certTools.length).toBeLessThan(allTools.length);
  });

  it('all scope returns all tools', () => {
    expect(toolsForScope('all')).toHaveLength(allTools.length);
  });

  it('authenticate tool exists with required params', () => {
    const auth = allTools.find(t => t.name === 'authenticate');
    expect(auth).toBeDefined();
    const required = auth!.inputSchema.required as string[];
    expect(required).toContain('clientId');
    expect(required).toContain('clientSecret');
    expect(required).toContain('tokenUrl');
  });

  it('query tool accepts auth via token or client credentials', () => {
    const query = allTools.find(t => t.name === 'query');
    expect(query).toBeDefined();
    const props = query!.inputSchema.properties as Record<string, unknown>;
    expect(props.authToken).toBeDefined();
    expect(props.clientId).toBeDefined();
    expect(props.clientSecret).toBeDefined();
    expect(props.tokenUrl).toBeDefined();
  });

  it('query tool requires url and resource', () => {
    const query = allTools.find(t => t.name === 'query');
    const required = query!.inputSchema.required as string[];
    expect(required).toContain('url');
    expect(required).toContain('resource');
  });

  it('run-compliance tool supports all three endorsements', () => {
    const compliance = allTools.find(t => t.name === 'run-compliance');
    const props = compliance!.inputSchema.properties as Record<string, Record<string, unknown>>;
    const endorsement = props.endorsement;
    expect(endorsement.enum).toContain('add-edit');
    expect(endorsement.enum).toContain('entity-event');
    expect(endorsement.enum).toContain('core');
  });

  it('metadata tool is in all scope', () => {
    const metadata = allTools.find(t => t.name === 'metadata');
    expect(metadata?.scope).toBe('all');
  });

  it('run-compliance tool is in cert scope', () => {
    const compliance = allTools.find(t => t.name === 'run-compliance');
    expect(compliance?.scope).toBe('cert');
  });
});
