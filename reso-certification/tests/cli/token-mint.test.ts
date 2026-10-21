import type { Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeMintRefusal, mintOAuth2ClientCredentialsToken, readOAuth2ErrorFields } from '../../src/cli/auth.js';
import { __clearSecretsForTest } from '../../src/cli/secrets.js';
import { cliAuthRejectedMessage, cliAuthRequiredMessage } from '../../src/sdk/common.js';

// The secret every request carries. Long enough to be registered for masking.
const CLIENT_SECRET = 'c2VjcmV0LWtleS1pZDpzZWNyZXQta2V5LXZhbHVl';

let server: Server;
let tokenUri: string;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // Each client_id selects one way a token endpoint can answer.
  app.post('/api/v1/oauth/token', (req, res) => {
    const { client_id } = req.body as Record<string, string>;
    switch (client_id) {
      case 'good':
        res.json({ access_token: 'minted-token-value-0001', token_type: 'Bearer', expires_in: 3600 });
        return;
      case 'refused':
        // The certification site's refusal, verbatim.
        res.status(400).json({ error: 'access_denied', error_description: 'Unauthorized' });
        return;
      case 'server-fault':
        res.status(500).json({ error: 'server_error', error_description: 'Unable to issue a token' });
        return;
      case 'html':
        res.status(502).type('html').send('<html><body><h1>502 Bad Gateway</h1><script>x()</script></body></html>');
        return;
      case 'echoes-secret':
        res.status(400).json({ error: 'invalid_request', error_description: `bad secret ${CLIENT_SECRET}` });
        return;
      default:
        res.status(400).json({ error: 'invalid_request' });
    }
  });

  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      tokenUri = `${origin}/api/v1/oauth/token`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
  });
});

const ENV_KEYS = ['TOKEN_URI', 'CLIENT_ID', 'CLIENT_SECRET'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  __clearSecretsForTest();
});

/** Run the mint as the CLI does, returning the token and everything it printed. */
const mintAs = async (clientId: string): Promise<{ token: string | undefined; printed: string }> => {
  process.env.TOKEN_URI = tokenUri;
  process.env.CLIENT_ID = clientId;
  process.env.CLIENT_SECRET = CLIENT_SECRET;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const token = await mintOAuth2ClientCredentialsToken();
  return { token, printed: errors.mock.calls.map(call => call.map(String).join(' ')).join('\n') };
};

describe('readOAuth2ErrorFields', () => {
  it('reads the two RFC 6749 fields', () => {
    expect(readOAuth2ErrorFields({ error: 'access_denied', error_description: 'Unauthorized' })).toEqual({
      error: 'access_denied',
      description: 'Unauthorized'
    });
  });

  it('keeps an error that has no description', () => {
    expect(readOAuth2ErrorFields({ error: 'invalid_client' })).toEqual({ error: 'invalid_client' });
  });

  it('returns nothing for a body that is not an OAuth2 error', () => {
    expect(readOAuth2ErrorFields(undefined)).toBeUndefined();
    expect(readOAuth2ErrorFields('<html></html>')).toBeUndefined();
    expect(readOAuth2ErrorFields({ message: 'Unauthorized' })).toBeUndefined();
    expect(readOAuth2ErrorFields({ error: '' })).toBeUndefined();
    expect(readOAuth2ErrorFields({ error: { code: 1 } })).toBeUndefined();
  });

  it('ignores a description that is not text, and caps both fields', () => {
    expect(readOAuth2ErrorFields({ error: 'access_denied', error_description: 42 })).toEqual({ error: 'access_denied' });
    const long = readOAuth2ErrorFields({ error: 'e'.repeat(500), error_description: 'd'.repeat(500) });
    expect(long?.error).toHaveLength(200);
    expect(long?.description).toHaveLength(200);
  });
});

