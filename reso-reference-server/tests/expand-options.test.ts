import { describe, expect, it } from 'vitest';
import type { NavigationPropertyBinding } from '../src/db/data-access.js';
import { applyExpandOptions, applyMongoExpandOptions, isExpandOptionError, unsupportedExpandOptions } from '../src/db/expand-options.js';
import type { ExpandBinding } from '../src/db/expand-options.js';

// ---------------------------------------------------------------------------
// Test helpers — minimal binding/expression factories
// ---------------------------------------------------------------------------

const makeBinding = (name: string, targetKeyField: string, overrides?: Partial<NavigationPropertyBinding>): NavigationPropertyBinding => ({
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

describe('applyExpandOptions', () => {
  describe('no-op cases', () => {
    it('returns entities unchanged when no bindings have $select', () => {
      const entities = [{ ListingKey: 'L1', Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }] }];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey')];
      const result = applyExpandOptions(entities, bindings);
      expect(result).toEqual(entities);
    });

    it('returns entities unchanged when expand bindings are empty', () => {
      const entities = [{ ListingKey: 'L1', ListPrice: 500000 }];
      const result = applyExpandOptions(entities, []);
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
      const result = applyExpandOptions(entities, bindings);
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
      const result = applyExpandOptions(entities, bindings);

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
      const result = applyExpandOptions(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]);
    });

    it('always includes the target key field even if not in $select', () => {
      const entities = [
        {
          ListingKey: 'L1',
          Rooms: [{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]
        }
      ];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'Area' })];
      const result = applyExpandOptions(entities, bindings);

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
      const bindings = [makeExpandBinding('BuyerAgent', 'MemberKey', { $select: 'MemberFirstName' }, { isCollection: false })];
      const result = applyExpandOptions(entities, bindings);

      expect(result[0].BuyerAgent).toEqual({ MemberKey: 'M1', MemberFirstName: 'Jane' });
    });

    it('leaves null to-one nav properties as null', () => {
      const entities = [{ ListingKey: 'L1', BuyerAgent: null }];
      const bindings = [makeExpandBinding('BuyerAgent', 'MemberKey', { $select: 'MemberFirstName' }, { isCollection: false })];
      const result = applyExpandOptions(entities, bindings);
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
      const result = applyExpandOptions(entities, bindings);

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
      const result = applyExpandOptions(entities, bindings);
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
      const result = applyExpandOptions(entities, bindings);
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
      const result = applyExpandOptions(entities, bindings);

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
        makeExpandBinding('Media', 'MediaKey') // no $select
      ];
      const result = applyExpandOptions(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', RoomType: 'Bedroom' }]);
      // Media untouched — all fields present
      expect(result[0].Media).toEqual([{ MediaKey: 'M1', MediaURL: 'http://example.com/1.jpg', MediaType: 'Photo' }]);
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
      const result = applyExpandOptions(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', Area: 200 }]);
      expect(result[1].Rooms).toEqual([{ RoomKey: 'R2', Area: 150 }]);
    });
  });

  describe('edge cases', () => {
    it('handles empty nav collections', () => {
      const entities = [{ ListingKey: 'L1', Rooms: [] }];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType' })];
      const result = applyExpandOptions(entities, bindings);
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
      const result = applyExpandOptions(entities, bindings);

      expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', RoomType: 'Bedroom', Area: 200 }]);
    });

    it('handles nav property missing from entity (undefined)', () => {
      const entities = [{ ListingKey: 'L1' }];
      const bindings = [makeExpandBinding('Rooms', 'RoomKey', { $select: 'RoomType' })];
      const result = applyExpandOptions(entities, bindings);
      // Rooms is undefined — should not crash, entity returned as-is
      expect(result[0]).toEqual({ ListingKey: 'L1' });
    });
  });
});

describe('applyMongoExpandOptions', () => {
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
    const result = applyMongoExpandOptions(entities, bindings as Parameters<typeof applyMongoExpandOptions>[1]);

    expect(result[0].Rooms).toEqual([{ RoomKey: 'R1', RoomType: 'Bedroom' }]);
  });
});

// ---------------------------------------------------------------------------
// $orderby, $skip, $top and $count inside $expand (reso-tools #440)
// ---------------------------------------------------------------------------

