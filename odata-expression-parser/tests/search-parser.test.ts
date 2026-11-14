/**
 * $search expressions as OData 4.01 defines them (URL Conventions 5.1.7, the ABNF searchExpr rule, Protocol $search).
 */
import { describe, expect, it } from 'vitest';
import { isSearchParseError, parseSearch } from '../src/index.js';

const word = (value: string) => ({ type: 'term', value, phrase: false });
const phrase = (value: string) => ({ type: 'term', value, phrase: true });

describe('parseSearch', () => {
  it('reads a word and a phrase with spaces', () => {
    expect(parseSearch('roadmap')).toEqual(word('roadmap'));
    expect(parseSearch('"business case"')).toEqual(phrase('business case'));
    expect(parseSearch('" "')).toEqual(phrase(' '));
  });

  it('reads a space as AND, and AND written out the same way', () => {
    const both = { type: 'and', left: word('mountain'), right: word('bike') };
    expect(parseSearch('mountain bike')).toEqual(both);
    expect(parseSearch('mountain AND bike')).toEqual(both);
  });

  it('evaluates grouping, then NOT, then AND, then OR (OData 4.01 Protocol, $search)', () => {
    expect(parseSearch('a OR b c')).toEqual({ type: 'or', left: word('a'), right: { type: 'and', left: word('b'), right: word('c') } });
    expect(parseSearch('NOT a b')).toEqual({ type: 'and', left: { type: 'not', operand: word('a') }, right: word('b') });
    expect(parseSearch('(mountain OR bike) AND NOT clothing')).toEqual({
      type: 'and',
      left: { type: 'or', left: word('mountain'), right: word('bike') },
      right: { type: 'not', operand: word('clothing') }
    });
  });

  it('treats the keywords as words where they cannot be operators, and in lowercase', () => {
    expect(parseSearch('OR')).toEqual(word('OR'));
    expect(parseSearch('cats AND')).toEqual({ type: 'and', left: word('cats'), right: word('AND') });
    expect(parseSearch('NOT')).toEqual(word('NOT'));
    expect(parseSearch('rock and roll')).toEqual({
      type: 'and',
      left: { type: 'and', left: word('rock'), right: word('and') },
      right: word('roll')
    });
  });

  it("keeps a word's inner single quote and other characters the grammar allows", () => {
    expect(parseSearch("O'Brien RCP-27 2.1.0")).toEqual({
      type: 'and',
      left: { type: 'and', left: word("O'Brien"), right: word('RCP-27') },
      right: word('2.1.0')
    });
  });

  it('reads the single-quoted incomplete form, for type-ahead, as one phrase', () => {
    expect(parseSearch("'busin'")).toEqual(phrase('busin'));
    expect(parseSearch("'O''Brien'")).toEqual(phrase("O'Brien"));
    expect(parseSearch("''")).toEqual(phrase(''));
  });

  it('refuses a malformed expression as a client error', () => {
    for (const bad of ['', '   ', '(a OR b', 'a)', '()', '"unterminated', '""', 'a;b', "'unterminated", "'", "'O'Brien'"]) {
      let caught: unknown;
      try {
        parseSearch(bad);
      } catch (err) {
        caught = err;
      }
      expect(isSearchParseError(caught), JSON.stringify(bad)).toBe(true);
    }
  });
});
