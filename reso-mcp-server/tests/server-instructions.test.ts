/**
 * The server declares MCP `instructions`, sent once at initialize, which is where the register is
 * set: who the assistant is talking to and how to answer them.
 *
 * It is worth testing for two reasons. It is a public surface, since every client's model receives
 * it verbatim, so its wording is a contract rather than a comment. And it is the one place in this
 * package that could leak a credential example into a model's context, which is the thing the rest
 * of the credential design exists to prevent.
 *
 * The handshake test is the one that matters. A declared string that the SDK never transmits is a
 * comment with extra steps, so the assertion is on what comes back over stdio, not on the constant.
 *
 * The constant is imported from `src/instructions.ts`, not from `src/index.ts`. That file ends in a
 * top-level `await server.connect(...)`, so importing it here would boot a stdio server on the test
 * runner's own stdin.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/instructions.js';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('../package.json'));

describe('the server instructions set the register', () => {
  it('names the audience rather than leaving the model to guess at it', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/knows real estate/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/not necessarily more than that/i);
  });

  it('keeps query syntax out of answers unless the person asks how it works', () => {
    // The published-material feedback this exists to answer was that RESO writing sounded too
    // technical for its readers. If this sentence goes, that is the behavior that comes back.
    expect(SERVER_INSTRUCTIONS).toMatch(/field names/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/query syntax/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/unless they ask/i);
  });

  it('forbids estimating a number the data did not supply', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/never state a number you did not get from a query/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/never close a gap by estimating/i);
  });

  it('tells the model not to ask the person for a credential', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/do not ask the person for a token/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/do not put one in a tool call/i);
  });

  it('contains no credential value, placeholder or example of any kind', () => {
    // A placeholder in a model's context is an invitation to fill it in. There is nothing here that
    // looks like a secret to substitute.
    expect(SERVER_INSTRUCTIONS).not.toMatch(/Bearer\s+\S/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/your-(token|client-id|client-secret)/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/authToken\s*[:=]/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/clientSecret\s*[:=]/);
  });
});

describe('the instructions actually reach a client', () => {
  const entry = join(packageRoot, 'dist', 'index.js');

  it.runIf(existsSync(entry))('returns them in the initialize result over stdio, not just in the constructor', () => {
    const request = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'instructions-test', version: '0' }
      }
    })}\n`;

    const stdout = execFileSync('node', [entry], {
      input: request,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['pipe', 'pipe', 'ignore']
    });

    const initialize = stdout
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map((line): Record<string, unknown> | null => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find(message => {
        const result = message?.result as { serverInfo?: unknown } | undefined;
        return result?.serverInfo !== undefined;
      });

    expect(initialize).toBeDefined();

    const result = initialize?.result as { instructions?: string };
    expect(result.instructions).toBe(SERVER_INSTRUCTIONS);
  });
});
