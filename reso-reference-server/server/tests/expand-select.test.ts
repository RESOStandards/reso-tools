import { describe, it, expect } from 'vitest';
import { applyExpandSelect, applyMongoExpandSelect } from '../src/db/expand-select.js';
import type { ExpandBinding } from '../src/db/expand-select.js';
import type { NavigationPropertyBinding } from '../src/db/data-access.js';

// ---------------------------------------------------------------------------
// Test helpers — minimal binding/expression factories
// ---------------------------------------------------------------------------

const makeBinding = (
  name: string,
  targetKeyField: string,
  overrides?: Partial<NavigationPropertyBinding>
): NavigationPropertyBinding => ({
  name,
  targetResource: name,
  targetKeyField,
  targetFields: [],
  foreignKey: { strategy: 'direct' as const, targetColumn: 'ParentKey' },
  isCollection: true,
  ...overrides
});

const makeExpandBinding = (
  navName: string,
  targetKeyField: string,
  options: Record<string, unknown> = {},
  bindingOverrides?: Partial<NavigationPropertyBinding>
): ExpandBinding => ({
  binding: makeBinding(navName, targetKeyField, bindingOverrides),
  expandExpr: { property: navName, options: options as ExpandBinding['expandExpr']['options'] }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyExpandSelect', () => {
  describe('no-op cases', () => {
    it('returns entities unchanged when no bindings have $select', () => {
      const entities = [
        { ListingKey: 'L1', Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }] }
      ];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey')];
      const result = applyExpandSelect(entities, bindings);
      expect(result).toEqual(entities);
    });

    it('returns entities unchanged when expand bindings are empty', () => {
      const entities = [{ ListingKey: 'L1', ListPrice: 500000 }];
      const result = applyExpandSelect(entities, []);
      expect(result).toEqual(entities);
    });

    it('does not modify parent-level fields', () => {
      const entities = [
        {
          ListingKey: 'L1',
          ListPrice: 500000,
          City: 'Austin',
          Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]
        }
      ];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType' })];
      const result = applyExpandSelect(entities, bindings);
      expect(result[0].ListingKey).toBe('L1');
      expect(result[0].ListPrice).toBe(500000);
      expect(result[0].City).toBe('Austin');
    });
  });

  describe('basic $select filtering on to-many nav collections', () => {
    it('filters collection nav entities to only selected fields + key', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [
            { RoomKey: 'R1', RoomType: 'Bedroom', Area: 200, Length: 15, Width: 12 },
            { RoomKey: 'R2', RoomType: 'Kitchen', Area: 150, Length: 10, Width: 15 }
          ]
        }
      ];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType' })];
      const result = applyExpandSelect(entities, bindings);

      expect(result[0].Rooms).toEqual([
        { RoomKey: 'R1', RoomType: 'Bedroom' },
        { RoomKey: 'R2', RoomType: 'Kitchen' }
      ]);
    });

    it('allows multiple fields in $select', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200, Length: 15 }]
        }
      ];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType,Area' })];
      const result = applyExpandSelect(entities, bindings);

      expect(result[0].Rooms).toEqual([
        { RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }
      ]);
    });

    it('always includes the target key field even if not in $select', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]
        }
      ];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'Area' })];
      const result = applyExpandSelect(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', Area: 200 }]);
    });
  });

  describe('$select filtering on to-one nav properties', () => {
    it('filters a to-one nav entity to only selected fields + key', () => {
      const entities = [
        {
          ListingKey: 'L1',
          BuyerAgent: { MemberKey: 'M1', MemberFirstName: 'Jane', MemberLastName: 'Doe', MemberEmail: 'j@d.com' }
        }
      ];
      const bindings = [
        makeExpandBinding('BuyerAgent', 'MemberKey', { $select: 'MemberFirstName' }, { isCollection: false })
      ];
      const result = applyExpandSelect(entities, bindings);

      expect(result[0].BuyerAgent).toEqual({ MemberKey: 'M1', MemberFirstName: 'Jane' });
    });

    it('leaves null to-one nav properties as null', () => {
      const entities = [{ ListingKey: 'L1', BuyerAgent: null }];
      const bindings = [
        makeExpandBinding('BuyerAgent', 'MemberKey', { $select: 'MemberFirstName' }, { isCollection: false })
      ];
      const result = applyExpandSelect(entities, bindings);
      expect(result[0].BuyerAgent).toBeNull();
    });
  });

  describe('$select with nested $expand — preserves nav property names', () => {
    it('preserves nested $expand property names in the allowed set', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [
            {
              RoomKey: 'R1',
              RoomType: 'Bedroom',
              Area: 200,
              ListingKey: 'L1',
              Listing: { ListingKey: 'L1', ListPrice: 500000 }
            }
          ]
        }
      ];
      const bindings = [
        makeExpandBinding('Rooms', 'RoomKey', {
          $select: 'RoomType',
          $expand: [{ property: 'Listing', options: { $select: 'ListPrice' } }]
        })
      ];
      const result = applyExpandSelect(entities, bindings);

      // RoomType (selected), RoomKey (key), Listing (nested expand) — Area and ListingKey stripped
      const rooms = result[0].Rooms as Record<string, unknown>[];
      expect(rooms[0]).toEqual({
        RoomKey: 'R1',
        RoomType: 'Bedroom',
        Listing: { ListingKey: 'L1', ListPrice: 500000 }
      });
    });

    it('strips FK columns not in $select when nested $expand is present', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [
            {
              RoomKey: 'R1',
              RoomType: 'Bedroom',
              ListingKey: 'FK-VALUE',
              Listing: { ListingKey: 'L1', ListPrice: 500000, City: 'Austin' }
            }
          ]
        }
      ];
      const bindings = [
        makeExpandBinding('Rooms', 'RoomKey', {
          $select: 'RoomType',
          $expand: [{ property: 'Listing', options: {} }]
        })
      ];
      const result = applyExpandSelect(entities, bindings);
      const rooms = result[0].Rooms as Record<string, unknown>[];

      // ListingKey FK column should be stripped (not in $select, not the key, not a nav prop name)
      expect(rooms[0]).not.toHaveProperty('ListingKey');
      // But Listing nav prop is preserved
      expect(rooms[0]).toHaveProperty('Listing');
    });

    it('preserves multiple nested $expand property names', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [
            {
              RoomKey: 'R1',
              RoomType: 'Bedroom',
              Media: [{ MediaKey: 'M1' }],
              Listing: { ListingKey: 'L1' }
            }
          ]
        }
      ];
      const bindings = [
        makeExpandBinding('Rooms', 'RoomKey', {
          $select: 'RoomType',
          $expand: [
            { property: 'Media', options: {} },
            { property: 'Listing', options: {} }
          ]
        })
      ];
      const result = applyExpandSelect(entities, bindings);
      const rooms = result[0].Rooms as Record<string, unknown>[];

      expect(Object.keys(rooms[0]).sort()).toEqual(['Listing', 'Media', 'RoomKey', 'RoomType']);
    });
  });

  describe('multiple expand bindings', () => {
    it('applies $select independently to each nav property', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }],
          Media: [{ MediaKey: 'M1', MediaURL: 'http://example.com/1.jpg', MediaType: 'Photo' }]
        }
      ];
      const bindings = [
        makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType' }),
        makeExpandBinding('Media', 'MediaKey', { $select: 'MediaURL' })
      ];
      const result = applyExpandSelect(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', RoomType: 'Bedroom' }]);
      expect(result[0].Media).toEqual([{ MediaKey: 'M1', MediaURL: 'http://example.com/1.jpg' }]);
    });

    it('only filters bindings that have $select, leaves others untouched', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }],
          Media: [{ MediaKey: 'M1', MediaURL: 'http://example.com/1.jpg', MediaType: 'Photo' }]
        }
      ];
      const bindings = [
        makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType' }),
        makeExpandBinding('Media', 'MediaKey')  // no $select
      ];
      const result = applyExpandSelect(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', RoomType: 'Bedroom' }]);
      // Media untouched — all fields present
      expect(result[0].Media).toEqual([
        { MediaKey: 'M1', MediaURL: 'http://example.com/1.jpg', MediaType: 'Photo' }
      ]);
    });
  });

  describe('multiple parent entities', () => {
    it('applies $select to all parent entities', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]
        },
        {
          ListingKey: 'L2',
          Rooms: [{ RoomKey: 'R2', RoomType: 'Kitchen', Area: 150 }]
        }
      ];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'Area' })];
      const result = applyExpandSelect(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', Area: 200 }]);
      expect(result[1].Rooms).toEqual([{ RoomKey: 'R2', Area: 150 }]);
    });
  });

  describe('edge cases', () => {
    it('handles empty nav collections', () => {
      const entities = [{ ListingKey: 'L1', Rooms: [] }];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType' })];
      const result = applyExpandSelect(entities, bindings);
      expect(result[0].Rooms).toEqual([]);
    });

    it('handles $select with whitespace around field names', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]
        }
      ];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: ' RoomType , Area ' })];
      const result = applyExpandSelect(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]);
    });

    it('handles nav property missing from entity (undefined)', () => {
      const entities = [{ ListingKey: 'L1' }];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType' })];
      const result = applyExpandSelect(entities, bindings);
      // Rooms is undefined — should not crash, entity returned as-is
      expect(result[0]).toEqual({ ListingKey: 'L1' });
    });
  });
});

describe('applyMongoExpandSelect', () => {
  it('works with MongoDB-style bindings using expr instead of expandExpr', () => {
    const entities = [
      {
        ListingKey: 'L1',
        Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]
      }
    ];
    const bindings = [
      {
        binding: makeBinding('Rooms', 'RoomKey'),
        expr: { property: 'Rooms', options: { $select: 'RoomType' } as Record<string, unknown> }
      }
    ];
    const result = applyMongoExpandSelect(
      entities,
      bindings as Parameters<typeof applyMongoExpandSelect>[1]
    );

    expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', RoomType: 'Bedroom' }]);
  });
});
