import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getMetadata } = require(resolve(import.meta.dirname, '../../src/etl/common.cjs'));
const { createReplicationStateServiceInstance } = require(resolve(import.meta.dirname, '../../src/legacy/common.js'));
const { scorePayload } = require(resolve(import.meta.dirname, '../../src/legacy/lib/replication/utils.js'));

describe('Replication related tests', () => {
  it('Should not throw error is non-string non-array value is present', async () => {
    const metadataReport = getMetadata('2.0');
    const payload = {
      '@reso.context': 'urn:reso:metadata:1.7:resource:property',
      value: [
        {
          Country: 'CA', // expected case non-array string lookup value
          StateOrProvince: 'ON',
          BusinessType: 5 // non-array non-string lookup value
        }
      ]
    };

    const replicationInstance = createReplicationStateServiceInstance();
    replicationInstance.setMetadataMap(metadataReport);

    expect(() => {
      scorePayload({
        expansionInfo: [],
        jsonData: payload,
        replicationStateServiceInstance: replicationInstance,
        resourceName: 'Property'
      });
    }).not.toThrow();
  });
});
