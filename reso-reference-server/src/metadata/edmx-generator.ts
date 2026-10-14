/**
 * EDMX generation now lives in the shared, universal @reso-standards/reso-common package
 * so the reference server, the certification tooling and the browser clients all use one
 * generator (no drift). Re-exported here to preserve the server's existing import surface.
 */
export { generateEdmx } from '@reso-standards/reso-common';
