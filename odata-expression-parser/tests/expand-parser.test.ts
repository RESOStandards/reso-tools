import { describe, it, expect } from 'vitest';
import { parseExpand, ExpandParseError } from '../src/index.js';

describe('parseExpand', () => {
  describe('single-level expansions', () => {
    it('parses a single navigation property', () => {
      const result = parseExpand('Media');
      expect(result).toEqual([{ property: 'Media', options: {} }]);
    });

    it('parses multiple comma-separated navigation properties', () => {
      const result = parseExpand('Media,Rooms,OpenHouse');
      expect(result).toEqual([
        { property: 'Media', options: {} },
        { property: 'Rooms', options: {} },
        { property: 'OpenHouse', options: {} },
      ]);
    });

    it('trims whitespace around property names', () => {
      const result = parseExpand('  Media , Rooms  ');
      expect(result).toEqual([
        { property: 'Media', options: {} },
        { property: 'Rooms', options: {} },
      ]);
    });

    it('returns empty array for empty string', () => {
      expect(parseExpand('')).toEqual([]);
      expect(parseExpand('   ')).toEqual([]);
    });
  });

  describe('inline query options', () => {
    it('parses $select option', () => {
      const result = parseExpand('Media($select=MediaURL,MediaKey)');
      expect(result).toEqual([
        { property: 'Media', options: { $select: 'MediaURL,MediaKey' } },
      ]);
    });

    it('parses $filter option', () => {
      const result = parseExpand("Media($filter=MediaType eq 'Photo')");
      expect(result).toEqual([
        { property: 'Media', options: { $filter: "MediaType eq 'Photo'" } },
      ]);
    });

    it('parses $orderby option', () => {
      const result = parseExpand('Media($orderby=Order asc)');
      expect(result).toEqual([
        { property: 'Media', options: { $orderby: 'Order asc' } },
      ]);
    });

    it('parses $top option', () => {
      const result = parseExpand('Media($top=5)');
      expect(result).toEqual([
        { property: 'Media', options: { $top: 5 } },
      ]);
    });

    it('parses $skip option', () => {
      const result = parseExpand('Media($skip=10)');
      expect(result).toEqual([
        { property: 'Media', options: { $skip: 10 } },
      ]);
    });

    it('parses $count option', () => {
      const result = parseExpand('Media($count=true)');
      expect(result).toEqual([
        { property: 'Media', options: { $count: true } },
      ]);
    });

    it('parses multiple semicolon-separated options', () => {
      const result = parseExpand('Media($select=MediaURL;$top=5;$orderby=Order)');
      expect(result).toEqual([
        { property: 'Media', options: { $select: 'MediaURL', $top: 5, $orderby: 'Order' } },
      ]);
    });

    it('parses mixed properties with and without options', () => {
      const result = parseExpand('Media($select=MediaURL),Rooms,OpenHouse($top=3)');
      expect(result).toEqual([
        { property: 'Media', options: { $select: 'MediaURL' } },
        { property: 'Rooms', options: {} },
        { property: 'OpenHouse', options: { $top: 3 } },
      ]);
    });
  });

  describe('$levels support', () => {
    it('parses $levels with a number', () => {
      const result = parseExpand('Rooms($levels=2)');
      expect(result).toEqual([
        { property: 'Rooms', options: { $levels: 2 } },
      ]);
    });

    it('parses $levels=max', () => {
      const result = parseExpand('Rooms($levels=max)');
      expect(result).toEqual([
        { property: 'Rooms', options: { $levels: 'max' } },
      ]);
    });

    it('rejects invalid $levels value', () => {
      expect(() => parseExpand('Rooms($levels=0)')).toThrow(ExpandParseError);
      expect(() => parseExpand('Rooms($levels=-1)')).toThrow(ExpandParseError);
      expect(() => parseExpand('Rooms($levels=abc)')).toThrow(ExpandParseError);
    });
  });

  describe('nested (multi-level) expansions', () => {
    it('parses one level of nesting', () => {
      const result = parseExpand('Rooms($expand=Media)');
      expect(result).toEqual([
        {
          property: 'Rooms',
          options: {
            $expand: [{ property: 'Media', options: {} }],
          },
        },
      ]);
    });

    it('parses nested $expand with inline options', () => {
      const result = parseExpand('Rooms($expand=Media($select=MediaURL;$top=3))');
      expect(result).toEqual([
        {
          property: 'Rooms',
          options: {
            $expand: [
              { property: 'Media', options: { $select: 'MediaURL', $top: 3 } },
            ],
          },
        },
      ]);
    });

    it('parses two levels of nesting', () => {
      const result = parseExpand('Property($expand=Rooms($expand=Media))');
      expect(result).toEqual([
        {
          property: 'Property',
          options: {
            $expand: [
              {
                property: 'Rooms',
                options: {
                  $expand: [{ property: 'Media', options: {} }],
                },
              },
            ],
          },
        },
      ]);
    });

    it('parses nested $expand alongside other options', () => {
      const result = parseExpand('Rooms($select=RoomType;$expand=Media($top=1);$top=10)');
      expect(result).toEqual([
        {
          property: 'Rooms',
          options: {
            $select: 'RoomType',
            $expand: [{ property: 'Media', options: { $top: 1 } }],
            $top: 10,
          },
        },
      ]);
    });

    it('parses multiple nested expansions at the same level', () => {
      const result = parseExpand('Rooms($expand=Media,Listing)');
      expect(result).toEqual([
        {
          property: 'Rooms',
          options: {
            $expand: [
              { property: 'Media', options: {} },
              { property: 'Listing', options: {} },
            ],
          },
        },
      ]);
    });

    it('parses complex multi-level expression', () => {
      const result = parseExpand(
        'Media($select=MediaURL),Rooms($select=RoomType;$expand=Media($top=1),Tags)'
      );
      expect(result).toEqual([
        { property: 'Media', options: { $select: 'MediaURL' } },
        {
          property: 'Rooms',
          options: {
            $select: 'RoomType',
            $expand: [
              { property: 'Media', options: { $top: 1 } },
              { property: 'Tags', options: {} },
            ],
          },
        },
      ]);
    });
  });

  describe('error handling', () => {
    it('throws on empty navigation property name', () => {
      expect(() => parseExpand('($select=foo)')).toThrow(ExpandParseError);
    });

    it('throws on unmatched parenthesis', () => {
      expect(() => parseExpand('Media($select=foo')).toThrow(ExpandParseError);
    });

    it('throws on missing = in option', () => {
      expect(() => parseExpand('Media($select)')).toThrow(ExpandParseError);
    });

    it('throws on unknown option', () => {
      expect(() => parseExpand('Media($unknown=foo)')).toThrow(ExpandParseError);
    });

    it('throws on invalid $top value', () => {
      expect(() => parseExpand('Media($top=abc)')).toThrow(ExpandParseError);
      expect(() => parseExpand('Media($top=-1)')).toThrow(ExpandParseError);
    });

    it('throws on invalid $skip value', () => {
      expect(() => parseExpand('Media($skip=abc)')).toThrow(ExpandParseError);
    });

    it('provides position in error', () => {
      try {
        parseExpand('Media($unknown=foo)');
        expect.fail('Expected ExpandParseError');
      } catch (err) {
        expect(err).toBeInstanceOf(ExpandParseError);
        expect((err as InstanceType<typeof ExpandParseError>).position).toBeTypeOf('number');
      }
    });
  });
});