describe('applyExpandOptions – ordering, paging and counting (#440)', () => {
  const field = (fieldName: string, type: string) => ({ resourceName: 'Media', fieldName, type, nullable: true }) as never;
  const mediaFields = [
    field('MediaKey', 'Edm.String'),
    field('Order', 'Edm.Int32'),
    field('Caption', 'Edm.String'),
    field('PreferredYN', 'Edm.Boolean')
  ];
  const media = (options: Record<string, unknown>) => makeExpandBinding('Media', 'MediaKey', options, { targetFields: mediaFields });
  // Order arrives as a database might send it: a string for one row, a number for others, and a null.
  const parent = () => [
    {
      ListingKey: 'L1',
      Media: [
        { MediaKey: 'M3', Order: '10', Caption: 'c', PreferredYN: 0 },
        { MediaKey: 'M1', Order: 9, Caption: 'a', PreferredYN: 1 },
        { MediaKey: 'M2', Order: null, Caption: 'b', PreferredYN: 0 },
        { MediaKey: 'M4', Order: 9, Caption: 'd', PreferredYN: 0 }
      ]
    }
  ];
  const keys = (result: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> =>
    (result[0].Media as ReadonlyArray<Record<string, unknown>>).map(m => m.MediaKey as string);

  it('orders ascending with nulls first, numbers as numbers, and the key breaking ties', () => {
    expect(keys(applyExpandOptions(parent(), [media({ $orderby: 'Order' })]))).toEqual(['M2', 'M1', 'M4', 'M3']);
  });

  it('orders descending with nulls last (OData 4.01 Protocol, $orderby), the direction in any case', () => {
    expect(keys(applyExpandOptions(parent(), [media({ $orderby: 'Order DESC' })]))).toEqual(['M3', 'M1', 'M4', 'M2']);
  });

  it('orders by several terms', () => {
    expect(keys(applyExpandOptions(parent(), [media({ $orderby: 'PreferredYN desc, Caption desc' })]))).toEqual(['M1', 'M4', 'M3', 'M2']);
  });

  it('pages with $skip and $top after ordering, by key when no $orderby is given', () => {
    expect(keys(applyExpandOptions(parent(), [media({ $orderby: 'Order', $skip: 1, $top: 2 })]))).toEqual(['M1', 'M4']);
    expect(keys(applyExpandOptions(parent(), [media({ $top: 2 })]))).toEqual(['M1', 'M2']);
    expect(keys(applyExpandOptions(parent(), [media({ $skip: 3 })]))).toEqual(['M4']);
    expect(keys(applyExpandOptions(parent(), [media({ $top: 0 })]))).toEqual([]);
  });

  it('counts the collection before paging, as <NavigationProperty>@odata.count placed just before it', () => {
    const [result] = applyExpandOptions(parent(), [media({ $count: true, $top: 1 })]);
    expect(result['Media@odata.count']).toBe(4);
    expect((result.Media as unknown[]).length).toBe(1);
    const order = Object.keys(result);
    expect(order.indexOf('Media@odata.count')).toBe(order.indexOf('Media') - 1);
  });

  it('applies $select after ordering, so a collection can be ordered by a field it does not select', () => {
    const [result] = applyExpandOptions(parent(), [media({ $orderby: 'Caption desc', $select: 'Order', $top: 2 })]);
    expect(result.Media).toEqual([
      { MediaKey: 'M4', Order: 9 },
      { MediaKey: 'M3', Order: '10' }
    ]);
  });

  it('applies only $select to a single-valued expansion', () => {
    const agent = makeExpandBinding('BuyerAgent', 'MemberKey', { $select: 'MemberFirstName', $top: 1 }, { isCollection: false });
    const [result] = applyExpandOptions(
      [{ ListingKey: 'L1', BuyerAgent: { MemberKey: 'A', MemberFirstName: 'Pat', MemberLastName: 'Lee' } }],
      [agent]
    );
    expect(result.BuyerAgent).toEqual({ MemberKey: 'A', MemberFirstName: 'Pat' });
  });

  it('refuses a malformed $orderby term or an unknown field as a client error', () => {
    expect(() => applyExpandOptions(parent(), [media({ $orderby: 'Nope' })])).toThrow(
      /Unknown field in \$orderby inside \$expand=Media: "Nope"/
    );
    expect(() => applyExpandOptions(parent(), [media({ $orderby: 'Order sideways' })])).toThrow(/Invalid \$orderby term/);
    try {
      applyExpandOptions(parent(), [media({ $orderby: 'Nope' })]);
    } catch (err) {
      expect(isExpandOptionError(err)).toBe(true);
    }
  });
});

describe('unsupportedExpandOptions (#440)', () => {
  it('names each $filter and $levels inside $expand with its path, at any depth', () => {
    expect(
      unsupportedExpandOptions([
        { property: 'Media', options: { $filter: "MediaType eq 'Jpeg'" } },
        { property: 'ListOffice', options: { $expand: [{ property: 'Members', options: { $levels: 2 } }] } },
        { property: 'Rooms', options: { $top: 2 } }
      ])
    ).toEqual(['$filter inside $expand=Media', '$levels inside $expand=ListOffice/Members']);
    expect(unsupportedExpandOptions(undefined)).toEqual([]);
  });
});
