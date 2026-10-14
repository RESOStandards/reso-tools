/**
 * RESO metadata model — re-exported from the shared, universal @reso-standards/reso-common
 * package so the server's existing `./types.js` import surface stays unchanged. The
 * canonical definitions now live in reso-common (browser-safe, zero dependencies).
 */
export type { ResoAnnotation, ResoResource, ResoField, ResoLookup, ResoMetadata } from '@reso-standards/reso-common';
export { KEY_FIELD_MAP } from '@reso-standards/reso-common';

/** Resources targeted for the reference server. */
export const TARGET_RESOURCES: ReadonlyArray<string> = [
  'Property',
  'Member',
  'Office',
  'Media',
  'OpenHouse',
  'Showing',
  'PropertyGreenVerification',
  'PropertyPowerProduction',
  'PropertyRooms',
  'PropertyUnitTypes',
  'Teams',
  'TeamMembers',
  'OUID'
];
