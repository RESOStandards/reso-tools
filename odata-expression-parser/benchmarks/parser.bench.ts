/**
 * Benchmarks for OData expression parsing.
 *
 * The filter parser is called for every $filter expression validation.
 * Performance matters when parsing complex filters during compliance testing.
 */

import { bench, describe } from 'vitest';
import { parseFilter } from '../src/parser.js';
import { parseExpand } from '../src/expand-parser.js';
import { astToFilterString } from '../src/serializer.js';

describe('parseFilter', () => {
  bench('simple comparison', () => {
    parseFilter('ListPrice gt 200000');
  });

  bench('two comparisons with and', () => {
    parseFilter("ListPrice gt 200000 and City eq 'Austin'");
  });

  bench('three comparisons with mixed operators', () => {
    parseFilter("ListPrice gt 200000 and City eq 'Austin' and BedroomsTotal ge 3");
  });

  bench('complex nested filter', () => {
    parseFilter("(ListPrice gt 200000 and ListPrice lt 500000) or (City eq 'Austin' and BedroomsTotal ge 4)");
  });

  bench('string function - contains', () => {
    parseFilter("contains(City,'Aus')");
  });

  bench('collection lambda - any', () => {
    parseFilter("Features/any(x:x eq 'Pool')");
  });

  bench('not operator', () => {
    parseFilter('not(ListPrice eq 0)');
  });

  bench('date comparison', () => {
    parseFilter('ListDate gt 2024-01-01');
  });

  bench('null comparison', () => {
    parseFilter('City ne null');
  });
});

describe('parseExpand', () => {
  bench('single expand', () => {
    parseExpand('Media');
  });

  bench('multiple expands', () => {
    parseExpand('Media,OpenHouse,PropertyRooms');
  });

  bench('nested expand with select', () => {
    parseExpand('Media($select=MediaURL,MediaType)');
  });
});

describe('astToFilterString (round-trip)', () => {
  bench('parse and serialize simple', () => {
    const ast = parseFilter('ListPrice gt 200000');
    astToFilterString(ast);
  });

  bench('parse and serialize complex', () => {
    const ast = parseFilter("ListPrice gt 200000 and City eq 'Austin' and BedroomsTotal ge 3");
    astToFilterString(ast);
  });
});