describe('describeMintRefusal', () => {
  it('names the status, the host and the reason, and says what to do about refused credentials', () => {
    const lines = describeMintRefusal(400, 'Bad Request', 'https://cert-api.example.org', {
      error: 'access_denied',
      description: 'Unauthorized'
    });
    expect(lines[0]).toBe(
      'OAuth2 token mint failed: HTTP 400 Bad Request from https://cert-api.example.org (access_denied: Unauthorized).'
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('Download a fresh Certification Environment File');
    expect(lines[2]).toContain('set in your shell take precedence over the .env file');
  });

  it('treats invalid_client and unauthorized_client as refused credentials too', () => {
    expect(describeMintRefusal(401, '', 'https://h', { error: 'invalid_client' })).toHaveLength(3);
    expect(describeMintRefusal(400, '', 'https://h', { error: 'unauthorized_client' })).toHaveLength(3);
  });

  it('gives a server fault no advice about credentials', () => {
    expect(
      describeMintRefusal(500, 'Internal Server Error', 'https://h', { error: 'server_error', description: 'Unable to issue a token' })
    ).toEqual(['OAuth2 token mint failed: HTTP 500 Internal Server Error from https://h (server_error: Unable to issue a token).']);
  });

  it('prints the status alone when the body gave no reason', () => {
    expect(describeMintRefusal(502, 'Bad Gateway', 'https://h', undefined)).toEqual([
      'OAuth2 token mint failed: HTTP 502 Bad Gateway from https://h.'
    ]);
    expect(describeMintRefusal(502, '', 'https://h', undefined)).toEqual(['OAuth2 token mint failed: HTTP 502 from https://h.']);
  });
});

describe('mintOAuth2ClientCredentialsToken', () => {
  it('returns the minted token', async () => {
    const { token, printed } = await mintAs('good');
    expect(token).toBe('minted-token-value-0001');
    expect(printed).toBe('');
  });

  it("prints the server's reason and the host when the credentials are refused", async () => {
    const { token, printed } = await mintAs('refused');
    expect(token).toBeUndefined();
    expect(printed).toContain(`OAuth2 token mint failed: HTTP 400 Bad Request from ${origin} (access_denied: Unauthorized).`);
    expect(printed).toContain('Download a fresh Certification Environment File');
    expect(printed).not.toContain(CLIENT_SECRET);
  });

  it('says a server fault is one, without credential advice', async () => {
    const { token, printed } = await mintAs('server-fault');
    expect(token).toBeUndefined();
    expect(printed).toContain('(server_error: Unable to issue a token)');
    expect(printed).not.toContain('Certification Environment File');
  });

  it('never prints a body that is not an OAuth2 error', async () => {
    const { token, printed } = await mintAs('html');
    expect(token).toBeUndefined();
    expect(printed).toBe(`OAuth2 token mint failed: HTTP 502 Bad Gateway from ${origin}.`);
  });

  it('masks the client secret if the server echoes it back', async () => {
    const { printed } = await mintAs('echoes-secret');
    expect(printed).toContain('invalid_request: bad secret ****');
    expect(printed).not.toContain(CLIENT_SECRET);
  });

  it('does nothing when the credentials are not configured', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await mintOAuth2ClientCredentialsToken()).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('the CLI messages for a service call without a usable token', () => {
  it('names the current credentials first, and points at the line that says why the mint failed', () => {
    const message = cliAuthRequiredMessage('Variations check');
    expect(message.indexOf('TOKEN_URI')).toBeLessThan(message.indexOf('CERT_AUTH_API_BASE_URL'));
    expect(message).toContain('If "OAuth2 token mint failed" is printed above, that line says why.');
  });

  it('names both credential sets when the service refuses the token', () => {
    const message = cliAuthRejectedMessage('Variations check');
    expect(message).toContain('TOKEN_URI, CLIENT_ID and CLIENT_SECRET');
    expect(message).toContain('CERT_AUTH_API_*');
  });
});
