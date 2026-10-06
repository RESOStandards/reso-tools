import { describe, expect, it } from 'vitest';
import { CREDENTIAL_ARG_NAMES, ENV_AUTH_TOKEN, ENV_CLIENT_ID, ENV_CLIENT_SECRET, ENV_TOKEN_URI } from '../src/auth-env.js';
import { allTools, toolsForScope } from '../src/tools.js';

describe('tool definitions', () => {
  it('has 10 tools total', () => {
    expect(allTools).toHaveLength(10);
  });

  it('write tools (create/update/delete) have correct destructive hints', () => {
    const create = allTools.find(t => t.name === 'create');
    const update = allTools.find(t => t.name === 'update');
    const del = allTools.find(t => t.name === 'delete');

    expect(create?.annotations?.destructiveHint).toBe(false);
    expect(create?.annotations?.idempotentHint).toBe(false);

    expect(update?.annotations?.destructiveHint).toBe(false);
    expect(update?.annotations?.idempotentHint).toBe(true);

    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(del?.annotations?.idempotentHint).toBe(true);
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

  // Remove the empty required list and the schema forces an assistant to obtain a client secret
  // before it can call the tool, and the only place it can obtain one is the user, in the
  // conversation. That is the defect this change exists to close.
  it('authenticate requires nothing, so the environment can be checked with no arguments', () => {
    const auth = allTools.find(t => t.name === 'authenticate');
    expect(auth).toBeDefined();
    expect(auth!.inputSchema.required).toEqual([]);
    const props = auth!.inputSchema.properties as Record<string, unknown>;
    for (const name of [...CREDENTIAL_ARG_NAMES, 'scope']) expect(props[name]).toBeDefined();
  });

  // Remove this and a future tool can reintroduce the same invitation on a different schema.
  it('no tool lists a credential in its required arguments', () => {
    for (const tool of allTools) {
      const required = (tool.inputSchema.required ?? []) as ReadonlyArray<string>;
      for (const name of CREDENTIAL_ARG_NAMES) expect(required).not.toContain(name);
    }
  });

  // The MCP SDK validates arguments with zod and forwards the validation error text to the host.
  // A plain string rejection names the received TYPE, but an enum rejection names the received
  // VALUE. Remove this and declaring a credential field as an enum would echo a rejected secret
  // into the conversation through the validation error.
  it('no credential property is declared as an enum', () => {
    for (const tool of allTools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const name of CREDENTIAL_ARG_NAMES) {
        if (props[name]) expect(props[name].enum).toBeUndefined();
      }
    }
  });

  // Remove this and a description can come to name a variable the resolver does not read, which is
  // confident-but-false guidance arriving through the tool schema instead of the documentation.
  //
  // This asserts the per-field CLAUSE and the ABSENCE of the other three, not bare containment.
  // Bare containment could not fail: the shared note interpolates a channel string that already
  // lists all four variable names, so `toContain(variable)` was satisfied for every variable
  // regardless of which one a given description actually claimed to override — including a
  // description naming the WRONG one, the exact failure this test exists to catch. Verified by
  // mutation: with bare containment, stripping the override clause from all four descriptions left
  // the whole suite passing.
  it('every credential description names the environment variable it overrides, and no other', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['authToken', ENV_AUTH_TOKEN],
      ['clientId', ENV_CLIENT_ID],
      ['clientSecret', ENV_CLIENT_SECRET],
      ['tokenUrl', ENV_TOKEN_URI]
    ];
    for (const tool of allTools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [name, variable] of expected) {
        if (!props[name]) continue;
        const description = String(props[name].description);
        expect(description).toContain(`overriding ${variable} for this one call`);
        for (const [, otherVariable] of expected) {
          if (otherVariable !== variable) expect(description).not.toContain(`overriding ${otherVariable}`);
        }
      }
    }
  });

  // resolveToken builds a fresh provider on every call, so no token survives one tool call. The old
  // description promised caching and promised to return a token; remove this and either claim can
  // come back and teach a reader to expect a token in the result.
  it('the authenticate description promises neither a returned token nor caching', () => {
    const auth = allTools.find(t => t.name === 'authenticate');
    expect(auth!.description).not.toMatch(/cached/i);
    expect(auth!.description).not.toMatch(/returns a token/i);
    expect(auth!.description).toContain('never returned');
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
