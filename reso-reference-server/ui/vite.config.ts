import type { IncomingMessage } from 'node:http';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = 'http://localhost:8080';

/** Resources that exist as both API endpoints and SPA routes. */
const RESOURCES = [
  'Property',
  'Member',
  'Office',
  'Media',
  'OpenHouse',
  'Showing',
  'PropertyRooms',
  'PropertyGreenVerification',
  'PropertyPowerProduction',
  'PropertyUnitTypes',
  'Teams',
  'TeamMembers',
  'OUID',
  'Lookup'
];

const resourcePattern = new RegExp(`^/(${RESOURCES.join('|')})(\\(|%28|\\?|$)`);

/**
 * Mirrors the nginx routing logic:
 * - OData key syntax like /Property('key') → always proxy
 * - Query params like /Property?$select=... → always proxy
 * - Bare /Property with Accept: application/json → proxy (fetch from SPA)
 * - Bare /Property from browser navigation → serve SPA (return false)
 */
const shouldProxyResource = (req: IncomingMessage): boolean => {
  const url = req.url ?? '';
  const match = resourcePattern.exec(url);
  if (!match) return false;

  const suffix = match[2];
  // OData key syntax → always proxy (never a browser navigation)
  if (suffix === '(' || suffix === '%28') return true;

  // Query params or bare resource path → proxy only for API requests (Accept: application/json).
  // Browser refreshes send Accept: text/html and should serve the SPA.
  const accept = req.headers.accept ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Non-resource API endpoints — always proxy
      '/ui-config': API_TARGET,
      '/api': API_TARGET,
      '/health': API_TARGET,
      '/images': API_TARGET,
      '/$metadata': API_TARGET,
      '/oauth': API_TARGET,
      '/admin': {
        target: API_TARGET,
        bypass: (req) => {
          if (req.method === 'POST') return undefined; // proxy
          if (req.url?.endsWith('/status')) return undefined; // proxy
          return '/index.html'; // SPA
        }
      },
      // Resource endpoints — smart routing based on Accept header / URL pattern
      ...Object.fromEntries(
        RESOURCES.map(r => [
          `/${r}`,
          {
            target: API_TARGET,
            bypass: (req: IncomingMessage) => shouldProxyResource(req) ? undefined : '/index.html'
          }
        ])
      )
    }
  }
});
