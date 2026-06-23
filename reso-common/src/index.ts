/**
 * @reso-standards/reso-common — universal RESO metadata model and projections.
 *
 * Browser- and Node-safe: zero runtime dependencies, no Node APIs. Holds the shared
 * `ResoMetadata` model plus pure projections (EDMX generation, etc.) so the reference
 * server, the certification tooling and the browser clients can all share one source
 * of truth instead of each carrying their own copy.
 */
export * from './metadata/model.js';
export * from './metadata/helpers.js';
export * from './metadata/edmx-generator.js';
export * from './metadata/metadata-map.js';
export * from './variations/matching-helpers.js';
